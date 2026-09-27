import { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai";
import { modelIdFor, type ModelTier } from "@/lib/llm/models";
import type { LlmUsage } from "@/lib/llm/structured";
import { generateAnswer, type Answer, type ConciergeContext } from "@/mastra/agents/concierge";
import { query, queryOne, transaction } from "./db";
import { getGuestContext, type GuestContext } from "./guest-context";
import { checkReply, enabledHandoffCodes, unansweredCount } from "./guardrails";
import { createHandoff, type HandoffKind } from "./handoffs";
import { currentTimeBand, getAiAgentMemberId, getAssignment, getHotel, localNow, type Hotel, type Pattern } from "./hotel";
import { fmtDate, noticeCitations, renderFacilities, type Citation } from "./answer-context";
import { externalCitations, getExternalUpdates, renderExternalUpdates, type ExternalUpdate } from "./external-sources";
import { getFacilityInfo, listFacilityNames, searchDocuments, type FacilityInfo } from "./knowledge";
import { recordLlmCall, recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, listConversationTickets, type CreatedTicket, type GuestTicket } from "./orders";
import { readRuleText } from "./integrations/pms";
import { externalReadRule } from "./integrations/web-fetch";
import { recordUnanswered } from "./questions";
import { route, type RouteResult } from "./router";

const HISTORY_LIMIT = 12;
export const GUEST_MESSAGE_HEADING = "【ゲストのメッセージ】";
// クライアントに渡す時刻はISO文字列（UTC）に揃える。文字列のまま比較・並べ替えできる
export const ISO_TIMESTAMP = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// 回答の主担当を決める優先順（重いものを優先）
const PATTERN_PRIORITY: Pattern[] = ["complaint", "reservation", "external", "info", "order"];

export type { Citation };
export type InstructionOverrides = { common: string; patterns: Partial<Record<Pattern, string>> };

export type GuestChatMessage = {
  id: string;
  role: "user" | "assistant" | "staff";
  content: string;
  citations: Citation[] | null;
  created_at: string;
};

export type GuestSession = {
  hotelName: string;
  timezone: string;
  guest: Pick<GuestContext, "roomNumber" | "checkIn" | "checkOut">;
  today: string;
  conversationId: string;
  messages: GuestChatMessage[];
  tickets: GuestTicket[];
};

export async function getGuestSession(reservationId: string): Promise<GuestSession | undefined> {
  const guest = await getGuestContext(reservationId);
  if (!guest) return undefined;
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const [messages, tickets] = await Promise.all([listMessages(conversationId), listConversationTickets(conversationId)]);
  return {
    hotelName: hotel.name,
    timezone: hotel.timezone,
    guest: { roomNumber: guest.roomNumber, checkIn: guest.checkIn, checkOut: guest.checkOut },
    today: localNow(hotel.timezone).date,
    conversationId,
    messages,
    tickets,
  };
}

// ヘッダーの「スタッフと話す」。会話を人に引き継ぐ（ガードレール: 必ず人に引き継ぐ条件）
export async function requestStaff(reservationId: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const band = await currentTimeBand(hotel);
  return handOffToStaff(hotel, guest, conversationId, "info", band?.id, "ゲストが画面の「スタッフと話す」を押した");
}

async function handOffToStaff(
  hotel: Hotel,
  guest: GuestContext,
  conversationId: string,
  pattern: Pattern,
  timeBandId: string | undefined,
  summary: string,
  options: { kind?: HandoffKind; reply?: string } = {},
) {
  await createHandoff({ hotelId: hotel.id, kind: options.kind ?? "talk_request", conversationId, roomNumber: guest.roomNumber, summary });
  const reply = options.reply ?? "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。";
  await insertMessage(conversationId, "assistant", reply);
  await recordWorkEvent({ hotelId: hotel.id, conversationId, pattern, timeBandId, handlerKind: "human", handler: "引き継ぎ", outcome: "handed_off", signals: { wants_staff: true } });
  return { reply, citations: [] as Citation[], tickets: await listConversationTickets(conversationId) };
}

// ゲストの1通を処理する: ルーターで分解 → オーダーはチケット発行（機械の割り当て）→ 案内係エージェントがまとめて回答
export async function handleGuestMessage(reservationId: string, text: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const history = await listMessages(conversationId, HISTORY_LIMIT);
  const userMessageId = await insertMessage(conversationId, "user", text);
  const band = await currentTimeBand(hotel);
  const [catalog, facilityNames] = await Promise.all([getCatalog(hotel.id), listFacilityNames(hotel.id)]);

  const routed = await route(text, catalog, facilityNames);
  await recordLlmCall({ hotelId: hotel.id, conversationId, messageId: userMessageId, purpose: "router", thinking: false, usage: routed.usage });
  const { intents } = routed.result;
  const conditions = await enabledHandoffCodes(hotel.id);

  // ガードレール（前）: 必ず人に引き継ぐ条件
  if (conditions.has("safety") && routed.result.safety) {
    return handOffToStaff(hotel, guest, conversationId, intents[0].pattern, band?.id, text, {
      kind: "safety",
      reply: "すぐにスタッフにおつなぎします。命に関わる緊急の場合は、ためらわず119番に通報してください。",
    });
  }
  if (conditions.has("wants_staff") && routed.result.wants_staff) return handOffToStaff(hotel, guest, conversationId, intents[0].pattern, band?.id, text);

  const tickets = await issueOrders(hotel, guest, conversationId, text, intents, band?.id);
  const unsupportedItems = intents.flatMap((i) => i.unsupported_items ?? []);
  const complaints = intents.filter((i) => i.pattern === "complaint");
  // クレームと強い不満は人へ引き継ぐ（AIは一次受け止めのみ。「強い不満」の条件をオフにすると引き継がない）
  if (conditions.has("strong_complaint")) {
    for (const complaint of complaints) {
      await createHandoff({ hotelId: hotel.id, kind: "complaint", conversationId, roomNumber: guest.roomNumber, summary: complaint.summary });
    }
    if (complaints.length === 0 && routed.result.strong_emotion) {
      await createHandoff({ hotelId: hotel.id, kind: "complaint", conversationId, roomNumber: guest.roomNumber, summary: `強い不満: ${text}` });
    }
  }

  const primary = PATTERN_PRIORITY.find((p) => intents.some((i) => i.pattern === p)) ?? "info";
  const assignment = await getAssignment(hotel.id, primary, band?.id);

  // 人に直接回す設定の業務（オーダーは受付済みなので除く）
  if (assignment.handler === "human" && primary !== "order") {
    await createHandoff({ hotelId: hotel.id, kind: "talk_request", conversationId, roomNumber: guest.roomNumber, summary: text });
    const reply = "担当のスタッフからご案内いたします。少々お待ちください。";
    await insertMessage(conversationId, "assistant", reply);
    await recordWorkEvent({ hotelId: hotel.id, conversationId, pattern: primary, timeBandId: band?.id, handlerKind: "human", handler: "引き継ぎ", outcome: "handed_off" });
    return { reply, citations: [] as Citation[], tickets: await listConversationTickets(conversationId) };
  }

  const tier: ModelTier = assignment.handler === "human" ? "small" : assignment.handler;
  const { answer, facilities, externalUpdates } = await draftAnswer({
    hotel, guest, text, history, routed: routed.result, allFacilityNames: facilityNames, tickets, unsupportedItems,
    hasComplaint: complaints.length > 0, tier, thinking: assignment.thinking,
  });
  const today = localNow(hotel.timezone).date;
  const usage: LlmUsage = answer?.usage ?? { modelId: modelIdFor(tier), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  // 答えられなかった質問は未回答の一覧へ（管理PCで回答すると知識に蓄積）
  // モデルが「確認します」と答えたのに一覧を空で返すことがあるため、そのときはゲストの文をそのまま記録する
  const unanswered = answer?.unanswered_questions.length
    ? answer.unanswered_questions
    : answer && /スタッフに確認|確認して(ご連絡|お知らせ)/.test(answer.reply)
      ? [text]
      : [];
  for (const question of unanswered) await recordUnanswered(hotel.id, question);
  // 指示してもマークダウンの強調・見出しを出すことがあるため取り除く
  const generated = (answer?.reply ?? "").replace(/\*\*|__|^#+\s*/gm, "").trim();
  const failed = generated === "";
  if (failed) {
    await createHandoff({ hotelId: hotel.id, kind: "unanswerable", conversationId, roomNumber: guest.roomNumber, summary: `AIが回答を作れなかった質問: ${text}` });
  }
  // ガードレール（後）: してはいけないことに反する回答はゲストに出さず、人に引き継ぐ
  const check = failed ? ({ ok: true } as const) : await checkReply(hotel.id, generated, conversationId);
  if (!check.ok) {
    console.warn("[guest-chat] ガードレールで回答を止めた", { rule: check.rule, reason: check.reason, generated });
    await createHandoff({
      hotelId: hotel.id, kind: "talk_request", conversationId, roomNumber: guest.roomNumber,
      summary: `AIの回答が決まり「${check.rule}」に反したため止めた。ゲストの発言: ${text}`,
    });
  }
  // 同じ会話で2回答えられなかったら人へ
  const isUnanswered = failed || unanswered.length > 0;
  if (isUnanswered && conditions.has("unanswered_twice") && (await unansweredCount(conversationId)) >= 1) {
    await createHandoff({ hotelId: hotel.id, kind: "unanswerable", conversationId, roomNumber: guest.roomNumber, summary: `同じ会話で2回答えられなかった。直近の質問: ${text}` });
  }
  const reply = failed ? "確認してすぐにご連絡いたします。少々お待ちください。" : !check.ok ? "担当のスタッフから改めてご案内いたします。少々お待ちください。" : generated;
  const citations = failed ? [] : [...buildCitations(facilities, routed.result.facilities, reply, guest, today), ...externalCitations(externalUpdates, answer?.used_sources)];

  const assistantMessageId = await insertMessage(conversationId, "assistant", reply, citations);
  const costUsd = await recordLlmCall({
    hotelId: hotel.id, conversationId, messageId: assistantMessageId, purpose: "answer", pattern: primary,
    thinking: assignment.thinking, usage,
  });
  const costJpy = costUsd * Number(hotel.fx_usd_jpy);
  const answered = intents.filter((i) => i.pattern !== "order");
  for (const [index, intent] of answered.entries()) {
    const first = index === 0;
    await recordWorkEvent({
      hotelId: hotel.id, conversationId, pattern: intent.pattern, timeBandId: band?.id, handlerKind: "ai", handler: usage.modelId,
      // 回答1回分のコストとトークンは最初の要望に計上する
      inputTokens: first ? usage.inputTokens + routed.usage.inputTokens : 0,
      outputTokens: first ? usage.outputTokens + routed.usage.outputTokens : 0,
      durationMs: first ? usage.ms + routed.usage.ms : 0,
      costJpy: first ? costJpy : 0,
      outcome: isUnanswered ? "unanswered" : !check.ok ? "handed_off" : intent.pattern === "complaint" ? "escalated_complaint" : "resolved",
      signals: check.ok ? {} : { guardrail_blocked: check.rule },
    });
  }

  return { reply, citations, tickets: await listConversationTickets(conversationId) };
}

async function issueOrders(
  hotel: Hotel,
  guest: GuestContext,
  conversationId: string,
  text: string,
  intents: RouteResult["intents"],
  timeBandId?: string,
): Promise<CreatedTicket[]> {
  const lines = intents.filter((i) => i.pattern === "order").flatMap((i) => i.items ?? []);
  if (lines.length === 0) return [];
  const aiMemberId = await getAiAgentMemberId(hotel.id);
  const tickets = await transaction((client) =>
    createTickets(client, { hotel, roomNumber: guest.roomNumber, lines, source: "ai_chat", rawText: text, conversationId, createdBy: aiMemberId }),
  );
  for (const ticket of tickets) {
    await recordWorkEvent({
      hotelId: hotel.id, conversationId, ticketId: ticket.id, pattern: "order", timeBandId, handlerKind: "ai",
      handler: modelIdFor("small"), outcome: "resolved", signals: { assigned: ticket.assigneeName !== null },
    });
  }
  return tickets;
}

// 回答の下書き（DBには書かない）: 滞在日で館内情報を取り、指示を組み立てて回答係に答えさせる。
// ゲスト対応と、精密見積もりの再生（replay.ts）で共通に使う
export async function draftAnswer(params: {
  hotel: Hotel;
  guest: GuestContext;
  text: string;
  history: { role: string; content: string }[];
  routed: RouteResult;
  allFacilityNames: string[];
  tickets: CreatedTicket[];
  unsupportedItems: string[];
  hasComplaint: boolean;
  tier: ModelTier;
  thinking: boolean;
  // 保存前の指示で試すとき（「過去の会話で試す」）に、DBの指示の代わりに使う
  instructionOverrides?: InstructionOverrides;
}): Promise<{ answer: Answer | undefined; facilities: FacilityInfo[]; externalUpdates: ExternalUpdate[] }> {
  const { hotel, guest, text, history, routed, tier, thinking } = params;
  const intents = routed.intents;
  // 回答に使う知識をゲストの滞在日で取得する（ご滞在中は今日から、ご到着前は滞在期間。チェックアウト日の朝食なども含める）
  const today = localNow(hotel.timezone).date;
  const needsKnowledge = intents.some((i) => i.pattern === "info" || i.pattern === "external");
  // 外部の最新情報（運行情報・天気など）は定期取得済みの要約を渡す（その場で検索・取得はしない）
  const [facilities, documents, externalUpdates] = await Promise.all([
    needsKnowledge
      ? getFacilityInfo(hotel.id, { facilities: routed.facilities, from: today > guest.checkIn ? today : guest.checkIn, to: guest.checkOut, timezone: hotel.timezone })
      : [],
    needsKnowledge ? searchDocuments(hotel.id, text) : [],
    needsKnowledge ? getExternalUpdates(hotel.id) : [],
  ]);

  const instructions = await buildInstructions({
    hotel, guest, intents, tickets: params.tickets, unsupportedItems: params.unsupportedItems, hasComplaint: params.hasComplaint,
    overrides: params.instructionOverrides, externalUpdates,
  });
  const requestContext = new RequestContext<ConciergeContext>();
  requestContext.set("tier", tier);
  requestContext.set("thinking", thinking);
  requestContext.set("instructions", instructions);
  try {
    const answer = await generateAnswer(
      { tier, thinking, instructions },
      [
        ...history.map((m): ModelMessage => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content })),
        {
          role: "user",
          content: withLatestKnowledge({
            text, needsKnowledge, facilities, documents, externalUpdates,
            // ルーターが選んだ施設（空なら全施設）。情報が1件もない施設も「情報なし」と明示する
            facilityNames: routed.facilities.length ? routed.facilities : params.allFacilityNames,
          }),
        } satisfies ModelMessage,
      ],
      requestContext,
    );
    return { answer, facilities, externalUpdates };
  } catch (error) {
    console.warn("[guest-chat] 回答を作れなかった", { modelId: modelIdFor(tier), error });
    return { answer: undefined, facilities, externalUpdates };
  }
}

async function buildInstructions(params: {
  hotel: Hotel;
  guest: GuestContext;
  intents: RouteResult["intents"];
  tickets: CreatedTicket[];
  unsupportedItems: string[];
  hasComplaint: boolean;
  overrides?: InstructionOverrides;
  externalUpdates: ExternalUpdate[];
}): Promise<string> {
  const { hotel, guest, intents, tickets, unsupportedItems, hasComplaint, overrides, externalUpdates } = params;
  const patterns = [...new Set(intents.map((i) => i.pattern))];
  const [instructions, guardrails, readRule, externalRule] = await Promise.all([
    overrides
      ? Promise.resolve([
          { scope: "common", body: overrides.common },
          ...patterns.map((p) => ({ scope: "pattern", body: overrides.patterns[p] ?? "" })),
        ].filter((i) => i.body.trim()))
      : query<{ scope: string; body: string }>(
          "select scope, body from ai_instructions where hotel_id = $1 and (scope = 'common' or (scope = 'pattern' and pattern = any ($2))) order by scope",
          [hotel.id, patterns],
        ),
    query<{ kind: string; body: string }>(
      "select kind, body from guardrails where hotel_id = $1 and enabled and kind in ('forbidden', 'confirm_before') order by kind, sort",
      [hotel.id],
    ),
    readRuleText(),
    externalUpdates.length ? externalReadRule(hotel.id) : undefined,
  ]);
  const now = localNow(hotel.timezone);
  const stayStatus = now.date < guest.checkIn ? "ご到着前" : now.date >= guest.checkOut ? "ご出発後" : "ご滞在中";

  return [
    `あなたは「${hotel.name}」のゲスト向けアシスタント。日本語だけで、ゲストに直接話しかける文章だけを書く。`,
    "施設の営業時間・メニュー・特記事項は、ゲストの発言の前に付いている【最新の館内情報】だけを根拠に答える。書かれていないことは推測せず、スタッフに確認してご連絡すると伝える。",
    "日付の指定がなければ、ご滞在中なら今日、ご到着前ならご滞在の期間の情報で答える。期間によって違う場合は、どの日がどうなるかを分けて伝える。",
    "【特記事項】は通常の営業情報より優先する。特記事項がある日は、特記事項の内容で答え、通常との違いも伝える。",
    "「情報なし」の施設・項目について聞かれたら、時間などを推測せず、スタッフに確認してご連絡すると伝える。「情報なし」「特記事項」などの内部の表記はそのまま言わない。",
    "日付は「本日」「明日」「10/21」のように短く書く（年は書かない）。",
    "ご到着前のゲストには「現在」「本日」ではなく「ご滞在中（10/20〜10/23）は」のように滞在日を主語にして答える。",
    "館内の情報に書かれていないサービス（ルームサービスなど）を勧めない。",
    "答えられた質問には「スタッフに確認します」を付けない。",
    "営業時間などは、会話の中の過去の回答ではなく、必ず【最新の館内情報】で答える（情報は更新されていることがある）。",
    "ゲストの状況に書かれていない事実（到着からの経過時間など）を付け足さない。",
    "館内の情報・抜粋に書かれていないことは、あるともないとも断定しない（「ございません」「お断りしています」も言わない）。スタッフに確認してご連絡すると伝え、その質問を unanswered_questions に入れる。",
    "マークダウン記法（**や#）は使わない。",
    "",
    "## ホテルの指示",
    ...instructions.map((i) => i.body),
    "",
    "## 必ず守ること",
    ...guardrails.map((g) => (g.kind === "forbidden" ? `・${g.body}` : `・「${g.body}」は確定前に必ずお客様に確認する`)),
    "",
    "## ゲストの状況",
    `・今日: ${now.date} ${now.time}（${stayStatus}）`,
    `・ご滞在: ${guest.checkIn}（チェックイン）〜 ${guest.checkOut}（チェックアウト）、${guest.roomNumber}号室、${guest.adults}名`,
    ...(tickets.length
      ? [`・このメッセージのオーダーは手配済み: ${tickets.flatMap((t) => t.lines.map((l) => `${l.item}×${l.quantity}`)).join("、")}。お届けの目安は${Math.min(...tickets.map((t) => t.dueMinutes))}分以内。手配したことを一言伝える（進み具合は画面に表示される）`]
      : []),
    ...(unsupportedItems.length ? [`・品目マスタにない依頼（${unsupportedItems.join("、")}）は、スタッフが確認してご連絡すると伝える`] : []),
    ...(hasComplaint ? ["・不満の内容はスタッフに引き継ぎ済み。お詫びし、担当者から改めて連絡すると伝える"] : []),
    // 予約・客室管理システムのお客様メモ（読み取りが許可されている場合のみ）と、その読み取りルール
    ...(guest.guestNotes?.length
      ? ["", "## お客様メモ（予約・客室管理システム）", ...guest.guestNotes.map((n) => `・${n.category}: ${n.body}`), ...(readRule ? ["", "### お客様メモの使い方", readRule] : [])]
      : []),
    // 外部の最新情報の使い方（外部連携の読み取りルール）
    ...(externalUpdates.length
      ? [
          "",
          "## 外部の最新情報の使い方",
          "・【外部の最新情報】は、ゲストの質問に関係するときだけ使う。書かれていないこと（運転再開の見込みなど）は推測しない",
          "・使った情報源の名前を used_sources に入れる",
          ...(externalRule ? [externalRule] : []),
        ]
      : []),
  ].join("\n");
}

// 館内の情報は最後のゲストの発言と一緒に渡す。システム指示に置くと、情報を更新したあとも
// 会話の中の過去の回答（更新前の営業時間など）を繰り返すことがあったため（2026-09-26 検証）
function withLatestKnowledge(params: {
  text: string;
  needsKnowledge: boolean;
  facilities: FacilityInfo[];
  facilityNames: string[];
  documents: { title: string; content: string }[];
  externalUpdates: ExternalUpdate[];
}): string {
  const { text, needsKnowledge, facilities, facilityNames, documents, externalUpdates } = params;
  if (!needsKnowledge) return text;
  return [
    "【最新の館内情報】（ゲストの滞在日にかかる期間のもの。会話の中の過去の回答より、必ずこちらを優先する）",
    renderFacilities(facilities, facilityNames),
    ...(documents.length ? ["", "【館内案内・マニュアルからの抜粋】", ...documents.map((d) => `・${d.title}: ${d.content}`)] : []),
    ...renderExternalUpdates(externalUpdates),
    "",
    GUEST_MESSAGE_HEADING,
    text,
  ].join("\n");
}

// ゲスト向けの根拠表示: 関係する施設の特記事項と、ご到着前なら滞在日で答えたこと
function buildCitations(facilities: FacilityInfo[], requested: string[], reply: string, guest: GuestContext, today: string): Citation[] {
  const citations: Citation[] = noticeCitations(facilities, requested, reply);
  if (guest.checkIn > today && facilities.some((f) => f.hours.length + f.offerings.length > 0)) {
    const periods = [...new Set(facilities.flatMap((f) => f.hours.map((h) => `${fmtDate(h.from)}〜${fmtDate(h.to)}`)))];
    citations.push({ kind: "stay_date", label: `ご滞在日の情報で回答${periods.length ? `・適用期間 ${periods.join("、")}` : ""}` });
  }
  return citations;
}

async function findOrCreateConversation(hotel: Hotel, guest: GuestContext): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    "select id from conversations where hotel_id = $1 and channel = 'guest' and external_reservation_id = $2 order by started_at desc limit 1",
    [hotel.id, guest.reservationId],
  );
  if (existing) return existing.id;
  const [{ id }] = await query<{ id: string }>(
    `insert into conversations (hotel_id, channel, external_reservation_id, room_number, stay_start, stay_end)
     values ($1, 'guest', $2, $3, $4, $5) returning id`,
    [hotel.id, guest.reservationId, guest.roomNumber, guest.checkIn, guest.checkOut],
  );
  return id;
}

async function insertMessage(conversationId: string, role: "user" | "assistant", content: string, citations?: Citation[]) {
  const [{ id }] = await query<{ id: string }>(
    "insert into messages (conversation_id, role, content, citations) values ($1, $2, $3, $4) returning id",
    [conversationId, role, content, citations?.length ? JSON.stringify(citations) : null],
  );
  return id;
}

async function listMessages(conversationId: string, limit = 200): Promise<GuestChatMessage[]> {
  const rows = await query<GuestChatMessage>(
    `select id, role, content, citations, ${ISO_TIMESTAMP("created_at")} created_at from messages
     where conversation_id = $1 and role in ('user', 'assistant', 'staff')
     order by created_at desc limit $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}
