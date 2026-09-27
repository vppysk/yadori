import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel, localNow } from "./hotel";
import { recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, getRoom, listRooms, pickAssignee, toRequestedFor, type CatalogItem, type CreatedTicket, type Room } from "./orders";
import { notifySupervisors } from "./staff-work";

// 管理PCのオーダーボード（plan 4.2）: 枠ごとの担当者別ボード、要対応、時間指定、フロントでの電話・来訪オーダーの登録、上長による付け替え

export type SlotSummary = { id: string; label: string; members: number };

export async function listSlots(hotelId: string): Promise<SlotSummary[]> {
  const hotel = await getHotel(hotelId);
  return query<SlotSummary>(
    `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label,
       (select count(*)::int from slot_shifts ss where ss.slot_id = s.id and ss.work_date = $2 and ss.ended_at is null) members
     from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
     where s.hotel_id = $1 order by r.name, a.sort, a.name`,
    [hotelId, localNow(hotel.timezone).date],
  );
}

export type BoardTicket = {
  id: string;
  room_number: string;
  status: "new" | "doing";
  weight: number;
  items: string;
  note: string | null;
  requested_for: string | null;
  dispatched: boolean;
  source: string;
  created_by_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  due_at: string;
  overdue_minutes: number;
  last_event: string | null;
  last_reason: string | null;
};

export type BoardColumn = { memberId: string; name: string; points: number; tickets: BoardTicket[] };
// scheduled: 時間指定で割り当て前のもの
export type Board = { attention: BoardTicket[]; scheduled: BoardTicket[]; columns: BoardColumn[]; averagePoints: number };

export async function getBoard(hotelId: string, slotId: string): Promise<Board> {
  const hotel = await getHotel(hotelId);
  const workDate = localNow(hotel.timezone).date;
  const [members, tickets] = await Promise.all([
    query<{ member_id: string; name: string; points: number }>(
      `select l.member_id, m.display_name name, (l.done_points + l.open_points)::int points
       from member_daily_load l join members m on m.id = l.member_id
       where l.slot_id = $1 and l.work_date = $2 order by m.display_name`,
      [slotId, workDate],
    ),
    query<BoardTicket>(
      `select t.id, t.room_number, t.status, t.weight, t.source, cm.display_name created_by_name, t.assignee_id, am.display_name assignee_name,
         t.due_at, greatest(0, floor(extract(epoch from (now() - t.due_at)) / 60))::int overdue_minutes,
         (select string_agg(l.item_name || ' × ' || l.quantity, '、' order by l.id) from ticket_lines l where l.ticket_id = t.id) items,
         t.note, t.requested_for, t.dispatched_at is not null dispatched,
         e.type last_event, e.reason last_reason
       from tickets t
       left join members am on am.id = t.assignee_id
       left join members cm on cm.id = t.created_by
       left join lateral (select type, reason from ticket_events where ticket_id = t.id order by created_at desc limit 1) e on true
       where t.hotel_id = $1 and t.slot_id = $2 and t.status in ('new', 'doing')
       order by coalesce(t.requested_for, t.due_at), t.due_at`,
      [hotelId, slotId],
    ),
  ]);
  // 要対応: 期限超過、担当者なし、直近に自動で付け替えたもの（「対応できない」・着手されなかった）。上長が手で付け替えたものは担当者の列に出す
  const autoReassigned = (t: BoardTicket) => t.last_event === "reassigned" && !(t.last_reason ?? "").endsWith("が付け替え");
  const needsAttention = (t: BoardTicket) => t.dispatched && (t.overdue_minutes > 0 || !t.assignee_id || autoReassigned(t));
  const columns = members.map((m) => ({
    memberId: m.member_id,
    name: m.name,
    points: m.points,
    tickets: tickets.filter((t) => t.assignee_id === m.member_id && !needsAttention(t)),
  }));
  return {
    attention: tickets.filter(needsAttention),
    scheduled: tickets.filter((t) => !t.dispatched),
    columns,
    averagePoints: members.length ? members.reduce((a, m) => a + m.points, 0) / members.length : 0,
  };
}

// ---------- フロントでの登録（電話・来訪） ----------
// 自由文の読み取りは廃止し、品目・数量・備考・お届け時間を選んで登録する（docs/005_order.md 2章）

export type OrderForm = { rooms: Room[]; catalog: CatalogItem[]; today: string; leadMinutes: number };

export async function getOrderForm(hotelId: string): Promise<OrderForm> {
  const hotel = await getHotel(hotelId);
  const [rooms, catalog] = await Promise.all([listRooms(hotelId), getCatalog(hotelId)]);
  return { rooms, catalog, today: localNow(hotel.timezone).date, leadMinutes: hotel.order_schedule_lead_minutes };
}

