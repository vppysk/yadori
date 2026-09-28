import type { PoolClient } from "pg";
import { ISO_TIMESTAMP, query, queryOne, transaction } from "./db";
import { localNow, type Hotel } from "./hotel";

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("お届けの日時を確認してください");
  const row = await queryOne<{ at: string; past: boolean }>(
    `select ${ISO_TIMESTAMP("x.at")} at, x.at < now() past from (select ($1::date + $2::time) at time zone $3 at) x`,
    [date, time, hotel.timezone],
  );
  if (!row || row.past) throw new Error("お届けの時刻が過ぎています");
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

// 品目を役割ごとのチケットに分け、枠の中で機械ロジックで割り当てる。LLMは使わない（公平性の説明と再現性のため）。
// 希望日時があり、割り当ての前倒し（分）より先なら割り当てを保留する（定期実行の dispatchScheduled で割り当てる）
export async function createTickets(client: PoolClient, params: CreateParams): Promise<CreatedTicket[]> {
  const { hotel, lines, source, conversationId, createdBy } = params;
  const note = params.note?.trim().slice(0, 300) || null;
  const requestedFor = params.requestedFor ?? null;
  const room = await getRoom(client, hotel.id, params.roomId);
  if (!room) throw new Error("部屋が見つかりません");
  const catalog = await getCatalog(hotel.id);
  const byRole = new Map<string, { item: CatalogItem; quantity: number }[]>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) throw new Error("数量は1〜20にしてください");
    const item = catalog.find((c) => c.id === line.itemId);
    if (!item) throw new Error("取り扱いのない品目です");
    if (item.status !== "available") throw new Error(`${item.name}はただいま品切れです`);
    byRole.set(item.job_role_id, [...(byRole.get(item.job_role_id) ?? []), { item, quantity: line.quantity }]);
  }
  if (byRole.size === 0) throw new Error("品目を選んでください");

  const scheduled = requestedFor !== null && Date.parse(requestedFor) - hotel.order_schedule_lead_minutes * 60_000 > Date.now();
  const created: CreatedTicket[] = [];
  for (const [jobRoleId, entries] of byRole) {
    const weight = Math.max(...entries.map((e) => e.item.weight));
    const dueMinutes = Math.min(...entries.map((e) => e.item.due_minutes));
    const slotId = await findSlot(client, hotel.id, jobRoleId, room.area_id);
    // 期限は希望日時、なければ品目の期限（分）の最小
    const { rows } = await client.query<{ id: string }>(
      `insert into tickets (hotel_id, room_id, room_number, source, conversation_id, slot_id, weight, note, requested_for, due_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($9::timestamptz, now() + make_interval(mins => $10)), $11)
       returning id`,
      [hotel.id, room.id, room.label, source, conversationId ?? null, slotId ?? null, weight, note, requestedFor, dueMinutes, createdBy ?? null],
    );
    const ticketId = rows[0].id;
    for (const { item, quantity } of entries) {
      await client.query("insert into ticket_lines (ticket_id, order_item_id, item_name, quantity) values ($1, $2, $3, $4)", [
        ticketId, item.id, item.name, quantity,
      ]);
    }
    await client.query("insert into ticket_events (ticket_id, type, actor_id, reason) values ($1, 'created', $2, $3)", [
      ticketId, createdBy ?? null,
      scheduled ? `お届け希望 ${fmtLocal(requestedFor!, hotel.timezone)}（${hotel.order_schedule_lead_minutes}分前に割り当て）` : null,
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

// 割り当て: 枠の中で次の人を選ぶ。枠に出勤者がいなければ上長（手動割り当ての権限を持つ人）に知らせて手動で割り当ててもらう
export async function dispatchTicket(client: PoolClient, hotel: Hotel, ticketId: string, actorId?: string) {
  const { rows } = await client.query<{ slot_id: string | null; room_id: string; room_number: string; items: string }>(
    `update tickets t set dispatched_at = now() where t.id = $1 and t.dispatched_at is null and t.status = 'new'
     returning t.slot_id, t.room_id, t.room_number,
       (select string_agg(l.item_name || ' × ' || l.quantity, '・' order by l.id) from ticket_lines l where l.ticket_id = t.id) items`,
    [ticketId],
  );
  const ticket = rows[0];
  if (!ticket) return undefined;
  // 同じ枠の割り当てを直列化し、同時の依頼で担当が偏らないようにする
  if (ticket.slot_id) await client.query("select pg_advisory_xact_lock(hashtext($1))", [ticket.slot_id]);
  const room = await getRoom(client, hotel.id, ticket.room_id);
  const assignee = ticket.slot_id ? await pickAssignee(client, hotel, ticket.slot_id, room) : undefined;
  if (assignee) {
    await client.query("update tickets set assignee_id = $2, assigned_at = now() where id = $1", [ticketId, assignee.id]);
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'assigned', $2, $3, $4)", [
      ticketId, assignee.id, actorId ?? null, assignee.reason,
    ]);
    await client.query(
      "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
      [assignee.id, `${ticket.room_number}号室のオーダー`, ticket.items, ticketId],
    );
  } else {
    await client.query(
      `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
       select m.id, 'ticket_supervisor', $2, $3, 'ticket', $4
       from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'order.reassign')`,
      [hotel.id, `${ticket.room_number}号室のオーダーに担当者がいません`, ticket.items, ticketId],
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

// 担当者なしのチケットを拾い直す（定期実行と、枠に出勤したとき）。出勤者が出たら自動で割り当てる（docs/005_order.md 5章）
export async function assignUnassigned(hotel: Hotel, slotId?: string, actorId?: string) {
  const targets = await query<{ id: string; slot_id: string }>(
    `select t.id, t.slot_id from tickets t
     where t.hotel_id = $1 and t.status = 'new' and t.dispatched_at is not null and t.assignee_id is null and t.slot_id is not null
       and ($2::uuid is null or t.slot_id = $2)
       and exists (select 1 from slot_shifts ss where ss.slot_id = t.slot_id and ss.work_date = $3 and ss.ended_at is null)
     order by t.due_at`,
    [hotel.id, slotId ?? null, localNow(hotel.timezone).date],
  );
  let assigned = 0;
  for (const target of targets) {
    const ok = await transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [target.slot_id]);
      const { rows } = await client.query<{ room_id: string; room_number: string; items: string }>(
        `select t.room_id, t.room_number,
           (select string_agg(l.item_name || ' × ' || l.quantity, '・' order by l.id) from ticket_lines l where l.ticket_id = t.id) items
         from tickets t where t.id = $1 and t.assignee_id is null and t.status = 'new' for update`,
        [target.id],
      );
      const ticket = rows[0];
      if (!ticket) return false;
      const room = await getRoom(client, hotel.id, ticket.room_id);
      const assignee = await pickAssignee(client, hotel, target.slot_id, room);
      if (!assignee) return false;
      await client.query("update tickets set assignee_id = $2, assigned_at = now(), assignment_mode = 'auto' where id = $1", [target.id, assignee.id]);
      await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'assigned', $2, $3, $4)", [
        target.id, assignee.id, actorId ?? null, `担当者なしだったため、出勤者に割り当て（${assignee.reason}）`,
      ]);
      await client.query(
        "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
        [assignee.id, `${ticket.room_number}号室のオーダー`, ticket.items, target.id],
      );
      return true;
    });
    if (ok) assigned++;
  }
  return assigned;
}

