import type { PoolClient } from "pg";
import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { getAiAgentMemberId, getHotel, localNow, type Hotel } from "./hotel";
import { recordWorkEvent } from "./metrics";
import { pickAssignee, roomFloor } from "./orders";

// ---------- 出勤（その日の枠と担当者。plan 4.2） ----------

export type SlotOption = { id: string; label: string; on_shift: boolean };

// 担当になれる枠（範囲付きの権限も考慮）と、今日その枠に出勤しているか
export async function listMySlots(member: Member): Promise<SlotOption[]> {
  const hotel = await getHotel(member.hotel_id);
  return query<SlotOption>(
    `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label,
       exists (select 1 from slot_shifts ss where ss.slot_id = s.id and ss.member_id = $2 and ss.work_date = $3 and ss.ended_at is null) on_shift
     from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
     where s.hotel_id = $1 and has_permission($2, 'order.assignable', s.id)
     order by r.name, a.floor_from`,
    [member.hotel_id, member.id, localNow(hotel.timezone).date],
  );
}

export async function startShift(member: Member, slotId: string) {
  const hotel = await getHotel(member.hotel_id);
  await query(
    `insert into slot_shifts (slot_id, member_id, work_date) values ($1, $2, $3)
     on conflict (slot_id, member_id, work_date) do update set ended_at = null`,
    [slotId, member.id, localNow(hotel.timezone).date],
  );
}

export async function endShift(member: Member) {
  const hotel = await getHotel(member.hotel_id);
  await query("update slot_shifts set ended_at = now() where member_id = $1 and work_date = $2 and ended_at is null", [
    member.id,
    localNow(hotel.timezone).date,
  ]);
}

// ---------- 自分のチケット ----------

export type MyTicket = {
  id: string;
  room_number: string;
  status: "new" | "doing";
  weight: number;
  items: string;
  assigned_at: string;
  started_at: string | null;
  due_at: string;
  overdue: boolean;
  assign_reason: string | null;
};

export async function listMyTickets(memberId: string): Promise<MyTicket[]> {
  return query<MyTicket>(
    `select t.id, t.room_number, t.status, t.weight,
       string_agg(l.item_name || coalesce('（' || l.note || '）', '') || ' × ' || l.quantity, ' ・ ' order by l.id) items,
       t.assigned_at, t.started_at, t.due_at, t.due_at < now() overdue,
       (select e.reason from ticket_events e where e.ticket_id = t.id and e.member_id = $1 and e.type in ('assigned', 'reassigned')
        order by e.created_at desc limit 1) assign_reason
     from tickets t join ticket_lines l on l.ticket_id = t.id
     where t.assignee_id = $1 and t.status in ('new', 'doing')
     group by t.id order by t.due_at`,
    [memberId],
  );
}

export type LoadSummary = { slotLabel: string; myPoints: number; averagePoints: number; members: number };

// 本日の担当量（累計pt＋未完了pt）と、同じ枠の平均。偏りがないことを本人も確認できるようにする
export async function loadSummary(member: Member): Promise<LoadSummary | undefined> {
  const hotel = await getHotel(member.hotel_id);
  return queryOne<LoadSummary>(
    `with mine as (
       select l.slot_id from member_daily_load l where l.member_id = $1 and l.work_date = $2 limit 1
     )
     select r.name || coalesce(' ' || a.name, '') "slotLabel",
       coalesce(max(l.done_points + l.open_points) filter (where l.member_id = $1), 0)::int "myPoints",
       round(avg(l.done_points + l.open_points))::int "averagePoints",
       count(*)::int members
     from mine join member_daily_load l on l.slot_id = mine.slot_id and l.work_date = $2
     join slots s on s.id = mine.slot_id join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
     group by r.name, a.name`,
    [member.id, localNow(hotel.timezone).date],
  );
}

// ---------- 向かう／届けた／対応できない ----------

async function lockOwnTicket(client: PoolClient, member: Member, ticketId: string) {
  const { rows } = await client.query<{ id: string; status: string; conversation_id: string | null; slot_id: string | null; room_number: string; started_at: Date | null; hotel_id: string }>(
    "select id, status, conversation_id, slot_id, room_number, started_at, hotel_id from tickets where id = $1 and assignee_id = $2 for update",
    [ticketId, member.id],
  );
  if (!rows[0]) throw new Error("このオーダーはあなたの担当ではありません");
  return rows[0];
}

export async function startTicket(member: Member, ticketId: string) {
  await transaction(async (client) => {
    const ticket = await lockOwnTicket(client, member, ticketId);
    if (ticket.status !== "new") return;
    await client.query("update tickets set status = 'doing', started_at = now() where id = $1", [ticketId]);
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id) values ($1, 'started', $2, $2)", [ticketId, member.id]);
  });
}

