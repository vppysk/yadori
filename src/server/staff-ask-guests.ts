import { HANDOFF_LABELS } from "@/lib/handoff-kinds";
import { fmtDate } from "./answer-context";
import { addDays, query } from "./db";
import { getGuestContext, searchReservations, type GuestContext, type GuestSummary } from "./integrations/pms";
import { tr } from "@/lib/i18n";

// AIに相談で特定のゲストに言及する（予約・客室管理システムと対応アラートから、そのゲストの情報を取る）。
// 言及は2通り: 画面でゲストを選ぶ（予約番号）か、質問の文に部屋番号・お名前を書く。文からの読み取りはLLMに任せずコードで照合する

// 検索と文の照合の対象にする期間（今日から見て）
const SEARCH_FROM_DAYS = -7;
const SEARCH_TO_DAYS = 30;
// 1つの質問で詳しく渡すゲストの上限。これを超える候補は「候補が複数」として名前と部屋だけ渡す
const MAX_GUESTS = 3;

export type GuestMention = { reservationId: string; label: string };
export type GuestSearchResult = GuestMention & { stay: string; status: string };

export const mentionLabel = (g: { roomNumber: string; guestName: string }) => tr(`${g.roomNumber}号室 ${g.guestName}様`, `Room ${g.roomNumber} ${g.guestName}`);

function stayStatus(g: { checkIn: string; checkOut: string }, today: string): string {
  if (g.checkIn > today) return tr("到着前", "Not arrived");
  if (g.checkOut < today) return tr("チェックアウト済み", "Checked out");
  if (g.checkOut === today) return tr("本日チェックアウト", "Checking out today");
  if (g.checkIn === today) return tr("本日チェックイン", "Checking in today");
  return tr("滞在中", "Staying");
}

const isStaying = (g: GuestSummary, today: string) => g.checkIn <= today && today <= g.checkOut;
const compact = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

function sortForStaff(guests: GuestSummary[], today: string): GuestSummary[] {
  return [...guests].sort((a, b) => Number(isStaying(b, today)) - Number(isStaying(a, today)) || a.checkIn.localeCompare(b.checkIn));
}

// 画面のゲスト検索。空なら今日滞在中のゲストを出す。「1203号室」「太郎様」のような書き方も受ける。
// 予約の検索のツールは、AIエージェントと検索するスタッフの両方に権限が要る（docs/007_ai_settings.md）
export async function searchGuests(hotelId: string, today: string, text: string, staffMemberId: string): Promise<GuestSearchResult[]> {
  const q = compact(text).replace(/(号室|様|さま|さん)$/, "").replace(/^(room|rm\.?|mr\.?|ms\.?|mrs\.?)/i, "");
  // 「別館105」は部屋番号で探してから棟を合わせる（予約・客室管理システムは棟なしの部屋番号で持つ）
  const room = q.match(/^(本館|別館)(\d{3,4})$/);
  const guests = await searchReservations(hotelId, {
    from: q ? addDays(today, SEARCH_FROM_DAYS) : today,
    to: q ? addDays(today, SEARCH_TO_DAYS) : today,
    query: room ? room[2] : q || undefined,
  }, staffMemberId);
  const matched = room ? guests.filter((g) => compact(g.roomNumber) === (room[1] === "本館" ? room[2] : q)) : guests;
  return sortForStaff(matched, today)
    .slice(0, 20)
    .map((g) => ({
      reservationId: g.reservationId,
      label: mentionLabel(g),
      stay: `${fmtDate(g.checkIn)}${tr("〜", "–")}${fmtDate(g.checkOut)}`,
      status: stayStatus(g, today),
    }));
}

type FoundInText = { guests: GuestSummary[]; ambiguous: { word: string; candidates: GuestSummary[] }[]; missingRooms: string[] };

