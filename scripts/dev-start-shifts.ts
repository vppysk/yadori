// 開発用: デモのスタッフを今日出勤させる（本来は現場スマホで出勤する）。担当の役割・エリアは担当表（member_duties）で決まる
import { getHotel, localNow } from "@/server/hotel";
import { query } from "@/server/db";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  const hotel = await getHotel(HOTEL_ID);
  const today = localNow(hotel.timezone).date;
  // 佐藤・高橋・伊藤（ハウスキーピング）／ 山本（ルームサービス 全館）
  const rows = await query(
    `insert into member_shifts (member_id, work_date)
     select s.member_id::uuid, $1::date from (values
       ('00000000-0000-0000-0000-00000000a003'),
       ('00000000-0000-0000-0000-00000000a004'),
       ('00000000-0000-0000-0000-00000000a005'),
       ('00000000-0000-0000-0000-00000000a002')
     ) s (member_id)
     on conflict (member_id, work_date) do update set ended_at = null
     returning id`,
    [today],
  );
  // 山本（フロント）は「担当になれる」権限を持たないため、本日21時までの期限付きで付与する（plan 4.8 の応援の例）
  await query(
    `insert into member_permissions (member_id, permission_key, expires_at)
     select '00000000-0000-0000-0000-00000000a002', 'order.assignable', ($1::date + time '21:00') at time zone $2
     where not exists (
       select 1 from member_permissions where member_id = '00000000-0000-0000-0000-00000000a002' and permission_key = 'order.assignable' and expires_at > now()
     )`,
    [today, hotel.timezone],
  );
  console.log(`${today}: ${rows.length}件の出勤を登録`);
  process.exit(0);
}
main();
