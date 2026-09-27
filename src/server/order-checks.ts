import type { PoolClient } from "pg";
import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { createHandoff } from "./handoffs";
import type { Hotel } from "./hotel";
import { fmtLocal } from "./orders";
import { declineTicket } from "./staff-work";

// オーダーの状況確認と催促（docs/005_order.md 6章）。
// 期限切れ・ゲストの「状況を確認する」・上長の依頼で、今の担当者に状況を確認する。担当者は定型の返事と任意の一言で答える。
// 返事がなければ上長の判断を待つ（自動では割り当て直さない。部屋に向かっている途中の人とぶつからないようにするため）

export type CheckSource = "overdue" | "guest" | "supervisor";
export type CheckReply = "on_the_way" | "cannot";

const SOURCE_LABEL: Record<CheckSource, string> = {
  overdue: "お届けの期限を過ぎました",
  guest: "ゲストから状況の確認がありました",
  supervisor: "上長から状況の確認です",
};

// ゲストの「状況を確認する」を続けて押せない間隔
export const NUDGE_COOLDOWN_MINUTES = 3;
// 返事の到着の目安（分）
export const ETA_CHOICES = [5, 10, 15] as const;

// 担当者に状況を確認する。担当者がいない・返事待ちの確認がすでにあるときは作らない
export async function requestCheck(
  client: PoolClient,
  ticketId: string,
  source: CheckSource,
  options: { actorId?: string; message?: string } = {},
): Promise<"requested" | "pending" | "no_assignee"> {
  const { rows } = await client.query<{ assignee_id: string | null; room_number: string; pending: boolean }>(
    `select assignee_id, room_number, check_requested_at is not null and check_replied_at is null pending
     from tickets where id = $1 and status in ('new', 'doing') for update`,
    [ticketId],
  );
  const ticket = rows[0];
  if (!ticket?.assignee_id) return "no_assignee";
  if (ticket.pending) return "pending";
  const message = options.message?.trim().slice(0, 200) || null;
  await client.query(
    `update tickets set check_requested_at = now(), check_source = $2, check_requested_by = $3, check_message = $4,
       check_replied_at = null, check_reply = null, check_eta_at = null, check_reply_note = null
     where id = $1`,
    [ticketId, source, options.actorId ?? null, message],
  );
  await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'check_requested', $2, $3, $4)", [
    ticketId, ticket.assignee_id, options.actorId ?? null, [SOURCE_LABEL[source], message].filter(Boolean).join("：") || null,
  ]);
  await client.query(
    "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_check', $2, $3, 'ticket', $4)",
    [ticket.assignee_id, `${ticket.room_number}号室 状況の確認`, [SOURCE_LABEL[source], message].filter(Boolean).join("：") || null, ticketId],
  );
  return "requested";
}

// 担当者の返事。「向かっています」は到着の目安をゲスト画面にも出す。「対応できない」は枠内の次の人へ自動で再割り当てする
export async function replyCheck(member: Member, ticketId: string, reply: CheckReply, options: { etaMinutes?: number; note?: string } = {}) {
  const note = options.note?.trim().slice(0, 200) || null;
  if (reply === "cannot") {
    await transaction(async (client) => {
      const updated = await markReplied(client, member, ticketId, "cannot", null, note);
      if (!updated) throw new Error("確認に返事できるオーダーではありません");
    });
    // 着手済みでも返せる（確認への返事として）
    await declineTicket(member, ticketId, note ?? "状況の確認に「対応できない」と返事", { allowStarted: true });
    return;
  }
  const eta = ETA_CHOICES.includes(options.etaMinutes as (typeof ETA_CHOICES)[number]) ? options.etaMinutes! : 10;
  await transaction(async (client) => {
    const updated = await markReplied(client, member, ticketId, "on_the_way", eta, note);
    if (!updated) throw new Error("確認に返事できるオーダーではありません");
    // 「向かっています」は着手とみなす
    const { rowCount } = await client.query("update tickets set status = 'doing', started_at = now() where id = $1 and status = 'new'", [ticketId]);
    if (rowCount) await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id) values ($1, 'started', $2, $2)", [ticketId, member.id]);
  });
}

async function markReplied(client: PoolClient, member: Member, ticketId: string, reply: CheckReply, etaMinutes: number | null, note: string | null) {
  const { rows } = await client.query<{ id: string }>(
    `update tickets set check_replied_at = now(), check_reply = $3,
       check_eta_at = case when $4::int is null then null else now() + make_interval(mins => $4::int) end, check_reply_note = $5
     where id = $1 and assignee_id = $2 and status in ('new', 'doing') and check_requested_at is not null and check_replied_at is null
     returning id`,
    [ticketId, member.id, reply, etaMinutes, note],
  );
  if (!rows[0]) return false;
  const label = reply === "on_the_way" ? `向かっています（あと${etaMinutes}分）` : "対応できない";
  await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'check_replied', $2, $2, $3)", [
    ticketId, member.id, [label, note].filter(Boolean).join("："),
  ]);
  return true;
}

