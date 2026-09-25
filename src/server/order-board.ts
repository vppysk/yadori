import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { getHotel, localNow } from "./hotel";
import { listFacilityNames } from "./knowledge";
import { recordLlmCall, recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, pickAssignee, roomFloor, type CreatedTicket } from "./orders";
import { route } from "./router";
import { notifySupervisors } from "./staff-work";

// 管理PCのオーダーボード（plan 4.2）: 枠ごとの担当者別ボード、要対応、フロントでの電話・来訪オーダーの登録、上長による付け替え

export type SlotSummary = { id: string; label: string; members: number };

export async function listSlots(hotelId: string): Promise<SlotSummary[]> {
  const hotel = await getHotel(hotelId);
  return query<SlotSummary>(
    `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label,
       (select count(*)::int from slot_shifts ss where ss.slot_id = s.id and ss.work_date = $2 and ss.ended_at is null) members
     from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
     where s.hotel_id = $1 order by r.name, a.floor_from`,
    [hotelId, localNow(hotel.timezone).date],
  );
}

export type BoardTicket = {
  id: string;
  room_number: string;
  status: "new" | "doing";
  weight: number;
  items: string;
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
export type Board = { attention: BoardTicket[]; columns: BoardColumn[]; averagePoints: number };

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
         e.type last_event, e.reason last_reason
       from tickets t
       left join members am on am.id = t.assignee_id
       left join members cm on cm.id = t.created_by
       left join lateral (select type, reason from ticket_events where ticket_id = t.id order by created_at desc limit 1) e on true
       where t.hotel_id = $1 and t.slot_id = $2 and t.status in ('new', 'doing')
       order by t.due_at`,
      [hotelId, slotId],
    ),
  ]);
  // 要対応: 期限超過、担当者なし、直近に自動で付け替えたもの（「対応できない」・着手されなかった）。上長が手で付け替えたものは担当者の列に出す
  const autoReassigned = (t: BoardTicket) => t.last_event === "reassigned" && !(t.last_reason ?? "").endsWith("が付け替え");
  const needsAttention = (t: BoardTicket) => t.overdue_minutes > 0 || !t.assignee_id || autoReassigned(t);
  const columns = members.map((m) => ({
    memberId: m.member_id,
    name: m.name,
    points: m.points,
    tickets: tickets.filter((t) => t.assignee_id === m.member_id && !needsAttention(t)),
  }));
  return {
    attention: tickets.filter(needsAttention),
    columns,
    averagePoints: members.length ? members.reduce((a, m) => a + m.points, 0) / members.length : 0,
  };
}

// ---------- フロントでの登録（電話・来訪） ----------

export type OrderPreview = {
  items: { item: string; label: string; quantity: number; weight: number }[];
  unsupported: string[];
  slots: { slotLabel: string; assigneeName: string | null; reason: string | null }[];
};

// AIの読み取りと割り当て予定の確認（保存しない）
export async function previewOrder(member: Member, roomNumber: string, text: string): Promise<OrderPreview> {
  const hotel = await getHotel(member.hotel_id);
  const [catalog, facilityNames] = await Promise.all([getCatalog(hotel.id), listFacilityNames(hotel.id)]);
  const routed = await route(text, catalog, facilityNames);
  await recordLlmCall({ hotelId: hotel.id, purpose: "router", pattern: "order", thinking: false, usage: routed.usage });
  const items = routed.result.intents.flatMap((i) => i.items ?? []);
  const unsupported = routed.result.intents.flatMap((i) => i.unsupported_items ?? []);

  // 割り当て予定は、実際の割り当てと同じ選び方（pickAssignee。読み取りのみ）で求める
  const slots = await transaction(async (client) => {
    const floor = await roomFloor(client, hotel.id, roomNumber);
    const roles = [...new Set(items.map((l) => catalog.find((c) => c.name === l.item)!.job_role_id))];
    const result: OrderPreview["slots"] = [];
    for (const roleId of roles) {
      const { rows } = await client.query<{ id: string; label: string }>(
        `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
         where s.hotel_id = $1 and s.job_role_id = $2 and (s.area_id is null or $3::int between a.floor_from and a.floor_to)
         order by s.area_id is null limit 1`,
        [hotel.id, roleId, floor],
      );
      const slot = rows[0];
      const next = slot ? await pickAssignee(client, hotel, slot.id, floor) : undefined;
      result.push({ slotLabel: slot?.label ?? "担当の枠がありません", assigneeName: next?.name ?? null, reason: next?.reason ?? null });
    }
    return result;
  });
  return {
    items: items.map((l) => ({ item: l.item, label: l.label, quantity: l.quantity, weight: catalog.find((c) => c.name === l.item)?.weight ?? 1 })),
    unsupported,
    slots,
  };
}

export async function registerOrder(
  member: Member,
  input: { roomNumber: string; text: string; source: "phone" | "front_desk" | "other"; items: { item: string; label: string; quantity: number }[] },
): Promise<CreatedTicket[]> {
  const hotel = await getHotel(member.hotel_id);
  const room = await queryOne<{ room_number: string }>("select room_number from rooms where hotel_id = $1 and room_number = $2", [hotel.id, input.roomNumber]);
  if (!room) throw new Error("部屋番号が見つかりません");
  if (input.items.length === 0) throw new Error("品目マスタにある品目がありません");
  const tickets = await transaction((client) =>
    createTickets(client, { hotel, roomNumber: input.roomNumber, lines: input.items, source: input.source, rawText: input.text, createdBy: member.id }),
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
    await client.query("update tickets set assignee_id = $2, assigned_at = now(), status = 'new', started_at = null where id = $1", [ticketId, toMemberId]);
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
