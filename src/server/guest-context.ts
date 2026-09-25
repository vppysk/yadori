import { queryOne } from "./db";

export type GuestContext = {
  reservationId: string;
  hotelId: string;
  guestName: string;
  roomNumber: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  planName: string | null;
};

// ゲスト文脈プロバイダ（plan 3章）。W4で予約・客室管理システムのモックMCP経由に置き換える。
// それまでは mock_pms を直接読むが、料金・支払い（読み取り不可の項目）は取らない
export async function getGuestContext(reservationId: string): Promise<GuestContext | undefined> {
  return queryOne<GuestContext>(
    `select id "reservationId", hotel_id "hotelId", guest_name "guestName", room_number "roomNumber",
       check_in "checkIn", check_out "checkOut", adults, plan_name "planName"
     from mock_pms.reservations where id = $1`,
    [reservationId],
  );
}
