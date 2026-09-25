// 開発用: デモのスタッフを今日の枠に出勤させる（本来は現場スマホで出勤時に選ぶ）
import { getHotel, localNow } from "@/server/hotel";
import { query } from "@/server/db";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  const hotel = await getHotel(HOTEL_ID);
  const today = localNow(hotel.timezone).date;
  // ハウスキーピング 12〜15F: 佐藤・高橋・伊藤 ／ ルームサービス: 山本
  const rows = await query(
    `insert into slot_shifts (slot_id, member_id, work_date)
     select s.slot_id::uuid, s.member_id::uuid, $1::date from (values
       ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000a003'),
       ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000a004'),
       ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000a005'),
       ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-00000000a002')
     ) s (slot_id, member_id)
     on conflict (slot_id, member_id, work_date) do nothing
     returning id`,
    [today],
  );
  // 山本（フロント）はルームサービスの担当権限を持たないため、本日21時までの期限付きで付与する（plan 4.8 の応援の例）
  await query(
    `insert into member_permissions (member_id, permission_key, scope_ids, expires_at)
     select '00000000-0000-0000-0000-00000000a002', 'order.assignable', array['00000000-0000-0000-0000-00000000e003'::uuid],
       ($1::date + time '21:00') at time zone $2
     where not exists (
       select 1 from member_permissions where member_id = '00000000-0000-0000-0000-00000000a002' and permission_key = 'order.assignable' and expires_at > now()
     )`,
    [today, hotel.timezone],
  );
  console.log(`${today}: ${rows.length}件の出勤を登録`);
  process.exit(0);
}
main();
