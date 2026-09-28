import type { PoolClient } from "pg";
import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { createHandoff } from "./handoffs";
import type { Hotel } from "./hotel";
import { dispatchTicket, fmtLocal, toRequestedFor } from "./orders";
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

// チャットでの催促（ルーターの order_follow_up）: 未完了のご依頼それぞれに「状況を確認する」と同じ処理をし、返事の文を作る
export async function followUpOrders(hotel: Hotel, conversationId: string, roomNumber: string): Promise<string | undefined> {
  const open = await query<{ id: string; items: string }>(
    `select t.id, (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items
     from tickets t where t.conversation_id = $1 and t.status in ('new', 'doing') order by t.created_at`,
    [conversationId],
  );
  if (open.length === 0) return undefined;
  const lines: string[] = [];
  for (const ticket of open) {
    const { message } = await nudgeFromGuest(hotel, conversationId, ticket.id, roomNumber);
    lines.push(`ご依頼の${ticket.items}は、${message}`);
  }
  return lines.join("\n");
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

// ---------- お届け時間の変更 ----------

// 回答係に渡す未完了のご依頼の状況（回答係はこれ以外のお届けの状況を言わない）
export async function describeOpenTickets(conversationId: string, timezone: string): Promise<string[]> {
  const rows = await query<{ items: string; status: string; dispatched: boolean; requested_for: string | null; pending: boolean; reply: string | null; eta: string | null }>(
    `select (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items,
       t.status, t.dispatched_at is not null dispatched, t.requested_for,
       t.check_requested_at is not null and t.check_replied_at is null pending, t.check_reply reply, t.check_eta_at eta
     from tickets t where t.conversation_id = $1 and t.status in ('new', 'doing') order by t.created_at`,
    [conversationId],
  );
  return rows.map((r) => {
    const when = r.requested_for ? `${fmtLocal(r.requested_for, timezone)}にお届けの予定` : "できるだけ早くお届け";
    const state = r.pending
      ? "担当のスタッフに状況を確認中"
      : r.reply === "on_the_way"
        ? `スタッフが向かっている${r.eta ? `（${fmtLocal(r.eta, timezone)}ごろ）` : ""}`
        : r.status === "doing"
          ? "スタッフが準備・移動中"
          : r.dispatched
            ? "受付済み"
            : "時間指定で受付済み";
    return `${r.items}: ${when}。${state}`;
  });
}

// お届け時間の変更（チャット・「ご依頼の状況」の「時間を変更」）。未着手なら希望日時を変え、対応中なら担当者に希望を伝える。
// 割り当ての前倒しより先の時刻になったら割り当てを外して保留に戻し、今の担当者には対応不要を知らせる
export async function rescheduleTicket(
  hotel: Hotel,
  params: { conversationId: string; ticketId: string; date: string; time: string; until?: string; checkOut: string },
): Promise<string> {
  const { conversationId, ticketId, date, time, until, checkOut } = params;
  if (date > checkOut) throw new Error("ご滞在中の日時をお選びください");
  const requestedFor = await toRequestedFor(hotel, date, time);
  const label = `${fmtLocal(requestedFor, hotel.timezone)}${until ? `〜${until}` : ""}`;
  return transaction(async (client) => {
    const { rows } = await client.query<{ status: string; assignee_id: string | null; dispatched: boolean; room_number: string; items: string }>(
      `select t.status, t.assignee_id, t.dispatched_at is not null dispatched, t.room_number,
         (select string_agg(item_name || '×' || quantity, '、' order by id) from ticket_lines where ticket_id = t.id) items
       from tickets t where t.id = $1 and t.conversation_id = $2 for update`,
      [ticketId, conversationId],
    );
    const ticket = rows[0];
    if (!ticket || !["new", "doing"].includes(ticket.status)) throw new Error("このご依頼は完了しています");
    // 向かっている途中の人とぶつからないよう、対応中は自動で変えず担当者に希望を伝える
    if (ticket.status === "doing") {
      await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'rescheduled', $2)", [ticketId, `対応中のため担当者に伝えた: ${label}`]);
      const result = await requestCheck(client, ticketId, "guest", { message: `お届けは${label}をご希望です` });
      return result === "requested"
        ? `${ticket.items}はスタッフが準備・移動中のため、${label}のご希望を担当のスタッフに伝えました。`
        : `${ticket.items}は担当のスタッフに確認中です。${label}のご希望もあわせてお伝えします。`;
    }
    const later = Date.parse(requestedFor) - hotel.order_schedule_lead_minutes * 60_000 > Date.now();
    await client.query(
      `update tickets set requested_for = $2, due_at = $2, escalated_at = null,
         note = case when $3::text is null then note else concat_ws('／', nullif(note, ''), $3) end
       where id = $1`,
      [ticketId, requestedFor, until ? `お届け希望 ${label}` : null],
    );
    await client.query("insert into ticket_events (ticket_id, type, reason) values ($1, 'rescheduled', $2)", [ticketId, `ゲストが時間を変更: ${label}`]);
    if (later && ticket.dispatched) {
      // 保留に戻し、前倒しの時刻に改めて割り当てる
      await client.query(
        `update tickets set assignee_id = null, assigned_at = null, dispatched_at = null, assignment_mode = 'auto',
           check_requested_at = null, check_source = null, check_requested_by = null, check_message = null,
           check_replied_at = null, check_reply = null, check_eta_at = null, check_reply_note = null
         where id = $1`,
        [ticketId],
      );
      if (ticket.assignee_id) {
        await client.query(
          "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_released', $2, $3, 'ticket', $4)",
          [ticket.assignee_id, `${ticket.room_number}号室のオーダーは対応不要になりました`, `お届けが${label}に変わったため、改めて割り当てます`, ticketId],
        );
      }
    } else if (ticket.assignee_id) {
      await client.query(
        "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_check', $2, $3, 'ticket', $4)",
        [ticket.assignee_id, `${ticket.room_number}号室 お届け時間の変更`, `お届けは${label}をご希望です`, ticketId],
      );
    } else if (!ticket.dispatched) {
      await dispatchTicket(client, hotel, ticketId);
    }
    return `${ticket.items}は${label}にお届けするよう変更しました。`;
  });
}

// チャットでの時間の変更: 会話の未完了のご依頼すべてに当てる
export async function rescheduleOrders(hotel: Hotel, params: { conversationId: string; date: string; time: string; until?: string; checkOut: string }) {
  const open = await query<{ id: string }>(
    "select id from tickets where conversation_id = $1 and status in ('new', 'doing') order by created_at",
    [params.conversationId],
  );
  if (open.length === 0) return undefined;
  const lines: string[] = [];
  for (const { id } of open) {
    try {
      lines.push(await rescheduleTicket(hotel, { ...params, ticketId: id }));
    } catch (error) {
      lines.push(error instanceof Error ? error.message : "お届け時間を変更できませんでした。");
    }
  }
  return [...new Set(lines)].join("\n");
}
