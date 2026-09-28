import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel, localNow } from "./hotel";
import { recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, getRoom, listRooms, pickAssignee, toRequestedFor, type CatalogItem, type CreatedTicket, type Room } from "./orders";
import { notifySupervisors } from "./staff-work";

// 管理PCのオーダーボード（plan 4.2）: ステータス別のカンバン（エリアで絞り込み、期限の近い順）、フロントでの電話・来訪オーダーの登録、上長による手動割り当て

export type AreaSummary = { id: string; name: string };

export async function listAreas(hotelId: string): Promise<AreaSummary[]> {
  return query<AreaSummary>("select id, name from areas where hotel_id = $1 order by sort, name", [hotelId]);
}

export type BoardTicket = {
  id: string;
  room_number: string;
  area_name: string | null;
  slot_id: string | null;
  slot_label: string | null;
  status: "new" | "doing" | "done";
  weight: number;
  items: string;
  note: string | null;
  requested_for: string | null;
  dispatched: boolean;
  dispatch_at: string | null; // 時間指定で割り当てを保留しているとき、割り当てる時刻
  source: string;
  created_by_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  due_at: string;
  done_at: string | null;
  overdue_minutes: number; // 未完了で期限を過ぎた分数
  late_minutes: number; // 完了が期限より遅れた分数
  // 状況の確認（docs/005_order.md 6章）。返事がなければ check_reply は空
  check_requested_at: string | null;
  check_source: "overdue" | "guest" | "supervisor" | null;
  check_message: string | null;
  check_reply: "on_the_way" | "cannot" | null;
  check_replied_at: string | null;
  check_eta_at: string | null;
  check_reply_note: string | null;
  check_waiting_minutes: number; // 返事待ちの経過（分）
  guest_nudges: number;
  complaint: boolean; // この遅れがクレームとして引き継がれている
  last_event: string | null;
  last_reason: string | null;
};

// ステータス別の列。unassigned: 担当者なし（時間指定で割り当て前のものを含む）、done: 本日の完了
// 期限超過・返事待ち・クレームは列を分けず、カードの表示で示す
export type Board = { unassigned: BoardTicket[]; waiting: BoardTicket[]; doing: BoardTicket[]; done: BoardTicket[] };

