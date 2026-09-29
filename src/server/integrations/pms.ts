import { query, queryOne } from "../db";
import { callTool, listAiTools, memberMayUse, renderToolResult, type Integration } from "./mcp";

// 予約・客室管理システムとの変換層。plan 3章「ゲスト文脈」、docs/007_ai_settings.md。
// 会話の最初の予約の取得は本人確認に当たるため、連携係に選ばせず、/manage で「ゲストの予約の取得」に指定したツールをここで呼ぶ。
// 相手の項目名を自前の形に直し、使わない項目（料金など）は落とす。/manage で「AIに使わせる」にしたツールだけを呼ぶ。
// スタッフのAI相談（staffMemberId あり）では、相談しているスタッフにも同じツールの権限が必要（人・AI共通のツール1つ＝権限1つ。plan 4.8）

type ReservationTool = { integration: Integration; name: string; permission_key: string };

// ゲストの予約の取得に使うツール（AIに使わせるもの）。デモは1ホテルのため、有効な連携先から1つ引く（複数ホテルではゲストのURLにホテルを含めて引き当てる）
async function reservationTool(role: "reservation" | "search"): Promise<ReservationTool | undefined> {
  return queryOne<ReservationTool>(
    `select t.name, t.permission_key,
       json_build_object('id', i.id, 'hotel_id', i.hotel_id, 'name', i.name, 'slug', i.slug, 'endpoint_env', i.endpoint_env, 'token_env', i.token_env) integration
     from integration_tools t join integrations i on i.id = t.integration_id
     where t.role = $1 and t.ai_enabled and i.kind = 'mcp' and i.active order by i.name limit 1`,
    [role],
  );
}

// 会話のたびに読むゲストの情報（お客様メモ・依頼履歴など）。/manage で「ゲストの情報として毎回読む」にしたツールの結果
export type PreloadedInfo = { integrationId: string; integrationName: string; description: string; text: string };

export type GuestContext = {
  reservationId: string;
  hotelId: string;
  guestName: string;
  // 客室の一意のID（本館・別館で同じ部屋番号があっても区別できる）と、表示名（棟＋部屋番号）
  roomId: string | null;
  roomNumber: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  planName: string | null;
  preloaded: PreloadedInfo[];
};

type RawReservation = {
  reservation_id: string;
  hotel_id: string;
  guest_name: string;
  room_id?: string;
  room_number: string;
  check_in: string;
  check_out: string;
  adults: number;
  plan_name: string | null;
  total_amount_jpy?: number;
  error?: string;
};

// ゲスト文脈プロバイダ: 予約内容と、毎回読むゲストの情報を取得する
export async function getGuestContext(reservationId: string, options: { staffMemberId?: string } = {}): Promise<GuestContext | undefined> {
  const tool = await reservationTool("reservation");
  if (!tool) throw new Error("ゲストの予約を取得する連携が設定されていません（/manage/integrations）");
  if (options.staffMemberId && !(await memberMayUse(options.staffMemberId, tool.permission_key))) throw new Error("予約内容の取得の権限がありません");

  const raw = await callTool<RawReservation>(tool.integration, tool.name, { reservation_id: reservationId }, { purpose: "guest_context", staffMemberId: options.staffMemberId });
  if (!raw || raw.error || raw.hotel_id !== tool.integration.hotel_id) return undefined;
  // 変換層: 相手の項目名を自前の形に直し、使わない項目（料金など）は落とす。部屋は客室IDで自前の部屋マスタに当て、表示名を使う
  const room = raw.room_id
    ? await queryOne<{ label: string }>("select label from rooms where hotel_id = $1 and id = $2", [tool.integration.hotel_id, raw.room_id])
    : undefined;
  return {
    reservationId: raw.reservation_id,
    hotelId: raw.hotel_id,
    guestName: raw.guest_name,
    roomId: room ? raw.room_id! : null,
    roomNumber: room?.label ?? raw.room_number,
    checkIn: raw.check_in,
    checkOut: raw.check_out,
    adults: raw.adults,
    planName: raw.plan_name,
    preloaded: await preload(raw.hotel_id, reservationId, options.staffMemberId),
  };
}

async function preload(hotelId: string, reservationId: string, staffMemberId?: string): Promise<PreloadedInfo[]> {
  const tools = await listAiTools(hotelId, "preload", staffMemberId);
  const results = await Promise.all(
    tools.map(async (t) => {
      try {
        const data = await callTool<unknown>(t.integration, t.name, { reservation_id: reservationId }, { purpose: "guest_context", staffMemberId });
        return { integrationId: t.integration_id, integrationName: t.integration.name, description: t.description || t.name, text: renderToolResult(data) };
      } catch (error) {
        console.warn("[pms] ゲストの情報を読めなかった", t.integration.name, t.name, error);
        return undefined;
      }
    }),
  );
  return results.filter((r): r is PreloadedInfo => r !== undefined);
}

export type GuestSummary = { reservationId: string; guestName: string; roomNumber: string; checkIn: string; checkOut: string };

// 予約を探す（スタッフのAI相談でゲストを指定するため）。期間に滞在がかかる予約を、お名前か部屋番号で絞る
export async function searchReservations(
  hotelId: string,
  params: { from: string; to: string; query?: string },
  staffMemberId: string,
): Promise<GuestSummary[]> {
  const tool = await reservationTool("search");
  if (!tool || tool.integration.hotel_id !== hotelId) return [];
  if (!(await memberMayUse(staffMemberId, tool.permission_key))) throw new Error("予約の検索の権限がありません");
  const { reservations } = await callTool<{ reservations: RawReservation[] }>(tool.integration, tool.name, { hotel_id: hotelId, ...params }, { purpose: "search", staffMemberId });
  const labels = new Map(
    (await query<{ id: string; label: string }>("select id, label from rooms where hotel_id = $1 and id = any($2)", [
      hotelId, reservations.map((r) => r.room_id).filter(Boolean),
    ])).map((r) => [r.id, r.label]),
  );
  // 変換層: 料金などは落とし、部屋は自前の表示名（棟＋部屋番号）にする
  return reservations.map((r) => ({
    reservationId: r.reservation_id,
    guestName: r.guest_name,
    roomNumber: (r.room_id && labels.get(r.room_id)) || r.room_number,
    checkIn: r.check_in,
    checkOut: r.check_out,
  }));
}
