import type { PoolClient } from "pg";
import { ISO_TIMESTAMP, query, queryOne, transaction } from "./db";
import { localNow, type Hotel } from "./hotel";
import { roomLabel, tr } from "@/lib/i18n";

// 同じフロアの近い時間の依頼を同じ人にまとめる窓（plan 4.2 動線短縮）
const BUNDLE_WINDOW_MINUTES = 10;

export type ItemStatus = "available" | "paused" | "retired";

export type CatalogItem = {
  id: string;
  category: string;
  name: string;
  aliases: string[];
  job_role_id: string;
  weight: number;
  due_minutes: number;
  status: Exclude<ItemStatus, "retired">;
};

// 取り扱い終了の品は存在しない扱い（docs/005_order.md 6章）。一時品切れの品は含める（選択欄に「品切れ中」で出す）
export async function getCatalog(hotelId: string): Promise<CatalogItem[]> {
  return query<CatalogItem>(
    "select id, category, name, aliases, job_role_id, weight, due_minutes, status from order_items where hotel_id = $1 and status <> 'retired' order by sort, name",
    [hotelId],
  );
}

// ---------- 部屋 ----------

// 部屋は予約・客室管理システムの一意のIDで持つ。label は表示名（棟＋部屋番号）
export type Room = { id: string; label: string; building: string | null; floor: number; area_id: string | null };

export async function getRoom(client: PoolClient | undefined, hotelId: string, roomId: string): Promise<Room | undefined> {
  const sql = "select id, label, building, floor, area_id from rooms where hotel_id = $1 and id = $2";
  if (!client) return queryOne<Room>(sql, [hotelId, roomId]);
  const { rows } = await client.query<Room>(sql, [hotelId, roomId]);
  return rows[0];
}

export async function listRooms(hotelId: string): Promise<Room[]> {
  return query<Room>(
    "select id, label, building, floor, area_id from rooms where hotel_id = $1 order by building nulls first, floor, room_number",
    [hotelId],
  );
}

// ---------- 希望日時 ----------

// ホテル現地の日付と時刻から日時を作る（希望日時）。過去の時刻は受け付けない
export async function toRequestedFor(hotel: Hotel, date: string, time: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error(tr("お届けの日時を確認してください", "Please check the delivery date and time"));
  const row = await queryOne<{ at: string; past: boolean }>(
    `select ${ISO_TIMESTAMP("x.at")} at, x.at < now() past from (select ($1::date + $2::time) at time zone $3 at) x`,
    [date, time, hotel.timezone],
  );
  if (!row || row.past) throw new Error(tr("お届けの時刻が過ぎています", "That delivery time has already passed"));
  return row.at;
}

// ---------- チケットの作成と割り当て ----------

export type OrderLineInput = { itemId: string; quantity: number };

export type CreatedTicket = {
  id: string;
  lines: { item: string; quantity: number }[];
  dueMinutes: number;
  requestedFor: string | null;
  assigneeName: string | null;
};

type CreateParams = {
  hotel: Hotel;
  roomId: string;
  lines: OrderLineInput[];
  note?: string;
  requestedFor?: string | null; // ISO。ない場合はできるだけ早く
  source: "ai_chat" | "phone" | "front_desk" | "other";
  conversationId?: string;
  createdBy?: string; // 登録した人・AI
};

