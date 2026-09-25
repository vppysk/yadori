import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel, localNow } from "./hotel";

// 品目・担当設定（plan 4.2）: 品目ごとの役割・重み・期限、割り当ての設定、担当の枠（役割×エリア）

export type ItemRow = {
  id: string | null;
  name: string;
  aliases: string[];
  job_role_id: string;
  weight: 1 | 2 | 3;
  due_minutes: number;
  active: boolean;
  actual_minutes: number | null; // 実測の平均（着手〜完了）
  samples: number;
};

export type ItemSettings = {
  items: ItemRow[];
  roles: { id: string; name: string }[];
  areas: { id: string; name: string }[];
  slots: { id: string; label: string; job_role_id: string; area_id: string | null; members: number; open_tickets: number }[];
  settings: { reassignMinutes: number; bundleEnabled: boolean; declineReasonRequired: boolean };
  suggestions: string[];
};

const WEIGHT_LABEL = { 1: "軽", 2: "中", 3: "重" } as const;
// 見直しの提案を出す最低の実測件数
const MIN_SAMPLES = 3;

export async function getItemSettings(hotelId: string): Promise<ItemSettings> {
  const hotel = await getHotel(hotelId);
  const [items, roles, areas, slots] = await Promise.all([
    query<ItemRow>(
      `select i.id, i.name, i.aliases, i.job_role_id, i.weight, i.due_minutes, i.active,
         round(avg(extract(epoch from (t.done_at - t.started_at)) / 60)::numeric, 1)::float actual_minutes,
         count(t.id)::int samples
       from order_items i
       left join ticket_lines l on l.order_item_id = i.id
       left join tickets t on t.id = l.ticket_id and t.done_at is not null and t.started_at is not null
       where i.hotel_id = $1 group by i.id order by i.sort, i.name`,
      [hotelId],
    ),
    query<{ id: string; name: string }>("select id, name from job_roles where hotel_id = $1 order by name", [hotelId]),
    query<{ id: string; name: string }>("select id, name from areas where hotel_id = $1 order by floor_from", [hotelId]),
    query<ItemSettings["slots"][number]>(
      `select s.id, r.name || coalesce(' ' || a.name, '（全館）') label, s.job_role_id, s.area_id,
         (select count(*)::int from slot_shifts ss where ss.slot_id = s.id and ss.work_date = $2 and ss.ended_at is null) members,
         (select count(*)::int from tickets t where t.slot_id = s.id and t.status in ('new', 'doing')) open_tickets
       from slots s join job_roles r on r.id = s.job_role_id left join areas a on a.id = s.area_id
       where s.hotel_id = $1 order by r.name, a.floor_from`,
      [hotelId, localNow(hotel.timezone).date],
    ),
  ]);
  return {
    items,
    roles,
    areas,
    slots,
    settings: { reassignMinutes: hotel.order_reassign_minutes, bundleEnabled: hotel.order_bundle_enabled, declineReasonRequired: hotel.order_decline_reason_required },
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
  items: { id: string | null; name: string; aliases: string[]; job_role_id: string; weight: number; due_minutes: number; active: boolean }[];
  settings: ItemSettings["settings"];
};

export async function saveItemSettings(member: Member, input: SaveItemsInput) {
  await transaction(async (client) => {
    for (const [sort, item] of input.items.entries()) {
      const name = item.name.trim().slice(0, 40);
      if (!name) continue;
      if (![1, 2, 3].includes(item.weight) || item.due_minutes < 1 || item.due_minutes > 600) throw new Error(`「${name}」の重みか期限を確認してください`);
      const aliases = item.aliases.map((a) => a.trim()).filter(Boolean).slice(0, 20);
      if (item.id) {
        await client.query(
          "update order_items set name = $3, aliases = $4, job_role_id = $5, weight = $6, due_minutes = $7, active = $8, sort = $9 where id = $1 and hotel_id = $2",
          [item.id, member.hotel_id, name, aliases, item.job_role_id, item.weight, item.due_minutes, item.active, sort],
        );
      } else {
        await client.query(
          "insert into order_items (hotel_id, name, aliases, job_role_id, weight, due_minutes, active, sort) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [member.hotel_id, name, aliases, item.job_role_id, item.weight, item.due_minutes, item.active, sort],
        );
      }
    }
    const s = input.settings;
    if (s.reassignMinutes < 1 || s.reassignMinutes > 120) throw new Error("次の人へ回すまでの時間は1〜120分にしてください");
    await client.query(
      "update hotels set order_reassign_minutes = $2, order_bundle_enabled = $3, order_decline_reason_required = $4 where id = $1",
      [member.hotel_id, s.reassignMinutes, s.bundleEnabled, s.declineReasonRequired],
    );
  });
}

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
  await query("delete from slots where id = $1 and hotel_id = $2", [slotId, member.hotel_id]);
}