export async function completeTicket(member: Member, ticketId: string) {
  const done = await transaction(async (client) => {
    const ticket = await lockOwnTicket(client, member, ticketId);
    if (ticket.status !== "doing" && ticket.status !== "new") return undefined;
    const { rows } = await client.query<{ items: string; on_time: boolean; handling_ms: number }>(
      `update tickets set status = 'done', done_at = now(), started_at = coalesce(started_at, now()) where id = $1
       returning (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = $1) items,
         now() <= due_at on_time, (extract(epoch from (now() - coalesce(started_at, now()))) * 1000)::int handling_ms`,
      [ticketId],
    );
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id) values ($1, 'done', $2, $2)", [ticketId, member.id]);
    // ゲストに進捗を自動通知（追いの問い合わせを減らす）
    if (ticket.conversation_id) {
      await client.query("insert into messages (conversation_id, role, content) values ($1, 'assistant', $2)", [
        ticket.conversation_id,
        `${rows[0].items}をお届けしました。ほかにご用があればお気軽にどうぞ。`,
      ]);
      await client.query("insert into ticket_events (ticket_id, type, actor_id) values ($1, 'guest_notified', $2)", [ticketId, member.id]);
    }
    return { ...rows[0], conversationId: ticket.conversation_id };
  });
  if (!done) return;
  // 人の対応の実績（配達）。人件費は時給マスタ（未入力なら0）と対応時間から計算する
  const wage = await queryOne<{ hourly_wage_jpy: number }>(
    "select hourly_wage_jpy from wage_rates where hotel_id = $1 and job_title = $2",
    [member.hotel_id, member.job_title ?? ""],
  );
  await recordWorkEvent({
    hotelId: member.hotel_id, conversationId: done.conversationId ?? undefined, ticketId, pattern: "order", handlerKind: "human",
    handler: member.job_title ?? "スタッフ", durationMs: done.handling_ms,
    costJpy: wage ? (wage.hourly_wage_jpy * done.handling_ms) / 3_600_000 : 0,
    outcome: "resolved", signals: { on_time: done.on_time, phase: "delivery" },
  });
}

// 対応できない: 理由を記録し、枠内の次の人へ再割り当て（辞退した人は除く）
export async function declineTicket(member: Member, ticketId: string, reason: string) {
  await transaction(async (client) => {
    const ticket = await lockOwnTicket(client, member, ticketId);
    if (ticket.status !== "new") throw new Error("着手済みのオーダーは返せません");
    const settings = await getHotel(ticket.hotel_id);
    if (settings.order_decline_reason_required && !reason.trim()) throw new Error("理由を選んでください");
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'declined', $2, $2, $3)", [
      ticketId, member.id, reason,
    ]);
    const hotel = await getHotel(ticket.hotel_id);
    await reassign(client, hotel, ticketId, `${member.display_name}が「対応できない」（${reason}）`);
  });
}

// 枠内の次の人へ付け替える。辞退・放置した人は除く。誰もいなければ未割り当てにして上長へ通知
export async function reassign(client: PoolClient, hotel: Hotel, ticketId: string, why: string) {
  const { rows } = await client.query<{ slot_id: string | null; room_number: string; assignee_id: string | null }>(
    "select slot_id, room_number, assignee_id from tickets where id = $1",
    [ticketId],
  );
  const ticket = rows[0];
  const { rows: excluded } = await client.query<{ member_id: string }>(
    "select distinct member_id from ticket_events where ticket_id = $1 and type = 'declined' and member_id is not null",
    [ticketId],
  );
  const excludeIds = [...excluded.map((e) => e.member_id), ...(ticket.assignee_id ? [ticket.assignee_id] : [])];
  const floor = await roomFloor(client, hotel.id, ticket.room_number);
  if (ticket.slot_id) await client.query("select pg_advisory_xact_lock(hashtext($1))", [ticket.slot_id]);
  const next = ticket.slot_id ? await pickAssignee(client, hotel, ticket.slot_id, floor, excludeIds) : undefined;
  const aiMemberId = await getAiAgentMemberId(hotel.id);

  await client.query("update tickets set assignee_id = $2, assigned_at = case when $2::uuid is null then null else now() end where id = $1", [
    ticketId, next?.id ?? null,
  ]);
  await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'reassigned', $2, $3, $4)", [
    ticketId, next?.id ?? null, aiMemberId ?? null, next ? `${why} → ${next.reason}` : `${why} → 枠内に担当できる人がいない`,
  ]);
  if (next) {
    await client.query(
      "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
      [next.id, `${ticket.room_number}号室のオーダー（付け替え）`, why, ticketId],
    );
  }
  await notifySupervisors(client, hotel.id, `${ticket.room_number}号室のオーダーを付け替え`, next ? `${why}。新しい担当: ${next.name}` : `${why}。担当者がいません`, ticketId);
}