// 品目を役割ごとのチケットに分け、役割と部屋のエリアの担当から機械ロジックで割り当てる。LLMは使わない（公平性の説明と再現性のため）。
// 希望日時があり、割り当ての前倒し（分）より先なら割り当てを保留する（定期実行の dispatchScheduled で割り当てる）
export async function createTickets(client: PoolClient, params: CreateParams): Promise<CreatedTicket[]> {
  const { hotel, lines, source, conversationId, createdBy } = params;
  const note = params.note?.trim().slice(0, 300) || null;
  const requestedFor = params.requestedFor ?? null;
  const room = await getRoom(client, hotel.id, params.roomId);
  if (!room) throw new Error(tr("部屋が見つかりません", "Room not found"));
  const catalog = await getCatalog(hotel.id);
  const byRole = new Map<string, { item: CatalogItem; quantity: number }[]>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) throw new Error(tr("数量は1〜20にしてください", "Quantity must be 1–20"));
    const item = catalog.find((c) => c.id === line.itemId);
    if (!item) throw new Error(tr("取り扱いのない品目です", "This item is not offered"));
    if (item.status !== "available") throw new Error(tr(`${item.name}はただいま品切れです`, `${item.name} is currently out of stock`));
    byRole.set(item.job_role_id, [...(byRole.get(item.job_role_id) ?? []), { item, quantity: line.quantity }]);
  }
  if (byRole.size === 0) throw new Error(tr("品目を選んでください", "Please choose an item"));

  const scheduled = requestedFor !== null && Date.parse(requestedFor) - hotel.order_schedule_lead_minutes * 60_000 > Date.now();
  const created: CreatedTicket[] = [];
  for (const [jobRoleId, entries] of byRole) {
    const weight = Math.max(...entries.map((e) => e.item.weight));
    const dueMinutes = Math.min(...entries.map((e) => e.item.due_minutes));
    // 期限は希望日時、なければ品目の期限（分）の最小。エリアは部屋のエリア（担当の候補を決める）
    const { rows } = await client.query<{ id: string }>(
      `insert into tickets (hotel_id, room_id, room_number, source, conversation_id, job_role_id, area_id, weight, note, requested_for, due_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($10::timestamptz, now() + make_interval(mins => $11)), $12)
       returning id`,
      [hotel.id, room.id, room.label, source, conversationId ?? null, jobRoleId, room.area_id, weight, note, requestedFor, dueMinutes, createdBy ?? null],
    );
    const ticketId = rows[0].id;
    for (const { item, quantity } of entries) {
      await client.query("insert into ticket_lines (ticket_id, order_item_id, item_name, quantity) values ($1, $2, $3, $4)", [
        ticketId, item.id, item.name, quantity,
      ]);
    }
    await client.query("insert into ticket_events (ticket_id, type, actor_id, reason) values ($1, 'created', $2, $3)", [
      ticketId, createdBy ?? null,
      scheduled
        ? tr(
            `お届け希望 ${fmtLocal(requestedFor!, hotel.timezone)}（${hotel.order_schedule_lead_minutes}分前に割り当て）`,
            `Requested for ${fmtLocal(requestedFor!, hotel.timezone)} (assigned ${hotel.order_schedule_lead_minutes} min before)`,
          )
        : null,
    ]);
    const assignee = scheduled ? undefined : await dispatchTicket(client, hotel, ticketId, createdBy);
    created.push({
      id: ticketId,
      lines: entries.map((e) => ({ item: e.item.name, quantity: e.quantity })),
      dueMinutes,
      requestedFor,
      assigneeName: assignee?.name ?? null,
    });
  }
  return created;
}

// 割り当て: 役割とエリアの担当から次の人を選ぶ。出勤している担当者がいなければ上長（手動割り当ての権限を持つ人）に知らせて手動で割り当ててもらう
export async function dispatchTicket(client: PoolClient, hotel: Hotel, ticketId: string, actorId?: string) {
  const { rows } = await client.query<{ job_role_id: string | null; area_id: string | null; room_id: string; room_number: string; items: string }>(
    `update tickets t set dispatched_at = now() where t.id = $1 and t.dispatched_at is null and t.status = 'new'
     returning t.job_role_id, t.area_id, t.room_id, t.room_number,
       (select string_agg(l.item_name || ' × ' || l.quantity, '${tr("・", ", ")}' order by l.id) from ticket_lines l where l.ticket_id = t.id) items`,
    [ticketId],
  );
  const ticket = rows[0];
  if (!ticket) return undefined;
  await lockAssignment(client, hotel.id);
  const room = await getRoom(client, hotel.id, ticket.room_id);
  const assignee = await pickAssignee(client, hotel, ticket, room);
  if (assignee) {
    await client.query("update tickets set assignee_id = $2, assigned_at = now() where id = $1", [ticketId, assignee.id]);
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'assigned', $2, $3, $4)", [
      ticketId, assignee.id, actorId ?? null, assignee.reason,
    ]);
    await client.query(
      "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
      [assignee.id, tr(`${ticket.room_number}号室のオーダー`, `Order for ${roomLabel(ticket.room_number)}`), ticket.items, ticketId],
    );
  } else {
    await client.query(
      `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
       select m.id, 'ticket_supervisor', $2, $3, 'ticket', $4
       from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'order.reassign')`,
      [hotel.id, tr(`${ticket.room_number}号室のオーダーに担当者がいません`, `No one is available for the ${roomLabel(ticket.room_number)} order`), ticket.items, ticketId],
    );
  }
  return assignee;
}

