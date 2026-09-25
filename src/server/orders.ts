import type { PoolClient } from "pg";
import { query } from "./db";
import { localNow, type Hotel } from "./hotel";

// 同じフロアの近い時間の依頼を同じ人にまとめる窓（plan 4.2 動線短縮）
const BUNDLE_WINDOW_MINUTES = 10;

export type CatalogItem = {
  id: string;
  name: string;
  aliases: string[];
  job_role_id: string;
  weight: number;
  due_minutes: number;
};

export async function getCatalog(hotelId: string): Promise<CatalogItem[]> {
  return query<CatalogItem>(
    "select id, name, aliases, job_role_id, weight, due_minutes from order_items where hotel_id = $1 and active order by sort",
    [hotelId],
  );
}

// item は品目マスタの名前、label はゲストの言い方（スタッフとゲストへの表示用）
export type OrderLineInput = { item: string; label?: string; quantity: number; note?: string };

export type CreatedTicket = {
  id: string;
  lines: { item: string; quantity: number; note?: string }[];
  dueMinutes: number;
  assigneeName: string | null;
};

type CreateParams = {
  hotel: Hotel;
  roomNumber: string;
  lines: OrderLineInput[];
  source: "ai_chat" | "phone" | "front_desk" | "other";
  rawText?: string;
  conversationId?: string;
  createdBy?: string; // 登録した人・AI
};

// 品目を役割ごとのチケットに分け、枠の中で機械ロジックで割り当てる。LLMは使わない（公平性の説明と再現性のため）
export async function createTickets(client: PoolClient, params: CreateParams): Promise<CreatedTicket[]> {
  const { hotel, roomNumber, lines, source, rawText, conversationId, createdBy } = params;
  const catalog = await getCatalog(hotel.id);
  const byRole = new Map<string, { item: CatalogItem; line: OrderLineInput }[]>();
  for (const line of lines) {
    const item = catalog.find((c) => c.name === line.item);
    if (!item) throw new Error(`品目マスタにない品目です: ${line.item}`);
    byRole.set(item.job_role_id, [...(byRole.get(item.job_role_id) ?? []), { item, line }]);
  }

  const floor = await roomFloor(client, hotel.id, roomNumber);
  const created: CreatedTicket[] = [];
  for (const [jobRoleId, entries] of byRole) {
    const weight = Math.max(...entries.map((e) => e.item.weight));
    const dueMinutes = Math.min(...entries.map((e) => e.item.due_minutes));
    const slotId = await findSlot(client, hotel.id, jobRoleId, floor);
    // 同じ枠の割り当てを直列化し、同時の依頼で担当が偏らないようにする
    if (slotId) await client.query("select pg_advisory_xact_lock(hashtext($1))", [slotId]);
    const assignee = slotId ? await pickAssignee(client, hotel, slotId, floor) : undefined;

    const { rows } = await client.query<{ id: string }>(
      `insert into tickets (hotel_id, room_number, source, raw_text, conversation_id, slot_id, assignee_id, weight, due_at, assigned_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9), case when $7::uuid is null then null else now() end, $10)
       returning id`,
      [hotel.id, roomNumber, source, rawText ?? null, conversationId ?? null, slotId ?? null, assignee?.id ?? null, weight, dueMinutes, createdBy ?? null],
    );
    const ticketId = rows[0].id;
    for (const { item, line } of entries) {
      await client.query(
        "insert into ticket_lines (ticket_id, order_item_id, item_name, quantity, note) values ($1, $2, $3, $4, $5)",
        [ticketId, item.id, line.label || item.name, line.quantity, line.note || null],
      );
    }
    await client.query("insert into ticket_events (ticket_id, type, actor_id) values ($1, 'created', $2)", [ticketId, createdBy ?? null]);
    if (assignee) {
      await client.query(
        "insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'assigned', $2, $3, $4)",
        [ticketId, assignee.id, createdBy ?? null, assignee.reason],
      );
      await client.query(
        "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
        [assignee.id, `${roomNumber}号室のオーダー`, entries.map((e) => `${e.line.label || e.item.name} × ${e.line.quantity}`).join("・"), ticketId],
      );
    }
    created.push({
      id: ticketId,
      lines: entries.map((e) => ({ item: e.line.label || e.item.name, quantity: e.line.quantity, note: e.line.note })),
      dueMinutes,
      assigneeName: assignee?.name ?? null,
    });
  }
  return created;
}