export async function notifySupervisors(client: PoolClient, hotelId: string, title: string, body: string, ticketId: string) {
  await client.query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'ticket_supervisor', $2, $3, 'ticket', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'order.reassign')`,
    [hotelId, title, body, ticketId],
  );
}

// ---------- 引き継ぎ ----------

export type OpenHandoff = {
  id: string;
  kind: string;
  room_number: string | null;
  summary: string;
  status: "open" | "accepted";
  accepted_by_name: string | null;
  created_at: string;
};

export async function listOpenHandoffs(hotelId: string): Promise<OpenHandoff[]> {
  return query<OpenHandoff>(
    `select h.id, h.kind, h.room_number, h.summary, h.status, m.display_name accepted_by_name, h.created_at
     from handoffs h left join members m on m.id = h.accepted_by
     where h.hotel_id = $1 and h.status in ('open', 'accepted')
     order by h.status, h.created_at desc`,
    [hotelId],
  );
}

export async function acceptHandoff(member: Member, handoffId: string) {
  await query(
    "update handoffs set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1 and hotel_id = $3 and status = 'open'",
    [handoffId, member.id, member.hotel_id],
  );
}

export async function closeHandoff(member: Member, handoffId: string) {
  await query("update handoffs set status = 'closed', closed_at = now() where id = $1 and hotel_id = $2 and status <> 'closed'", [
    handoffId, member.hotel_id,
  ]);
}

// スタッフからゲストへの返信。ゲストの画面に「スタッフ」として表示される
export async function replyToGuest(member: Member, handoffId: string, text: string) {
  const handoff = await queryOne<{ conversation_id: string | null }>("select conversation_id from handoffs where id = $1 and hotel_id = $2", [
    handoffId, member.hotel_id,
  ]);
  if (!handoff?.conversation_id) throw new Error("この引き継ぎには会話がありません");
  await query("insert into messages (conversation_id, role, content) values ($1, 'staff', $2)", [
    handoff.conversation_id, `${text}（スタッフ ${member.display_name}）`,
  ]);
}

// ---------- 通知 ----------

export type NotificationItem = { id: string; kind: string; title: string; body: string | null; read_at: string | null; created_at: string };

export async function listNotifications(memberId: string, limit = 50): Promise<NotificationItem[]> {
  return query<NotificationItem>(
    "select id, kind, title, body, read_at, created_at from notifications where member_id = $1 order by created_at desc limit $2",
    [memberId, limit],
  );
}

export async function unreadCount(memberId: string): Promise<number> {
  const row = await queryOne<{ count: number }>("select count(*)::int count from notifications where member_id = $1 and read_at is null", [memberId]);
  return row?.count ?? 0;
}

export async function markNotificationsRead(memberId: string) {
  await query("update notifications set read_at = now() where member_id = $1 and read_at is null", [memberId]);
}

// ---------- 引き継ぎ・クレーム履歴（管理PC） ----------

export type HandoffHistoryRow = {
  id: string;
  kind: string;
  status: string;
  room_number: string | null;
  summary: string;
  accepted_by_name: string | null;
  created_at: string;
  accepted_at: string | null;
  closed_at: string | null;
  write_status: string | null;
  messages: { role: string; content: string }[];
};

export async function listHandoffHistory(hotelId: string, filters: { kind?: string; status?: string }, limit = 100): Promise<HandoffHistoryRow[]> {
  return query<HandoffHistoryRow>(
    `select h.id, h.kind, h.status, h.room_number, h.summary, m.display_name accepted_by_name, h.created_at, h.accepted_at, h.closed_at,
       (select w.status from integration_writes w where w.handoff_id = h.id order by w.created_at desc limit 1) write_status,
       coalesce((
         select json_agg(json_build_object('role', x.role, 'content', x.content) order by x.created_at)
         from (select role, content, created_at from messages where conversation_id = h.conversation_id and role in ('user', 'assistant', 'staff')
               order by created_at desc limit 8) x
       ), '[]') messages
     from handoffs h left join members m on m.id = h.accepted_by
     where h.hotel_id = $1 and ($2::text is null or h.kind = $2) and ($3::text is null or h.status = $3)
     order by h.created_at desc limit $4`,
    [hotelId, filters.kind ?? null, filters.status ?? null, limit],
  );
}
