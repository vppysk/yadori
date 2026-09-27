import type { PoolClient } from "pg";
import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel, localNow } from "./hotel";
import type { ItemStatus } from "./orders";

// 品目・担当設定（plan 4.2、docs/005_order.md）: 品目の分類・役割・重み・期限・取り扱いの状態、割り当ての設定、
// 担当の枠（役割×エリア）と担当席の人数、エリアと部屋

export type ItemRow = {
  id: string | null;
  category: string;
  name: string;
  aliases: string[];
  job_role_id: string;
  weight: 1 | 2 | 3;
  due_minutes: number;
  status: ItemStatus;
  actual_minutes: number | null; // 実測の平均（着手〜完了）
  samples: number;
};

export type SlotRow = { id: string; label: string; job_role_id: string; area_id: string | null; members: number; seats: number; open_tickets: number };

// 棟・フロアごとの部屋とエリア。area_ids が複数なら部屋ごとに違うエリア
export type FloorRow = { building: string | null; floor: number; rooms: number; area_ids: (string | null)[] };

export type ItemSettings = {
  items: ItemRow[];
  roles: { id: string; name: string }[];
  areas: { id: string; name: string; rooms: number; slots: number }[];
  floors: FloorRow[];
  slots: SlotRow[];
  settings: { reassignMinutes: number; bundleEnabled: boolean; declineReasonRequired: boolean; scheduleLeadMinutes: number };
  suggestions: string[];
};

const WEIGHT_LABEL = { 1: "軽", 2: "中", 3: "重" } as const;
// 見直しの提案を出す最低の実測件数
const MIN_SAMPLES = 3;
const MAX_SEATS = 20;

const SLOT_LABEL = "r.name || coalesce(' ' || a.name, '（全館）')";

export async function getItemSettings(hotelId: string): Promise<ItemSettings> {
  const hotel = await getHotel(hotelId);
  const [items, roles, areas, floors, slots] = await Promise.all([
    query<ItemRow>(
      `select i.id, i.category, i.name, i.aliases, i.job_role_id, i.weight, i.due_minutes, i.status,
         round(avg(extract(epoch from (t.done_at - t.started_at)) / 60)::numeric, 1)::float actual_minutes,
         count(t.id)::int samples
       from order_items i
       left join ticket_lines l on l.order_item_id = i.id
       left join tickets t on t.id = l.ticket_id and t.done_at is not null and t.started_at is not null
       where i.hotel_id = $1 group by i.id order by i.sort, i.name`,
      [hotelId],
    ),
    query<{ id: string; name: string }>("select id, name from job_roles where hotel_id = $1 order by name", [hotelId]),
    query<ItemSettings["areas"][number]>(
      `select a.id, a.name, (select count(*)::int from rooms r where r.area_id = a.id) rooms,
         (select count(*)::int from slots s where s.area_id = a.id) slots
       from areas a where a.hotel_id = $1 order by a.sort, a.name`,
      [hotelId],
    ),
    query<FloorRow>(
      `select building, floor, count(*)::int rooms, array_agg(distinct area_id) area_ids
       from rooms where hotel_id = $1 group by building, floor order by building nulls first, floor`,
      [hotelId],
    ),
    query<SlotRow>(
      `select s.id, ${SLOT_LABEL} label, s.job_role_id, s.area_id,
         (select count(*)::int from slot_shifts ss where ss.slot_id = s.id and ss.work_date = $2 and ss.ended_at is null) members,
         (select count(*)::int from members m where m.seat_slot_id = s.id and m.active) seats,
         (select count(*)::int from tickets t where t.slot_id = s.id and t.status in ('new', 'doing')) open_tickets
       from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
       where s.hotel_id = $1 order by r.name, a.sort, a.name`,
      [hotelId, localNow(hotel.timezone).date],
    ),
  ]);
  return {
    items,
    roles,
    areas,
    floors,
    slots,
    settings: {
      reassignMinutes: hotel.order_reassign_minutes,
      bundleEnabled: hotel.order_bundle_enabled,
      declineReasonRequired: hotel.order_decline_reason_required,
      scheduleLeadMinutes: hotel.order_schedule_lead_minutes,
    },
    suggestions: suggest(items),
  };
}

