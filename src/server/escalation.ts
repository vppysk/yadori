import { query, transaction } from "./db";
import { getAiAgentMemberId, getHotel } from "./hotel";
import { requestCheck } from "./order-checks";
import { assignUnassigned, dispatchScheduled } from "./orders";
import { notifySupervisors, reassign } from "./staff-work";

// 定期実行（1分ごと想定）: 割り当てはできるだけ自動で行い、期限を過ぎたら担当者に状況を確認する（docs/005_order.md 5・6章）
export async function runTicketChecks(hotelId: string) {
  const hotel = await getHotel(hotelId);
  const aiMemberId = await getAiAgentMemberId(hotelId);
  // お届けの時間指定があるオーダーを、前倒しの時刻に割り当てる
  const dispatched = await dispatchScheduled(hotel, aiMemberId);
  // 担当者なしのチケットを、出勤している担当者に割り当てる
  const picked = await assignUnassigned(hotel, aiMemberId);

  // 割り当てから着手されないまま過ぎたら同じ担当の次の人へ（分数は品目設定の「割り当ての設定」で変更）。
  // 上長が手動で割り当てたもの、状況の確認に返事待ちのものは除く
  const reassignAfter = hotel.order_reassign_minutes;
  const stale = await query<{ id: string }>(
    `select id from tickets where hotel_id = $1 and status = 'new' and assignee_id is not null and assignment_mode = 'auto'
       and assigned_at < now() - make_interval(mins => $2)
       and not (check_requested_at is not null and check_replied_at is null)`,
    [hotelId, reassignAfter],
  );
  for (const { id } of stale) {
    await transaction((client) => reassign(client, hotel, id, `${reassignAfter}分間着手されなかった`, { stale: true }));
  }

  // 期限を過ぎた: 担当者に状況を確認し、上長に知らせる（1回だけ）。自動では割り当て直さない（向かっている途中の人とぶつからないように）。
  // 返事がなければ上長の判断を待つ。ゲストの不満・催促はクレームとして引き継ぐ（order-checks.ts）
  const overdue = await query<{ id: string; room_number: string; items: string; minutes: number; assignee: string | null; status: string }>(
    `select t.id, t.room_number, t.status,
       (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items,
       floor(extract(epoch from (now() - t.due_at)) / 60)::int minutes, m.display_name assignee
     from tickets t left join members m on m.id = t.assignee_id
     where t.hotel_id = $1 and t.status in ('new', 'doing') and t.due_at < now() and t.escalated_at is null`,
    [hotelId],
  );
  for (const ticket of overdue) {
    await transaction(async (client) => {
      const { rowCount } = await client.query("update tickets set escalated_at = now() where id = $1 and escalated_at is null", [ticket.id]);
      if (!rowCount) return;
      const check = await requestCheck(client, ticket.id, "overdue", { actorId: aiMemberId });
      const facts = `${ticket.items} が期限を${ticket.minutes}分超過（${ticket.status === "doing" ? "対応中" : "未着手"}）。担当：${ticket.assignee ?? "なし"}`;
      const next = check === "no_assignee" ? "担当者がいません。手動で割り当ててください" : "担当者に状況を確認しています";
      await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'escalated', $2)", [ticket.id, facts]);
      await notifySupervisors(client, hotelId, `${ticket.room_number}号室 オーダー遅延`, `${facts}。${next}`, ticket.id);
    });
  }
  return { dispatched, picked, reassigned: stale.length, escalated: overdue.length };
}