// areaId: 部屋のエリアで絞り込む（null はすべて）
export async function getBoard(hotelId: string, areaId: string | null): Promise<Board> {
  const hotel = await getHotel(hotelId);
  const tickets = await query<BoardTicket>(
    `select t.id, t.room_number, ra.name area_name, t.slot_id, sr.name || coalesce(' ' || sa.name, '（全館）') slot_label,
       t.status, t.weight, t.source, cm.display_name created_by_name, t.assignee_id, am.display_name assignee_name,
       t.due_at, t.done_at, case when t.status = 'done' then 0 else greatest(0, floor(extract(epoch from (now() - t.due_at)) / 60)) end::int overdue_minutes,
       case when t.status = 'done' then greatest(0, floor(extract(epoch from (t.done_at - t.due_at)) / 60)) else 0 end::int late_minutes,
       (select string_agg(l.item_name || ' × ' || l.quantity, '、' order by l.id) from ticket_lines l where l.ticket_id = t.id) items,
       t.note, t.requested_for, t.dispatched_at is not null dispatched,
       case when t.dispatched_at is null then t.requested_for - make_interval(mins => $5) end dispatch_at,
       t.check_requested_at, t.check_source, t.check_message, t.check_reply, t.check_replied_at, t.check_eta_at, t.check_reply_note, t.guest_nudges,
       coalesce(floor(extract(epoch from (now() - t.check_requested_at)) / 60), 0)::int check_waiting_minutes,
       exists (select 1 from handoffs h where h.ticket_id = t.id and h.kind = 'complaint' and h.status in ('open', 'accepted')) complaint,
       e.type last_event, e.reason last_reason
     from tickets t
     left join rooms r on r.hotel_id = t.hotel_id and r.id = t.room_id
     left join areas ra on ra.id = r.area_id
     left join slots s on s.id = t.slot_id
     left join job_roles sr on sr.id = s.job_role_id
     left join areas sa on sa.id = s.area_id
     left join members am on am.id = t.assignee_id
     left join members cm on cm.id = t.created_by
     left join lateral (select type, reason from ticket_events where ticket_id = t.id order by created_at desc limit 1) e on true
     where t.hotel_id = $1 and ($2::uuid is null or r.area_id = $2)
       and (t.status in ('new', 'doing') or (t.status = 'done' and (t.done_at at time zone $3)::date = $4::date))
     order by case when t.status = 'done' then t.done_at end desc nulls last, t.due_at`,
    [hotelId, areaId, hotel.timezone, localNow(hotel.timezone).date, hotel.order_schedule_lead_minutes],
  );
  const open = tickets.filter((t) => t.status !== "done");
  return {
    unassigned: open.filter((t) => !t.assignee_id),
    waiting: open.filter((t) => t.assignee_id && t.status === "new"),
    doing: open.filter((t) => t.assignee_id && t.status === "doing"),
    done: tickets.filter((t) => t.status === "done"),
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

// ---------- 上長による手動割り当て ----------

// 手動割り当て: 上長が担当者を選んで割り当てる。ほかの枠に出勤している人も選べ、その場合はチケットをその枠に移す
// （担当量の計算とボードの表示が、担当者の枠にそろうようにするため）
export async function assignManually(member: Member, ticketId: string, toMemberId: string, toSlotId: string) {
  const hotel = await getHotel(member.hotel_id);
  await transaction(async (client) => {
    const { rows } = await client.query<{ slot_id: string | null; room_number: string; assignee_id: string | null }>(
      "select slot_id, room_number, assignee_id from tickets where id = $1 and hotel_id = $2 and status in ('new', 'doing') for update",
      [ticketId, member.hotel_id],
    );
    const ticket = rows[0];
    if (!ticket) throw new Error("割り当てられるオーダーではありません");
    const { rows: ok } = await client.query<{ name: string; slot_label: string }>(
      `select m.display_name name, r.name || coalesce(' ' || a.name, '（全館）') slot_label
       from slot_shifts ss join members m on m.id = ss.member_id
       join slots s on s.id = ss.slot_id join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
       where ss.member_id = $1 and ss.slot_id = $2 and ss.work_date = $3 and ss.ended_at is null
         and m.hotel_id = $4 and m.active and has_permission(m.id, 'order.assignable', ss.slot_id)`,
      [toMemberId, toSlotId, localNow(hotel.timezone).date, member.hotel_id],
    );
    const target = ok[0];
    if (!target) throw new Error("この人はその枠に出勤していないか、担当になれません");
    const moved = ticket.slot_id !== toSlotId;
    await client.query(
      `update tickets set assignee_id = $2, slot_id = $3, assigned_at = now(), dispatched_at = coalesce(dispatched_at, now()), status = 'new', started_at = null,
         assignment_mode = 'manual',
         check_requested_at = null, check_source = null, check_requested_by = null, check_message = null,
         check_replied_at = null, check_reply = null, check_eta_at = null, check_reply_note = null
       where id = $1`,
      [ticketId, toMemberId, toSlotId],
    );
    const reason = `${member.display_name}が手動で割り当て${moved ? `（${target.slot_label}へ移動）` : ""}`;
    await client.query("insert into ticket_events (ticket_id, type, member_id, actor_id, reason) values ($1, 'reassigned', $2, $3, $4)", [
      ticketId, toMemberId, member.id, reason,
    ]);
    await client.query(
      "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_assigned', $2, $3, 'ticket', $4)",
      [toMemberId, `${ticket.room_number}号室のオーダー（手動割り当て）`, `${member.display_name}が割り当てました`, ticketId],
    );
    // 前の担当者が向かっている途中かもしれないため、対応不要を知らせる
    if (ticket.assignee_id && ticket.assignee_id !== toMemberId) {
      await client.query(
        "insert into notifications (member_id, kind, title, body, ref_type, ref_id) values ($1, 'ticket_released', $2, $3, 'ticket', $4)",
        [ticket.assignee_id, `${ticket.room_number}号室のオーダーは対応不要になりました`, `${member.display_name}が${target.name}に割り当て直しました`, ticketId],
      );
    }
    await notifySupervisors(client, member.hotel_id, `${ticket.room_number}号室のオーダーを手動で割り当て`, `${member.display_name}が${target.name}（${target.slot_label}）に割り当て`, ticketId);
  });
}

export type AssignCandidate = { id: string; name: string; slotId: string; slotLabel: string };

// 手動割り当ての候補: 今日出勤していて担当になれる人（枠ごと）。チケットの枠の人を先に出すのは画面で行う
export async function assignCandidates(hotelId: string): Promise<AssignCandidate[]> {
  const hotel = await getHotel(hotelId);
  return query<AssignCandidate>(
    `select m.id, m.display_name name, s.id "slotId", r.name || coalesce(' ' || a.name, '（全館）') "slotLabel"
     from slot_shifts ss join members m on m.id = ss.member_id
     join slots s on s.id = ss.slot_id join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
     where s.hotel_id = $2 and ss.work_date = $1 and ss.ended_at is null and m.active and has_permission(m.id, 'order.assignable', ss.slot_id)
     order by r.name, a.sort, a.name, m.display_name`,
    [localNow(hotel.timezone).date, hotelId],
  );
}

// 上長の操作の権限はチケットの枠で確かめる（画面から枠を受け取らない）
// ホテルが違うチケットは assignManually・requestCheckBySupervisor がホテルで絞って弾く
export async function ticketSlot(ticketId: string): Promise<string | undefined> {
  const rows = await query<{ slot_id: string | null }>("select slot_id from tickets where id = $1", [ticketId]);
  if (!rows[0]) throw new Error("オーダーが見つかりません");
  return rows[0].slot_id ?? undefined;
}

// 上長の操作（手動割り当て・担当者に確認）ができる枠
export async function reassignableSlots(memberId: string, hotelId: string): Promise<string[]> {
  const rows = await query<{ id: string }>("select id from slots where hotel_id = $1 and has_permission($2, 'order.reassign', id)", [hotelId, memberId]);
  return rows.map((r) => r.id);
}