// 想定（重み）と実測のずれの指摘（plan 4.2「実績の対応時間から重みの妥当性を検証」）。
// 重みごとの実測平均と比べて、別の重みの平均の方が近い品目を挙げる
function suggest(items: ItemRow[]): string[] {
  const measured = items.filter((i) => i.actual_minutes !== null && i.samples >= MIN_SAMPLES);
  const levelMean = ([1, 2, 3] as const).map((w) => {
    const xs = measured.filter((i) => i.weight === w).map((i) => i.actual_minutes!);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  });
  const out: string[] = [];
  for (const item of measured) {
    const distances = levelMean.map((m, i) => (m === null ? Infinity : Math.abs(item.actual_minutes! - m) + (i + 1 === item.weight ? 0 : 0.01)));
    const best = (distances.indexOf(Math.min(...distances)) + 1) as 1 | 2 | 3;
    if (best !== item.weight) {
      out.push(`${item.name}は実測の平均（${item.actual_minutes}分）が「${WEIGHT_LABEL[best]}」の品目と同程度です。「${WEIGHT_LABEL[best]}」に変更すると割り当てがより均等になります。`);
    }
  }
  return out;
}

export type SaveItemsInput = {
  items: { id: string | null; category: string; name: string; aliases: string[]; job_role_id: string; weight: number; due_minutes: number; status: ItemStatus }[];
  settings: ItemSettings["settings"];
};

const STATUSES: ItemStatus[] = ["available", "paused", "retired"];

export async function saveItemSettings(member: Member, input: SaveItemsInput) {
  await transaction(async (client) => {
    for (const [sort, item] of input.items.entries()) {
      const name = item.name.trim().slice(0, 40);
      if (!name) continue;
      const category = item.category.trim().slice(0, 20) || "その他";
      if (![1, 2, 3].includes(item.weight) || item.due_minutes < 1 || item.due_minutes > 600) throw new Error(`「${name}」の重みか期限を確認してください`);
      if (!STATUSES.includes(item.status)) throw new Error(`「${name}」の状態を確認してください`);
      const aliases = item.aliases.map((a) => a.trim()).filter(Boolean).slice(0, 20);
      if (item.id) {
        await client.query(
          "update order_items set category = $3, name = $4, aliases = $5, job_role_id = $6, weight = $7, due_minutes = $8, status = $9, sort = $10 where id = $1 and hotel_id = $2",
          [item.id, member.hotel_id, category, name, aliases, item.job_role_id, item.weight, item.due_minutes, item.status, sort],
        );
      } else {
        await client.query(
          "insert into order_items (hotel_id, category, name, aliases, job_role_id, weight, due_minutes, status, sort) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [member.hotel_id, category, name, aliases, item.job_role_id, item.weight, item.due_minutes, item.status, sort],
        );
      }
    }
    const s = input.settings;
    if (s.reassignMinutes < 1 || s.reassignMinutes > 120) throw new Error("次の人へ回すまでの時間は1〜120分にしてください");
    if (s.scheduleLeadMinutes < 0 || s.scheduleLeadMinutes > 240) throw new Error("時間指定の割り当ては0〜240分前にしてください");
    await client.query(
      "update hotels set order_reassign_minutes = $2, order_bundle_enabled = $3, order_decline_reason_required = $4, order_schedule_lead_minutes = $5 where id = $1",
      [member.hotel_id, s.reassignMinutes, s.bundleEnabled, s.declineReasonRequired, s.scheduleLeadMinutes],
    );
  });
}

// ---------- 担当の枠と担当席 ----------

export async function addSlot(member: Member, jobRoleId: string, areaId: string | null) {
  await query(
    `insert into slots (hotel_id, job_role_id, area_id)
     select $1, r.id, $3 from job_roles r where r.id = $2 and r.hotel_id = $1
     on conflict do nothing`,
    [member.hotel_id, jobRoleId, areaId],
  );
}

export async function deleteSlot(member: Member, slotId: string) {
  const [{ n }] = await query<{ n: number }>("select count(*)::int n from tickets where slot_id = $1 and status in ('new', 'doing')", [slotId]);
  if (n > 0) throw new Error("対応中のオーダーがある枠は削除できません");
  await transaction(async (client) => {
    // 担当席はチケットの履歴から参照されるため消さずに無効にする
    await client.query("update members set active = false where seat_slot_id = $1 and hotel_id = $2", [slotId, member.hotel_id]);
    await client.query("delete from slots where id = $1 and hotel_id = $2", [slotId, member.hotel_id]);
  });
}

