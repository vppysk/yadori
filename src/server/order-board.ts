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
  area_id: string | null; // 部屋のエリア（担当の候補と、上長の権限の範囲を決める）
  area_name: string | null;
  job_role_id: string | null;
  role_name: string | null;
  can_reassign: boolean; // 見ている人が手動割り当て・担当者に確認をできるか
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

// areaId: 部屋のエリアで絞り込む（null はすべて）。viewerId: 見ている人（操作できるかを判定する）
export async function getBoard(hotelId: string, areaId: string | null, viewerId: string): Promise<Board> {
  const hotel = await getHotel(hotelId);
  const tickets = await query<BoardTicket>(
    `select t.id, t.room_number, t.area_id, ra.name area_name, t.job_role_id, jr.name role_name,
       has_permission($6, 'order.reassign', t.area_id) can_reassign,
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
     left join areas ra on ra.id = t.area_id
     left join job_roles jr on jr.id = t.job_role_id
     left join members am on am.id = t.assignee_id
     left join members cm on cm.id = t.created_by
     left join lateral (select type, reason from ticket_events where ticket_id = t.id order by created_at desc limit 1) e on true
     where t.hotel_id = $1 and ($2::uuid is null or t.area_id = $2)
       and (t.status in ('new', 'doing') or (t.status = 'done' and (t.done_at at time zone $3)::date = $4::date))
     order by case when t.status = 'done' then t.done_at end desc nulls last, t.due_at`,
    [hotelId, areaId, hotel.timezone, localNow(hotel.timezone).date, hotel.order_schedule_lead_minutes, viewerId],
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

export type AssignmentPreview = { dutyLabel: string; assigneeName: string | null; reason: string | null }[];

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
      const { rows } = await client.query<{ label: string }>(
        "select r.name || coalesce(' ' || a.name, '') label from job_roles r left join areas a on a.id = $2 where r.id = $1",
        [roleId, room.area_id],
      );
      const next = await pickAssignee(client, hotel, { job_role_id: roleId, area_id: room.area_id }, room);
      result.push({ dutyLabel: rows[0]?.label ?? "", assigneeName: next?.name ?? null, reason: next?.reason ?? null });
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

// 手動割り当て: 上長が今日出勤している担当者を選んで割り当てる。チケットの役割・エリアの担当でない人も選べる（応援）
export async function assignManually(member: Member, ticketId: string, toMemberId: string) {
  const hotel = await getHotel(member.hotel_id);
  await transaction(async (client) => {
    const { rows } = await client.query<{ job_role_id: string | null; area_id: string | null; room_number: string; assignee_id: string | null }>(
      "select job_role_id, area_id, room_number, assignee_id from tickets where id = $1 and hotel_id = $2 and status in ('new', 'doing') for update",
      [ticketId, member.hotel_id],
    );
    const ticket = rows[0];
    if (!ticket) throw new Error("割り当てられるオーダーではありません");
    const { rows: ok } = await client.query<{ name: string; on_duty: boolean }>(
      `select m.display_name name,
         exists (select 1 from member_duties d where d.member_id = m.id and d.job_role_id = $4 and (d.area_id is null or d.area_id = $5)) on_duty
       from member_shifts sh join members m on m.id = sh.member_id
       where sh.member_id = $1 and sh.work_date = $2 and sh.ended_at is null and m.hotel_id = $3 and m.active and has_permission(m.id, 'order.assignable')`,
      [toMemberId, localNow(hotel.timezone).date, member.hotel_id, ticket.job_role_id, ticket.area_id],
    );
    const target = ok[0];
    if (!target) throw new Error("この人は今日出勤していないか、担当になれません");
    await client.query(
      `update tickets set assignee_id = $2, assigned_at = now(), dispatched_at = coalesce(dispatched_at, now()), status = 'new', started_at = null,
         assignment_mode = 'manual',
         check_requested_at = null, check_source = null, check_requested_by = null, check_message = null,
         check_replied_at = null, check_reply = null, check_eta_at = null, check_reply_note = null
       where id = $1`,
      [ticketId, toMemberId],
    );
    const reason = `${member.display_name}が手動で割り当て${target.on_duty ? "" : "（担当外）"}`;
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
    await notifySupervisors(client, member.hotel_id, `${ticket.room_number}号室のオーダーを手動で割り当て`, `${member.display_name}が${target.name}に割り当て`, ticketId);
  });
}

export type AssignCandidate = { id: string; name: string; duties: { jobRoleId: string; areaId: string | null }[]; dutyLabel: string };

// 手動割り当ての候補: 今日出勤していて担当になれる人と、その担当。チケットの担当の人を先に出すのは画面で行う
export async function assignCandidates(hotelId: string): Promise<AssignCandidate[]> {
  const hotel = await getHotel(hotelId);
  return query<AssignCandidate>(
    `select m.id, m.display_name name,
       coalesce(json_agg(json_build_object('jobRoleId', d.job_role_id, 'areaId', d.area_id)) filter (where d.member_id is not null), '[]') duties,
       coalesce(string_agg(r.name || ' ' || coalesce(a.name, '全館'), '、' order by r.name, a.sort nulls first), '担当なし') "dutyLabel"
     from member_shifts sh join members m on m.id = sh.member_id
     left join member_duties d on d.member_id = m.id
     left join job_roles r on r.id = d.job_role_id left join areas a on a.id = d.area_id
     where m.hotel_id = $2 and sh.work_date = $1 and sh.ended_at is null and m.active and has_permission(m.id, 'order.assignable')
     group by m.id order by m.display_name`,
    [localNow(hotel.timezone).date, hotelId],
  );
}

// 上長の操作の権限はチケットのエリアで確かめる（画面から受け取らない）
// ホテルが違うチケットは assignManually・requestCheckBySupervisor がホテルで絞って弾く
export async function ticketArea(ticketId: string): Promise<string | undefined> {
  const rows = await query<{ area_id: string | null }>("select area_id from tickets where id = $1", [ticketId]);
  if (!rows[0]) throw new Error("オーダーが見つかりません");
  return rows[0].area_id ?? undefined;
}
