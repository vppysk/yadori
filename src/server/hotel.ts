import { query, queryOne } from "./db";

export type Pattern = "info" | "order" | "external" | "reservation" | "complaint";

export type Hotel = {
  id: string;
  name: string;
  timezone: string;
  fx_usd_jpy: string;
  order_reassign_minutes: number;
  order_bundle_enabled: boolean;
  order_decline_reason_required: boolean;
  // 希望日時のあるオーダーを、その何分前に割り当てるか（docs/005_order.md 5章）
  order_schedule_lead_minutes: number;
};

export async function getHotel(hotelId: string): Promise<Hotel> {
  const hotel = await queryOne<Hotel>(
    "select id, name, timezone, fx_usd_jpy, order_reassign_minutes, order_bundle_enabled, order_decline_reason_required, order_schedule_lead_minutes from hotels where id = $1",
    [hotelId],
  );
  if (!hotel) throw new Error(`ホテルが見つかりません: ${hotelId}`);
  return hotel;
}

// ホテル現地の日付（YYYY-MM-DD）と時刻（HH:MM）
export function localNow(timezone: string, at = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

type TimeBand = { id: string; name: string; starts_at: string; ends_at: string };

// 時刻を含む時間帯。starts_at > ends_at は日をまたぐ帯
export async function currentTimeBand(hotel: Hotel, at = new Date()): Promise<TimeBand | undefined> {
  const bands = await query<TimeBand>(
    "select id, name, to_char(starts_at, 'HH24:MI') starts_at, to_char(ends_at, 'HH24:MI') ends_at from time_bands where hotel_id = $1 order by sort",
    [hotel.id],
  );
  const { time } = localNow(hotel.timezone, at);
  return bands.find((b) =>
    b.starts_at <= b.ends_at ? time >= b.starts_at && time < b.ends_at : time >= b.starts_at || time < b.ends_at,
  );
}

export type Assignment = { handler: "human" | "small" | "medium" | "large"; thinking: boolean };

// パターン×時間帯のAI担当（plan 4.3）。未設定なら小型モデル
export async function getAssignment(hotelId: string, pattern: Pattern, timeBandId?: string): Promise<Assignment> {
  if (!timeBandId) return { handler: "small", thinking: false };
  const row = await queryOne<Assignment>(
    "select handler, thinking from ai_assignments where hotel_id = $1 and pattern = $2 and time_band_id = $3",
    [hotelId, pattern, timeBandId],
  );
  return row ?? { handler: "small", thinking: false };
}

export async function getAiAgentMemberId(hotelId: string): Promise<string | undefined> {
  const row = await queryOne<{ id: string }>(
    "select id from members where hotel_id = $1 and kind = 'ai_agent' and active order by created_at limit 1",
    [hotelId],
  );
  return row?.id;
}
