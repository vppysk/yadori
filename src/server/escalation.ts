import { generateStructured } from "@/lib/llm/structured";
import { z } from "zod";
import { query, transaction } from "./db";
import { createHandoff } from "./handoffs";
import { getHotel } from "./hotel";
import { recordLlmCall } from "./metrics";
import { notifySupervisors, reassign } from "./staff-work";

// 割り当てから着手されないまま過ぎたら枠内の次の人へ（plan 4.2「一定時間（設定可）」。設定画面ができるまでは定数）
export const REASSIGN_AFTER_MINUTES = Number(process.env.REASSIGN_AFTER_MINUTES ?? 10);

// 定期実行（1分ごと想定）: 放置チケットの付け替えと、期限切れのクレーム予兆への昇格（plan 3章 2→5 の自動昇格）
export async function runTicketChecks(hotelId: string) {
  const hotel = await getHotel(hotelId);
  const stale = await query<{ id: string }>(
    `select id from tickets where hotel_id = $1 and status = 'new' and assignee_id is not null
       and assigned_at < now() - make_interval(mins => $2)`,
    [hotelId, REASSIGN_AFTER_MINUTES],
  );
  for (const { id } of stale) {
    await transaction((client) => reassign(client, hotel, id, `${REASSIGN_AFTER_MINUTES}分間着手されなかった`));
  }

  const overdue = await query<{ id: string; room_number: string; conversation_id: string | null; items: string; minutes: number; assignee: string | null; status: string }>(
    `select t.id, t.room_number, t.conversation_id, t.status,
       (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items,
       floor(extract(epoch from (now() - t.due_at)) / 60)::int minutes, m.display_name assignee
     from tickets t left join members m on m.id = t.assignee_id
     where t.hotel_id = $1 and t.status in ('new', 'doing') and t.due_at < now() and t.escalated_at is null`,
    [hotelId],
  );
  for (const ticket of overdue) {
    const summary = await summarizeOverdue(hotelId, ticket);
    await transaction(async (client) => {
      const { rowCount } = await client.query("update tickets set escalated_at = now() where id = $1 and escalated_at is null", [ticket.id]);
      if (!rowCount) return;
      await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'escalated', $2)", [ticket.id, summary]);
      await notifySupervisors(client, hotelId, `${ticket.room_number}号室 オーダー遅延`, summary, ticket.id);
    });
    await createHandoff({ hotelId, kind: "overdue_order", conversationId: ticket.conversation_id ?? undefined, ticketId: ticket.id, roomNumber: ticket.room_number, summary });
  }
  return { reassigned: stale.length, escalated: overdue.length };
}

// 上長向けの要約。チケット発行後のゲストの発言（催促や口調）をLLMで読み取り、事実と合わせて1〜2文にする
async function summarizeOverdue(
  hotelId: string,
  ticket: { id: string; conversation_id: string | null; items: string; minutes: number; assignee: string | null; status: string },
): Promise<string> {
  const facts = `${ticket.items} が期限を${ticket.minutes}分超過（${ticket.status === "doing" ? "対応中" : "未着手"}）。担当：${ticket.assignee ?? "未割り当て"}`;
  if (!ticket.conversation_id) return facts;
  const followUps = await query<{ content: string }>(
    `select m.content from messages m join tickets t on t.id = $2
     where m.conversation_id = $1 and m.role = 'user' and m.created_at > t.created_at order by m.created_at`,
    [ticket.conversation_id, ticket.id],
  );
  if (followUps.length === 0) return facts;
  try {
    const { object, usage } = await generateStructured({
      tier: "small",
      schema: z.object({ note: z.string().describe("催促の回数とゲストの様子（いら立ちなど）を短く。例: ゲストから催促1回、口調にいら立ちあり") }),
      name: "summarize_guest",
      description: "オーダー遅延中のゲストの様子を要約する",
      system: "ホテルの上長向けに、遅れているオーダーについてのゲストの発言を事実だけで短く要約する。推測で補わない。",
      prompt: followUps.map((m) => `ゲスト: ${m.content}`).join("\n"),
    });
    await recordLlmCall({ hotelId, conversationId: ticket.conversation_id, purpose: "summarize", pattern: "complaint", thinking: false, usage });
    return `${facts}。${object.note}`;
  } catch (error) {
    console.warn("[escalation] 要約に失敗したため事実のみで通知", error);
    return facts;
  }
}
