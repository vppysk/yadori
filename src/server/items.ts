import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel } from "./hotel";
import type { ItemStatus } from "./orders";
import { tr } from "@/lib/i18n";

// オーダー管理のマスタ設定（plan 4.2、docs/005_order.md）: 品目設定（品目の分類・役割・重み・期限・取り扱いの状態、割り当ての設定）とエリア設定（エリアと部屋）。
// スタッフの担当（役割×エリア）は duties.ts

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

// 棟・フロアごとの部屋とエリア。area_ids が複数なら部屋ごとに違うエリア
export type FloorRow = { building: string | null; floor: number; rooms: number; area_ids: (string | null)[] };

export type ItemSettings = {
  items: ItemRow[];
  roles: { id: string; name: string }[];
  settings: { reassignMinutes: number; bundleEnabled: boolean; declineReasonRequired: boolean; scheduleLeadMinutes: number };
  suggestions: string[];
};

const WEIGHT_LABEL = { 1: tr("軽", "Light"), 2: tr("中", "Medium"), 3: tr("重", "Heavy") } as const;
// 見直しの提案を出す最低の実測件数
const MIN_SAMPLES = 3;

export async function getItemSettings(hotelId: string): Promise<ItemSettings> {
  const hotel = await getHotel(hotelId);
  const [items, roles] = await Promise.all([
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
  ]);
  return {
    items,
    roles,
    settings: {
      reassignMinutes: hotel.order_reassign_minutes,
      bundleEnabled: hotel.order_bundle_enabled,
      declineReasonRequired: hotel.order_decline_reason_required,
      scheduleLeadMinutes: hotel.order_schedule_lead_minutes,
    },
    suggestions: suggest(items),
  };
}

export type AreaSettings = { areas: { id: string; name: string; rooms: number; duties: number }[]; floors: FloorRow[] };

// エリア設定: エリアと、棟・フロアごとの部屋のエリア
export async function getAreaSettings(hotelId: string): Promise<AreaSettings> {
  const [areas, floors] = await Promise.all([
    query<AreaSettings["areas"][number]>(
      `select a.id, a.name, (select count(*)::int from rooms r where r.area_id = a.id) rooms,
         (select count(*)::int from member_duties d where d.area_id = a.id) duties
       from areas a where a.hotel_id = $1 order by a.sort, a.name`,
      [hotelId],
    ),
    query<FloorRow>(
      `select building, floor, count(*)::int rooms, array_agg(distinct area_id) area_ids
       from rooms where hotel_id = $1 group by building, floor order by building nulls first, floor`,
      [hotelId],
    ),
  ]);
  return { areas, floors };
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
      out.push(
        tr(
          `${item.name}は実測の平均（${item.actual_minutes}分）が「${WEIGHT_LABEL[best]}」の品目と同程度です。「${WEIGHT_LABEL[best]}」に変更すると割り当てがより均等になります。`,
          `${item.name} takes ${item.actual_minutes} min on average, similar to \"${WEIGHT_LABEL[best]}\" items. Changing it to \"${WEIGHT_LABEL[best]}\" would balance assignments better.`,
        ),
      );
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
      const category = item.category.trim().slice(0, 20) || tr("その他", "Other");
      if (![1, 2, 3].includes(item.weight) || item.due_minutes < 1 || item.due_minutes > 600) throw new Error(tr(`「${name}」の重みか期限を確認してください`, `Check the weight or due time of \"${name}\"`));
      if (!STATUSES.includes(item.status)) throw new Error(tr(`「${name}」の状態を確認してください`, `Check the status of \"${name}\"`));
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
    if (s.reassignMinutes < 1 || s.reassignMinutes > 120) throw new Error(tr("次の人へ回すまでの時間は1〜120分にしてください", "Pass-on time must be 1–120 min"));
    if (s.scheduleLeadMinutes < 0 || s.scheduleLeadMinutes > 240) throw new Error(tr("時間指定の割り当ては0〜240分前にしてください", "Scheduled assignment must be 0–240 min before"));
    await client.query(
      "update hotels set order_reassign_minutes = $2, order_bundle_enabled = $3, order_decline_reason_required = $4, order_schedule_lead_minutes = $5 where id = $1",
      [member.hotel_id, s.reassignMinutes, s.bundleEnabled, s.declineReasonRequired, s.scheduleLeadMinutes],
    );
  });
}

export async function addArea(member: Member, name: string) {
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new Error(tr("エリア名を入力してください", "Please enter an area name"));
  await query(
    "insert into areas (hotel_id, name, sort) select $1, $2, coalesce(max(sort), 0) + 1 from areas where hotel_id = $1",
    [member.hotel_id, trimmed],
  );
}

export async function deleteArea(member: Member, areaId: string) {
  const [{ n }] = await query<{ n: number }>("select count(*)::int n from member_duties where area_id = $1", [areaId]);
  if (n > 0) throw new Error(tr("スタッフの担当で使っているエリアは削除できません。先に担当設定で外してください", "This area is used in staff duties. Remove it in Duties first"));
  await query("delete from areas where id = $1 and hotel_id = $2", [areaId, member.hotel_id]);
}

// 棟・フロアの部屋をまとめてエリアに入れる（areaId が null ならエリアなし＝全館の担当だけが受ける）
export async function setFloorArea(member: Member, building: string | null, floor: number, areaId: string | null) {
  if (areaId) {
    const rows = await query("select 1 from areas where id = $1 and hotel_id = $2", [areaId, member.hotel_id]);
    if (rows.length === 0) throw new Error(tr("エリアが見つかりません", "Area not found"));
  }
  await query("update rooms set area_id = $4 where hotel_id = $1 and building is not distinct from $2 and floor = $3", [
    member.hotel_id, building, floor, areaId,
  ]);
}