// 定期実行: 希望日時の前倒し（分）に達した、保留中のチケットを割り当てる
export async function dispatchScheduled(hotel: Hotel, actorId?: string) {
  const due = await query<{ id: string }>(
    `select id from tickets where hotel_id = $1 and status = 'new' and dispatched_at is null
       and requested_for - make_interval(mins => $2) <= now()`,
    [hotel.id, hotel.order_schedule_lead_minutes],
  );
  for (const { id } of due) await transaction((client) => dispatchTicket(client, hotel, id, actorId));
  return due.length;
}

// 同じホテルの割り当てを直列化し、同時の依頼で担当が偏らないようにする
export async function lockAssignment(client: PoolClient, hotelId: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`order-assign:${hotelId}`]);
}

// 担当者なしのチケットを拾い直す（定期実行と、誰かが出勤したとき）。出勤者が出たら自動で割り当てる（docs/005_order.md 5章）
export async function assignUnassigned(hotel: Hotel, actorId?: string) {
  const targets = await query<{ id: string }>(
    `select t.id from tickets t
     where t.hotel_id = $1 and t.status = 'new' and t.dispatched_at is not null and t.assignee_id is null and t.job_role_id is not null
     order by t.due_at`,
    [hotel.id],
  );
  let assigned = 0;
  for (const target of targets) {
    const ok = await transaction(async (client) => {
      await lockAssignment(client, hotel.id);
      const { rows } = await client.query<{ job_role_id: string | null; area_id: string | null; room_id: string; room_number: string; items: string }>(
        `select t.job_role_id, t.area_id, t.room_id, t.room_number,
           (select string_agg(l.item_name || ' × ' || l.quantity, '${tr("・", ", ")}' order by l.id) from ticket_lines l where l.ticket_id = t.id) items
         from tickets t where t.id = $1 and t.assignee_id is null and t.status = 'new' for update`,
        [target.id],
      );
      const ticket = rows[0];
      if (!ticket) return false;
      const room = await getRoom(client, hotel.id, ticket.room_id);
      const assignee = await pickAssignee(client, hotel, ticket, room);
      if (!assignee) return false;
      await client.query("update tickets set assignee_id = $2, assigned_at = now(), assignment_mode = 'auto' where id = $1", [target.id, assignee.id]);
      await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'assigned', $2, $3, $4)", [
        target.id, assignee.id, actorId ?? null, tr(`担当者なしだったため、出勤者に割り当て（${assignee.reason}）`, `Was unassigned; assigned to on-shift staff (${assignee.reason})`),
      ]);
      await client.query(
        "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
        [assignee.id, tr(`${ticket.room_number}号室のオーダー`, `Order for ${roomLabel(ticket.room_number)}`), ticket.items, target.id],
      );
      return true;
    });
    if (ok) assigned++;
  }
  return assigned;
}