export type AssignmentPreview = { slotLabel: string; assigneeName: string | null; reason: string | null }[];

// 割り当て予定（保存しない）。実際の割り当てと同じ選び方（pickAssignee）で求める
export async function previewAssignment(member: Member, roomId: string, itemIds: string[]): Promise<AssignmentPreview> {
  const hotel = await getHotel(member.hotel_id);
  const catalog = await getCatalog(hotel.id);
  return transaction(async (client) => {
    const room = await getRoom(client, hotel.id, roomId);
    if (!room) throw new Error("部屋が見つかりません");
    const roles = [...new Set(itemIds.map((id) => catalog.find((c) => c.id === id)?.job_role_id).filter((r): r is string => Boolean(r)))];
    const result: AssignmentPreview = [];
    for (const roleId of roles) {
      const { rows } = await client.query<{ id: string; label: string }>(
        `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
         where s.hotel_id = $1 and s.job_role_id = $2 and (s.area_id is null or s.area_id = $3)
         order by s.area_id is null limit 1`,
        [hotel.id, roleId, room.area_id],
      );
      const slot = rows[0];
      const next = slot ? await pickAssignee(client, hotel, slot.id, room) : undefined;
      result.push({ slotLabel: slot?.label ?? "担当の枠がありません", assigneeName: next?.name ?? null, reason: next?.reason ?? null });
    }
    return result;
  });
}

export type RegisterOrderInput = {
  roomId: string;
  source: "phone" | "front_desk" | "other";
  lines: { itemId: string; quantity: number }[];
  note: string;
  deliver: { date: string; time: string } | null;
};

export async function registerOrder(member: Member, input: RegisterOrderInput): Promise<CreatedTicket[]> {
  const hotel = await getHotel(member.hotel_id);
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) throw new Error("品目と数量を選んでください");
  const requestedFor = input.deliver ? await toRequestedFor(hotel, input.deliver.date, input.deliver.time) : null;
  const tickets = await transaction((client) =>
    createTickets(client, { hotel, roomId: input.roomId, lines, note: input.note, requestedFor, source: input.source, createdBy: member.id }),
  );
  for (const t of tickets) {
    await recordWorkEvent({ hotelId: hotel.id, ticketId: t.id, pattern: "order", handlerKind: "human", handler: member.job_title ?? "フロント", outcome: "resolved", signals: { phase: "intake", source: input.source } });
  }
  return tickets;
}

// ---------- 上長による付け替え ----------

export async function reassignManually(member: Member, ticketId: string, toMemberId: string) {
  await transaction(async (client) => {
    const { rows } = await client.query<{ slot_id: string; room_number: string; hotel_id: string }>(
      "select slot_id, room_number, hotel_id from tickets where id = $1 and hotel_id = $2 and status in ('new', 'doing') for update",
      [ticketId, member.hotel_id],
    );
    const ticket = rows[0];
    if (!ticket) throw new Error("付け替えられるオーダーではありません");
    const { rows: ok } = await client.query<{ ok: boolean; name: string }>(
      "select has_permission(id, 'order.assignable', $2) ok, display_name name from members where id = $1 and hotel_id = $3 and active",
      [toMemberId, ticket.slot_id, member.hotel_id],
    );
    if (!ok[0]?.ok) throw new Error("この人はこの枠の担当になれません");
    await client.query("update tickets set assignee_id = $2, assigned_at = now(), dispatched_at = coalesce(dispatched_at, now()), status = 'new', started_at = null where id = $1", [ticketId, toMemberId]);
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'reassigned', $2, $3, $4)", [
      ticketId, toMemberId, member.id, `${member.display_name}が付け替え`,
    ]);
    await client.query(
      "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
      [toMemberId, `${ticket.room_number}号室のオーダー（付け替え）`, `${member.display_name}が割り当てました`, ticketId],
    );
    await notifySupervisors(client, member.hotel_id, `${ticket.room_number}号室のオーダーを付け替え`, `${member.display_name}が${ok[0].name}に割り当て`, ticketId);
  });
}

// 付け替え先の候補: その枠に今日出勤していて、担当になれる人
export async function assignableMembers(hotelId: string, slotId: string) {
  const hotel = await getHotel(hotelId);
  return query<{ id: string; name: string }>(
    `select m.id, m.display_name name from slot_shifts s join members m on m.id = s.member_id
     where s.slot_id = $1 and s.work_date = $2 and s.ended_at is null and m.active and has_permission(m.id, 'order.assignable', $1)
     order by m.display_name`,
    [slotId, localNow(hotel.timezone).date],
  );
}