// 質問の文から部屋番号・お名前を見つけて予約に当てる。部屋番号は今日滞在中の予約だけに当てる（過去の同じ部屋の客と取り違えない）
function findInText(text: string, candidates: GuestSummary[], today: string): FoundInText {
  const normalized = text.normalize("NFKC");
  const flat = compact(text);
  const found = new Map<string, GuestSummary>();
  const ambiguous: FoundInText["ambiguous"] = [];
  const missingRooms: string[] = [];

  // 部屋番号: 3〜4桁の数字。「15分」「1000円」のような数量は除く。棟名があれば棟まで合わせる。
  // 今日滞在中の人に当て、いなければ前後の滞在（チェックアウト済み・到着前）に当てる
  const staying = candidates.filter((g) => isStaying(g, today));
  const roomMatches = (list: GuestSummary[], building: string | undefined, number: string) => {
    // 表示名は本館が番号だけ、別館は「別館 105」。棟なしで両方に同じ番号があれば本館を優先する
    const main = list.filter((g) => compact(g.roomNumber) === number);
    if (building === "本館") return main;
    if (building) return list.filter((g) => compact(g.roomNumber) === `${building}${number}`);
    return main.length ? main : list.filter((g) => compact(g.roomNumber).replace(/^\D+/, "") === number);
  };
  for (const m of normalized.matchAll(/(別館|本館)?\s*(?<!\d)(\d{3,4})(?!\d)(号室|号|室)?(?!\s*(分|時|円|名|人|枚|個|本|泊|日|年|月|点|pt|%|％))/g)) {
    const [, building, number, suffix] = m;
    const now = roomMatches(staying, building, number);
    const near = now.length ? [] : roomMatches(candidates, building, number);
    if (now.length || near.length === 1) [...now, ...near].forEach((g) => found.set(g.reservationId, g));
    else if (near.length > 1) ambiguous.push({ word: `${building ?? ""}${number}号室（今日滞在中の予約はない）`, candidates: sortForStaff(near, today) });
    else if (suffix) missingRooms.push(`${building ?? ""}${number}号室`);
  }

  // 予約番号、お名前: フルネーム（空白を除く）で照合し、当たった部分を除いた残りの文を姓・名（2文字以上）で照合する
  let rest = flat;
  for (const g of candidates) {
    if (flat.includes(g.reservationId)) found.set(g.reservationId, g);
    const full = compact(g.guestName);
    if (rest.includes(full)) {
      found.set(g.reservationId, g);
      rest = rest.replaceAll(full, " ");
    }
  }
  const byWord = new Map<string, GuestSummary[]>();
  for (const g of candidates) {
    for (const word of g.guestName.normalize("NFKC").split(/\s+/)) {
      if (word.length >= 2 && rest.includes(word)) byWord.set(word, [...(byWord.get(word) ?? []), g]);
    }
  }
  for (const [word, guests] of byWord) {
    // 部屋番号ですでに決まった人が含まれていれば、その言葉はその人を指しているとみなす（「1203の太郎さん」）
    if (guests.some((g) => found.has(g.reservationId))) continue;
    if (guests.length === 1) found.set(guests[0].reservationId, guests[0]);
    else ambiguous.push({ word, candidates: sortForStaff(guests, today) });
  }
  return { guests: [...found.values()], ambiguous, missingRooms };
}

// guests: 話題のゲストの予約内容（連携係で連携先を調べるときに使う）
export type ResolvedGuests = { mentions: GuestMention[]; context: string | null; guests: GuestContext[] };

// 質問で言及されたゲストを決め、AIに渡す【話題のゲスト】の文章を作る。
// 画面で選んだゲスト＋文から見つけたゲスト。どちらもなければ、同じ会話の直前の質問で話題だったゲストを引き継ぐ（「その方の…」）
export async function resolveGuests(params: {
  hotelId: string;
  today: string;
  text: string;
  selectedIds: string[];
  previous: GuestMention[];
  // 相談しているスタッフ。ツールの権限を確かめる
  staffMemberId: string;
}): Promise<ResolvedGuests> {
  const { hotelId, today, staffMemberId } = params;
  let candidates: GuestSummary[];
  try {
    candidates = await searchReservations(hotelId, { from: addDays(today, SEARCH_FROM_DAYS), to: addDays(today, SEARCH_TO_DAYS) }, staffMemberId);
  } catch (error) {
    console.warn("[staff-ask] 予約を検索できなかった", error);
    const mentioned = params.selectedIds.length > 0 || /\d{3,4}|様|さん/.test(params.text);
    const reason = error instanceof Error && error.message.includes("権限") ? error.message : "予約・客室管理システムに接続できなかった";
    return { mentions: [], guests: [], context: mentioned ? `【話題のゲスト】\n${reason}ため、ゲストの情報を取得できなかった。` : null };
  }

  const inText = findInText(params.text, candidates, today);
  const ids = [...new Set([...params.selectedIds, ...inText.guests.map((g) => g.reservationId)])];
  const carried = ids.length === 0 && inText.ambiguous.length === 0 && inText.missingRooms.length === 0;
  const targetIds = (carried ? params.previous.map((m) => m.reservationId) : ids).slice(0, MAX_GUESTS);

  const sections: string[] = [];
  const mentions: GuestMention[] = [];
  const guests: GuestContext[] = [];
  for (const id of targetIds) {
    const detail = await describeGuest(hotelId, id, today, staffMemberId);
    if (!detail) continue;
    mentions.push(detail.mention);
    sections.push(detail.text);
    guests.push(detail.guest);
  }
  for (const { word, candidates: list } of inText.ambiguous) {
    sections.push(
      `「${word}」に当てはまる予約が複数ある（どの方か分からない）: ${list.slice(0, 5).map((g) => `${mentionLabel(g)}（${stayStatus(g, today)}）`).join("、")}`,
    );
  }
  for (const room of inText.missingRooms) sections.push(`${room}: 前後の日を含めて予約が見つからない`);
  if (!sections.length) return { mentions: [], context: null, guests: [] };

  return {
    mentions,
    guests,
    context: [
      `【話題のゲスト】（予約・客室管理システムと対応アラートから取得。今日: ${today}${carried ? "。直前の質問で話題だったゲスト" : ""}）`,
      ...sections,
    ].join("\n"),
  };
}