// 担当の候補: 今日出勤していて「担当になれる」権限を持ち、チケットの役割を部屋のエリア（または全館）で担当している人。
// エリアの担当を優先し、いなければ全館の担当。その中で同じ棟・フロアの直近の未着手チケットを持つ人にまとめる（plan 4.2）。
// なければ「本日の累計pt＋未完了pt」（役割をまたいだ合計）が最小の人、同点なら最後の割り当てから時間が空いている人
export async function pickAssignee(
  client: PoolClient,
  hotel: Hotel,
  ticket: { job_role_id: string | null; area_id: string | null },
  room: Pick<Room, "floor" | "building"> | undefined,
  excludeIds: string[] = [],
) {
  if (!ticket.job_role_id) return undefined;
  const workDate = localNow(hotel.timezone).date;
  const { rows } = await client.query<{ id: string; name: string; load: number; bundle: boolean; area_duty: boolean }>(
    `select m.id, m.display_name name, l.done_points + l.open_points load, c.area_duty,
       $6::boolean and $4::int is not null and exists (
         select 1 from tickets t join rooms r on r.hotel_id = t.hotel_id and r.id = t.room_id
         where t.assignee_id = m.id and t.job_role_id = $1 and t.status = 'new' and r.floor = $4 and r.building is not distinct from $8
           and t.assigned_at > now() - make_interval(mins => $5)
       ) bundle
     from (
       select d.member_id, bool_or(d.area_id is not null) area_duty from member_duties d
       where d.job_role_id = $1 and (d.area_id is null or d.area_id = $2) group by d.member_id
     ) c
     join members m on m.id = c.member_id
     join member_daily_load l on l.member_id = m.id and l.work_date = $3
     where m.hotel_id = $9 and m.active and has_permission(m.id, 'order.assignable') and not (m.id = any ($7::uuid[]))
     order by c.area_duty desc, bundle desc, load, l.last_assigned_at nulls first
     limit 1`,
    [ticket.job_role_id, ticket.area_id, workDate, room?.floor ?? null, BUNDLE_WINDOW_MINUTES, hotel.order_bundle_enabled, excludeIds, room?.building ?? null, hotel.id],
  );
  const picked = rows[0];
  if (!picked) return undefined;
  return {
    id: picked.id,
    name: picked.name,
    reason: picked.bundle
      ? tr("同じフロアの直近の依頼とまとめ", "Bundled with a recent request on the same floor")
      : tr(
          `${picked.area_duty ? "" : "エリアの担当が出勤していないため全館の担当 ・ "}本日の担当量が最も少ない（${picked.load}pt）`,
          `${picked.area_duty ? "" : "No area staff on shift, so hotel-wide staff · "}Lowest workload today (${picked.load} pt)`,
        ),
  };
}

export function fmtLocal(iso: string, timezone: string): string {
  const now = localNow(timezone);
  const at = localNow(timezone, new Date(iso));
  return at.date === now.date ? at.time : `${Number(at.date.slice(5, 7))}/${Number(at.date.slice(8))} ${at.time}`;
}

// 会話の未完了のご依頼の品（ルーターが催促と新しい依頼を見分けるために使う）
export async function listOpenOrderItems(conversationId: string): Promise<{ itemId: string; name: string; category: string; quantity: number }[]> {
  return query(
    `select i.id "itemId", i.name, i.category, sum(l.quantity)::int quantity
     from tickets t join ticket_lines l on l.ticket_id = t.id join order_items i on i.id = l.order_item_id
     where t.conversation_id = $1 and t.status in ('new', 'doing')
     group by i.id, i.name, i.category`,
    [conversationId],
  );
}

// ---------- ゲスト画面 ----------

export type GuestTicket = {
  id: string;
  status: "new" | "doing" | "done" | "cancelled";
  due_minutes_total: number;
  requested_for: string | null;
  note: string | null;
  created_at: string;
  lines: { item: string; quantity: number }[];
  // 状況（docs/005_order.md 6章）。dispatched=false は時間指定で割り当て前
  dispatched: boolean;
  check_pending: boolean;
  check_reply: "on_the_way" | "cannot" | null;
  check_eta_at: string | null;
  // 「状況を確認する」を続けて押せない間
  nudge_cooling: boolean;
};

export async function listConversationTickets(conversationId: string): Promise<GuestTicket[]> {
  return query<GuestTicket>(
    `select t.id, t.status, ${ISO_TIMESTAMP("t.created_at")} created_at,
       case when t.requested_for is null then null else ${ISO_TIMESTAMP("t.requested_for")} end requested_for, t.note,
       t.dispatched_at is not null dispatched, t.check_requested_at is not null and t.check_replied_at is null check_pending, t.check_reply,
       case when t.check_eta_at is null then null else ${ISO_TIMESTAMP("t.check_eta_at")} end check_eta_at,
       coalesce(t.last_nudged_at > now() - interval '3 minutes', false) nudge_cooling,
       round(extract(epoch from (t.due_at - t.created_at)) / 60)::int due_minutes_total,
       coalesce(json_agg(json_build_object('item', l.item_name, 'quantity', l.quantity) order by l.id), '[]') lines
     from tickets t left join ticket_lines l on l.ticket_id = t.id
     where t.conversation_id = $1
     group by t.id order by t.created_at`,
    [conversationId],
  );
}