// 上長の「担当者に確認」（管理PC）
export async function requestCheckBySupervisor(member: Member, ticketId: string, message: string) {
  const result = await transaction(async (client) => {
    const { rows } = await client.query("select 1 from tickets where id = $1 and hotel_id = $2", [ticketId, member.hotel_id]);
    if (!rows[0]) throw new Error("オーダーが見つかりません");
    return requestCheck(client, ticketId, "supervisor", { actorId: member.id, message });
  });
  if (result === "no_assignee") throw new Error("担当者がいないため確認できません。手動で割り当ててください");
  if (result === "pending") throw new Error("担当者の返事を待っています");
}

// ---------- ゲストの「状況を確認する」 ----------

export type NudgeResult = { message: string };

// ゲストの催促（ボタン）。担当者に状況を確認し、期限を過ぎていたか2回目以降ならクレームとして引き継ぐ（チケットごとに1件）
export async function nudgeFromGuest(hotel: Hotel, conversationId: string, ticketId: string, roomNumber: string): Promise<NudgeResult> {
  const ticket = await queryOne<{ status: string; dispatched: boolean; requested_for: string | null; cooling: boolean; overdue: boolean; items: string }>(
    `select status, dispatched_at is not null dispatched, requested_for,
       last_nudged_at > now() - make_interval(mins => $3) cooling, due_at < now() overdue,
       (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items
     from tickets t where id = $1 and conversation_id = $2`,
    [ticketId, conversationId, NUDGE_COOLDOWN_MINUTES],
  );
  if (!ticket || !["new", "doing"].includes(ticket.status)) throw new Error("このご依頼は完了しています");
  // 時間指定で割り当て前なら、予定の時刻を伝えるだけ
  if (!ticket.dispatched && ticket.requested_for) {
    return { message: `${fmtLocal(ticket.requested_for, hotel.timezone)}にお届けする予定です。` };
  }
  if (ticket.cooling) return { message: "担当のスタッフに確認しています。少々お待ちください。" };

  const nudges = await transaction(async (client) => {
    const { rows } = await client.query<{ guest_nudges: number }>(
      "update tickets set guest_nudges = guest_nudges + 1, last_nudged_at = now() where id = $1 returning guest_nudges",
      [ticketId],
    );
    await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'guest_nudged', $2)", [ticketId, `${rows[0].guest_nudges}回目`]);
    await requestCheck(client, ticketId, "guest");
    return rows[0].guest_nudges;
  });
  if (ticket.overdue || nudges >= 2) await complaintForOrder(hotel.id, conversationId, ticketId, roomNumber, `${ticket.items}のお届けが遅れ、ゲストから状況の確認（${nudges}回目${ticket.overdue ? "・期限超過" : ""}）`);
  return { message: "担当のスタッフに状況を確認しています。わかり次第こちらに表示します。" };
}

// オーダーの遅れへの不満はクレームとして引き継ぐ（オーダー遅延の引き継ぎは作らない）。チケットごとに対応中の1件まで
export async function complaintForOrder(hotelId: string, conversationId: string | undefined, ticketId: string, roomNumber: string, summary: string) {
  const existing = await queryOne("select 1 from handoffs where ticket_id = $1 and kind = 'complaint' and status in ('open', 'accepted')", [ticketId]);
  if (existing) return;
  await createHandoff({ hotelId, kind: "complaint", conversationId, ticketId, roomNumber, summary });
}

// チャットでの催促・不満（ルーターが complaint と判定）: 会話の未完了のチケットを催促として数え、担当者に状況を確認する。
// クレームの引き継ぎは guest-chat.ts が作る
export async function checkOpenTicketsForComplaint(conversationId: string) {
  const open = await query<{ id: string }>(
    "select id from tickets where conversation_id = $1 and status in ('new', 'doing') and dispatched_at is not null",
    [conversationId],
  );
  for (const { id } of open) {
    await transaction(async (client) => {
      await client.query("update tickets set guest_nudges = guest_nudges + 1, last_nudged_at = now() where id = $1", [id]);
      await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'guest_nudged', 'チャットでの不満・催促')", [id]);
      await requestCheck(client, id, "guest");
    });
  }
  return open.length;
}