// 日付に今日からの関係を添える（モデルに日付の計算をさせない）
function fmtDay(date: string, today: string): string {
  const relative = { [addDays(today, -1)]: "昨日", [today]: "今日", [addDays(today, 1)]: "明日" }[date];
  return `${fmtDate(date)}${relative ? `（${relative}）` : ""}`;
}

const HANDOFF_STATUS: Record<string, string> = { open: "未対応", accepted: "対応中", closed: "対応完了", cancelled: "ゲストが取り消し" };

async function describeGuest(
  hotelId: string,
  reservationId: string,
  today: string,
  staffMemberId: string,
): Promise<{ mention: GuestMention; text: string; guest: GuestContext } | undefined> {
  const [guest, handoffs] = await Promise.all([
    getGuestContext(reservationId, { staffMemberId }).catch((error) => {
      console.warn("[staff-ask] 予約を取得できなかった", error);
      return undefined;
    }),
    // 対応アラート（引き継ぎ）。オーダー起点のクレームはチケットの会話から予約に当てる
    query<{ kind: string; status: string; summary: string; created_at: string; accepted_by: string | null }>(
      `select h.kind, h.status, h.summary, to_char(h.created_at at time zone ho.timezone, 'MM/DD HH24:MI') created_at, m.display_name accepted_by
       from handoffs h
       join hotels ho on ho.id = h.hotel_id
       left join tickets t on t.id = h.ticket_id
       join conversations c on c.id = coalesce(h.conversation_id, t.conversation_id)
       left join members m on m.id = h.accepted_by
       where h.hotel_id = $1 and c.external_reservation_id = $2
       order by h.created_at desc limit 10`,
      [hotelId, reservationId],
    ),
  ]);
  if (!guest || guest.hotelId !== hotelId) return undefined;

  const nights = Math.round((Date.parse(guest.checkOut) - Date.parse(guest.checkIn)) / 86_400_000);
  const lines = [
    `■ ${mentionLabel(guest)}（予約番号 ${guest.reservationId}）`,
    `・滞在: チェックイン ${fmtDay(guest.checkIn, today)}、チェックアウト ${fmtDay(guest.checkOut, today)}（${nights}泊、${stayStatus(guest, today)}）、大人${guest.adults}名、プラン: ${guest.planName ?? "記載なし"}`,
    // 連携先で「ゲストの情報として毎回読む」にしたもの（お客様メモ・依頼履歴など）
    ...guest.preloaded.map((p) => `・${p.description}（${p.integrationName}）:\n${p.text.replace(/^/gm, "  ")}`),
    `・対応アラート: ${handoffs.length ? "" : "なし"}`,
    ...handoffs.map(
      (h) => `  - ${h.created_at} ${HANDOFF_LABELS[h.kind] ?? h.kind}（${HANDOFF_STATUS[h.status] ?? h.status}${h.accepted_by ? `・担当 ${h.accepted_by}` : ""}）: ${h.summary}`,
    ),
  ];
  return { mention: { reservationId: guest.reservationId, label: mentionLabel(guest) }, text: lines.join("\n"), guest };
}