async function roomFloor(client: PoolClient, hotelId: string, roomNumber: string): Promise<number | null> {
  const { rows } = await client.query<{ floor: number }>("select floor from rooms where hotel_id = $1 and room_number = $2", [hotelId, roomNumber]);
  if (rows[0]) return rows[0].floor;
  // 部屋マスタにない場合は部屋番号の下2桁より上をフロアとみなす
  const parsed = Number.parseInt(roomNumber.slice(0, -2), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// 役割 × エリア（フロアを含むエリア）の枠。エリアを持たない全館担当の枠も候補にする
async function findSlot(client: PoolClient, hotelId: string, jobRoleId: string, floor: number | null) {
  const { rows } = await client.query<{ id: string }>(
    `select s.id from slots s left join areas a on a.id = s.area_id
     where s.hotel_id = $1 and s.job_role_id = $2
       and (s.area_id is null or $3::int between a.floor_from and a.floor_to)
     order by s.area_id is null
     limit 1`,
    [hotelId, jobRoleId, floor],
  );
  return rows[0]?.id;
}

// plan 4.2: 同じフロアの直近の未着手チケットを持つ人にまとめる。なければ「本日の累計pt＋未完了pt」が最小の人、
// 同点なら最後の割り当てから時間が空いている人
async function pickAssignee(client: PoolClient, hotel: Hotel, slotId: string, floor: number | null) {
  const workDate = localNow(hotel.timezone).date;
  const { rows } = await client.query<{ id: string; name: string; load: number; bundle: boolean }>(
    `select m.id, m.display_name name, l.done_points + l.open_points load,
       exists (
         select 1 from tickets t join rooms r on r.hotel_id = t.hotel_id and r.room_number = t.room_number
         where t.assignee_id = m.id and t.slot_id = $1 and t.status = 'new' and r.floor = $3
           and t.assigned_at > now() - make_interval(mins => $4)
       ) bundle
     from member_daily_load l join members m on m.id = l.member_id
     where l.slot_id = $1 and l.work_date = $2 and m.active and has_permission(m.id, 'order.assignable', $1)
     order by bundle desc, load, l.last_assigned_at nulls first
     limit 1`,
    [slotId, workDate, floor, BUNDLE_WINDOW_MINUTES],
  );
  const picked = rows[0];
  if (!picked) return undefined;
  return {
    id: picked.id,
    name: picked.name,
    reason: picked.bundle ? "同じフロアの直近の依頼とまとめ" : `本日の担当量が最も少ない（${picked.load}pt）`,
  };
}

export type GuestTicket = {
  id: string;
  status: "new" | "doing" | "done" | "cancelled";
  due_minutes_total: number;
  created_at: string;
  lines: { item: string; quantity: number; note: string | null }[];
};

export async function listConversationTickets(conversationId: string): Promise<GuestTicket[]> {
  return query<GuestTicket>(
    `select t.id, t.status, t.created_at,
       round(extract(epoch from (t.due_at - t.created_at)) / 60)::int due_minutes_total,
       coalesce(json_agg(json_build_object('item', l.item_name, 'quantity', l.quantity, 'note', l.note) order by l.id), '[]') lines
     from tickets t left join ticket_lines l on l.ticket_id = t.id
     where t.conversation_id = $1
     group by t.id order by t.created_at`,
    [conversationId],
  );
}