// 役割 × エリア（部屋のエリア）の枠。エリアを持たない全館担当の枠も候補にし、エリアの枠を優先する
async function findSlot(client: PoolClient, hotelId: string, jobRoleId: string, areaId: string | null) {
  const { rows } = await client.query<{ id: string }>(
    `select id from slots where hotel_id = $1 and job_role_id = $2 and (area_id is null or area_id = $3)
     order by area_id is null limit 1`,
    [hotelId, jobRoleId, areaId],
  );
  return rows[0]?.id;
}

// plan 4.2: 同じ棟・フロアの直近の未着手チケットを持つ人にまとめる。なければ「本日の累計pt＋未完了pt」が最小の人、
// 同点なら最後の割り当てから時間が空いている人
export async function pickAssignee(client: PoolClient, hotel: Hotel, slotId: string, room: Pick<Room, "floor" | "building"> | undefined, excludeIds: string[] = []) {
  const workDate = localNow(hotel.timezone).date;
  const { rows } = await client.query<{ id: string; name: string; load: number; bundle: boolean }>(
    `select m.id, m.display_name name, l.done_points + l.open_points load,
       $6::boolean and $3::int is not null and exists (
         select 1 from tickets t join rooms r on r.hotel_id = t.hotel_id and r.id = t.room_id
         where t.assignee_id = m.id and t.slot_id = $1 and t.status = 'new' and r.floor = $3 and r.building is not distinct from $7
           and t.assigned_at > now() - make_interval(mins => $4)
       ) bundle
     from member_daily_load l join members m on m.id = l.member_id
     where l.slot_id = $1 and l.work_date = $2 and m.active and has_permission(m.id, 'order.assignable', $1)
       and not (m.id = any ($5::uuid[]))
     order by bundle desc, load, l.last_assigned_at nulls first
     limit 1`,
    [slotId, workDate, room?.floor ?? null, BUNDLE_WINDOW_MINUTES, excludeIds, hotel.order_bundle_enabled, room?.building ?? null],
  );
  const picked = rows[0];
  if (!picked) return undefined;
  return {
    id: picked.id,
    name: picked.name,
    reason: picked.bundle ? "同じフロアの直近の依頼とまとめ" : `本日の担当量が最も少ない（${picked.load}pt）`,
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