const seatMark = (n: number) => String.fromCharCode(0x2460 + n - 1); // ①②③…

// 担当席（docs/005_order.md 3章）: 枠の人数分、その枠の共有アカウントを作る。
// 席はその枠だけの「担当になれる」と、AIに相談・引き継ぎに対応を個別に持つ。減らすと番号の大きい席から無効にする
export async function setSeats(member: Member, slotId: string, count: number) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_SEATS) throw new Error(`人数は0〜${MAX_SEATS}にしてください`);
  await transaction(async (client) => {
    const { rows: slots } = await client.query<{ label: string; role: string }>(
      `select ${SLOT_LABEL} label, r.name role from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
       where s.id = $1 and s.hotel_id = $2`,
      [slotId, member.hotel_id],
    );
    const slot = slots[0];
    if (!slot) throw new Error("枠が見つかりません");
    const { rows: seats } = await client.query<{ id: string; seat_no: number; active: boolean; open_tickets: number }>(
      `select m.id, m.seat_no, m.active,
         (select count(*)::int from tickets t where t.assignee_id = m.id and t.status in ('new', 'doing')) open_tickets
       from members m where m.seat_slot_id = $1 order by m.seat_no for update`,
      [slotId],
    );
    for (const seat of seats.filter((s) => s.seat_no > count && s.active)) {
      if (seat.open_tickets > 0) throw new Error(`${seatMark(seat.seat_no)}の席に未完了のオーダーがあります。先に付け替えてください`);
      await client.query("update members set active = false where id = $1", [seat.id]);
      await client.query("update slot_shifts set ended_at = now() where member_id = $1 and ended_at is null", [seat.id]);
    }
    for (let n = 1; n <= count; n++) {
      const name = `${slot.label} ${seatMark(n)}`;
      const existing = seats.find((s) => s.seat_no === n);
      if (existing) {
        await client.query("update members set active = true, display_name = $2 where id = $1", [existing.id, name]);
      } else {
        await createSeat(client, member, slotId, n, name, slot.role);
      }
    }
  });
}

async function createSeat(client: PoolClient, actor: Member, slotId: string, seatNo: number, name: string, jobTitle: string) {
  const { rows } = await client.query<{ id: string }>(
    "insert into members (hotel_id, kind, display_name, job_title, seat_slot_id, seat_no) values ($1, 'human', $2, $3, $4, $5) returning id",
    [actor.hotel_id, name, jobTitle, slotId, seatNo],
  );
  await client.query(
    `insert into member_permissions (member_id, permission_key, scope_ids, granted_by)
     select $1, k, case when k = 'order.assignable' then array[$2::uuid] end, $3
     from unnest(array['order.assignable', 'handling.consult', 'handling.handoff.accept']) k`,
    [rows[0].id, slotId, actor.id],
  );
}

// ---------- エリアと部屋 ----------

export async function addArea(member: Member, name: string) {
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new Error("エリア名を入力してください");
  await query(
    "insert into areas (hotel_id, name, sort) select $1, $2, coalesce(max(sort), 0) + 1 from areas where hotel_id = $1",
    [member.hotel_id, trimmed],
  );
}

export async function deleteArea(member: Member, areaId: string) {
  const [{ n }] = await query<{ n: number }>("select count(*)::int n from slots where area_id = $1", [areaId]);
  if (n > 0) throw new Error("担当の枠で使っているエリアは削除できません。先に枠を削除してください");
  await query("delete from areas where id = $1 and hotel_id = $2", [areaId, member.hotel_id]);
}

// 棟・フロアの部屋をまとめてエリアに入れる（areaId が null ならエリアなし＝全館担当の枠だけが受ける）
export async function setFloorArea(member: Member, building: string | null, floor: number, areaId: string | null) {
  if (areaId) {
    const rows = await query("select 1 from areas where id = $1 and hotel_id = $2", [areaId, member.hotel_id]);
    if (rows.length === 0) throw new Error("エリアが見つかりません");
  }
  await query("update rooms set area_id = $4 where hotel_id = $1 and building is not distinct from $2 and floor = $3", [
    member.hotel_id, building, floor, areaId,
  ]);
}
