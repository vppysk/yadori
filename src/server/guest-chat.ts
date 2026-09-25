import { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai";
import { modelIdFor, type ModelTier } from "@/lib/llm/models";
import type { LlmUsage } from "@/lib/llm/structured";
import { mastra } from "@/mastra";
import type { ConciergeContext } from "@/mastra/agents/concierge";
import { query, queryOne, transaction } from "./db";
import { getGuestContext, type GuestContext } from "./guest-context";
import { createHandoff } from "./handoffs";
import { currentTimeBand, getAiAgentMemberId, getAssignment, getHotel, localNow, type Hotel, type Pattern } from "./hotel";
import { getFacilityInfo, listFacilityNames, searchDocuments, type FacilityInfo } from "./knowledge";
import { recordLlmCall, recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, listConversationTickets, type CreatedTicket, type GuestTicket } from "./orders";
import { recordUnanswered } from "./questions";
import { route, type RouteResult } from "./router";

const HISTORY_LIMIT = 12;
// クライアントに渡す時刻はISO文字列（UTC）に揃える。文字列のまま比較・並べ替えできる
export const ISO_TIMESTAMP = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// 回答の主担当を決める優先順（重いものを優先）
const PATTERN_PRIORITY: Pattern[] = ["complaint", "reservation", "external", "info", "order"];

export type Citation = { kind: "notice" | "stay_date"; label: string };

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

async function handOffToStaff(hotel: Hotel, guest: GuestContext, conversationId: string, pattern: Pattern, timeBandId: string | undefined, summary: string) {
  await createHandoff({ hotelId: hotel.id, kind: "talk_request", conversationId, roomNumber: guest.roomNumber, summary });
  const reply = "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。";
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
  const { intents, wants_staff } = routed.result;

  // 「スタッフと話したい」は必ず人に引き継ぐ（ガードレール）
  if (wants_staff) return handOffToStaff(hotel, guest, conversationId, intents[0].pattern, band?.id, text);

  const tickets = await issueOrders(hotel, guest, conversationId, text, intents, band?.id);
  const unsupportedItems = intents.flatMap((i) => i.unsupported_items ?? []);
  const complaints = intents.filter((i) => i.pattern === "complaint");
  for (const complaint of complaints) {
    await createHandoff({ hotelId: hotel.id, kind: "complaint", conversationId, roomNumber: guest.roomNumber, summary: complaint.summary });
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

  // 回答に使う知識をゲストの滞在日で取得する（ご滞在中は今日から、ご到着前は滞在期間。チェックアウト日の朝食なども含める）
  const today = localNow(hotel.timezone).date;
  const needsKnowledge = intents.some((i) => i.pattern === "info" || i.pattern === "external");
  const facilities = needsKnowledge
    ? await getFacilityInfo(hotel.id, {
        facilities: routed.result.facilities,
        from: today > guest.checkIn ? today : guest.checkIn,
        to: guest.checkOut,
        timezone: hotel.timezone,
      })
    : [];
  const documents = needsKnowledge ? await searchDocuments(hotel.id, text) : [];

  const tier: ModelTier = assignment.handler === "human" ? "small" : assignment.handler;
  const requestContext = new RequestContext<ConciergeContext>();
  requestContext.set("tier", tier);
  requestContext.set("thinking", assignment.thinking);
  requestContext.set(
    "instructions",
    await buildInstructions({
      hotel, guest, intents, tickets, unsupportedItems, hasComplaint: complaints.length > 0,
      needsKnowledge, facilities, facilityNames: routed.result.facilities.length ? routed.result.facilities : facilityNames, documents,
    }),
  );

  const startedAt = performance.now();
  const result = await mastra.getAgent("concierge").generate(
    [
      ...history.map((m): ModelMessage => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content })),
      { role: "user", content: text } satisfies ModelMessage,
    ],
    { requestContext, maxSteps: 1 },
  );
  const usage: LlmUsage = {
    modelId: modelIdFor(tier),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    reasoningTokens: result.usage?.reasoningTokens ?? 0,
    ms: Math.round(performance.now() - startedAt),
  };

  // 答えられなかった質問の印（ゲストには見せずに未回答の一覧へ）。指示してもマークダウンを出すことがあるため取り除く
  const unansweredMarks = [...result.text.matchAll(/\[\[未回答[:：]\s*(.+?)\]\]/g)].map((m) => m[1].trim());
  const generated = result.text.replace(/\[\[未回答[:：].*?\]\]/g, "").replace(/\*\*|__|^#+\s*/gm, "").trim();
  for (const question of unansweredMarks) await recordUnanswered(hotel.id, question);
  // 空の回答や、ツール呼び出しを文字で書いた回答はゲストに出さず、スタッフに引き継ぐ
  const failed = generated === "" || /\[TOOL_CALL\]|<tool_call>|<function=/.test(generated);
  if (failed) {
    console.warn("[guest-chat] 回答を作れなかった", {
      modelId: modelIdFor(tier),
      generated,
      steps: result.steps?.map((step) => ({ text: step.text, toolCalls: step.toolCalls?.length ?? 0, finishReason: step.finishReason })),
    });
    await createHandoff({ hotelId: hotel.id, kind: "unanswerable", conversationId, roomNumber: guest.roomNumber, summary: `AIが回答を作れなかった質問: ${text}` });
  }
  const reply = failed ? "確認してすぐにご連絡いたします。少々お待ちください。" : generated;
  const citations = failed ? [] : buildCitations(facilities, routed.result.facilities, reply, guest, today);

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
      outcome: failed ? "unanswered" : intent.pattern === "complaint" ? "escalated_complaint" : "resolved",
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

async function buildInstructions(params: {
  hotel: Hotel;
  guest: GuestContext;
  intents: RouteResult["intents"];
  tickets: CreatedTicket[];
  unsupportedItems: string[];
  hasComplaint: boolean;
  needsKnowledge: boolean;
  facilities: FacilityInfo[];
  // ルーターが選んだ施設（空なら全施設）。情報が1件もない施設も「情報なし」と明示する
  facilityNames: string[];
  documents: { title: string; content: string }[];
}): Promise<string> {
  const { hotel, guest, intents, tickets, unsupportedItems, hasComplaint, needsKnowledge, facilities, facilityNames, documents } = params;
  const patterns = [...new Set(intents.map((i) => i.pattern))];
  const [instructions, guardrails] = await Promise.all([
    query<{ scope: string; body: string }>(
      "select scope, body from ai_instructions where hotel_id = $1 and (scope = 'common' or (scope = 'pattern' and pattern = any ($2))) order by scope",
      [hotel.id, patterns],
    ),
    query<{ kind: string; body: string }>(
      "select kind, body from guardrails where hotel_id = $1 and enabled and kind in ('forbidden', 'confirm_before') order by kind, sort",
      [hotel.id],
    ),
  ]);
  const now = localNow(hotel.timezone);
  const stayStatus = now.date < guest.checkIn ? "ご到着前" : now.date >= guest.checkOut ? "ご出発後" : "ご滞在中";

  return [
    `あなたは「${hotel.name}」のゲスト向けアシスタント。日本語だけで、ゲストに直接話しかける文章だけを書く。`,
    "施設の営業時間・メニュー・特記事項は、下の「館内の情報」だけを根拠に答える。書かれていないことは推測せず、スタッフに確認してご連絡すると伝える。",
    "日付の指定がなければ、ご滞在中なら今日、ご到着前ならご滞在の期間の情報で答える。期間によって違う場合は、どの日がどうなるかを分けて伝える。",
    "【特記事項】は通常の営業情報より優先する。特記事項がある日は、特記事項の内容で答え、通常との違いも伝える。",
    "「情報なし」の施設・項目について聞かれたら、時間などを推測せず、スタッフに確認してご連絡すると伝える。「情報なし」「特記事項」などの内部の表記はそのまま言わない。",
    "日付は「本日」「明日」「10/21」のように短く書く（年は書かない）。",
    "ご到着前のゲストには「現在」「本日」ではなく「ご滞在中（10/20〜10/23）は」のように滞在日を主語にして答える。",
    "館内の情報に書かれていないサービス（ルームサービスなど）を勧めない。",
    "答えられた質問には「スタッフに確認します」を付けない。",
    "営業時間などは、会話の中の過去の回答ではなく、必ず今回の「館内の情報」で答える（情報は更新されていることがある）。",
    "ゲストの状況に書かれていない事実（到着からの経過時間など）を付け足さない。",
    "情報がなくて答えられなかった質問があれば、回答の最後に [[未回答: 質問を短くまとめたもの]] と書く（ゲストには表示されない）。答えられた質問には書かない。",
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
    ...(needsKnowledge ? ["", "## 館内の情報（ゲストの滞在日にかかる期間のもの）", renderFacilities(facilities, facilityNames)] : []),
    ...(documents.length
      ? ["", "## 館内案内・マニュアルからの抜粋", ...documents.map((d) => `【${d.title}】${d.content}`)]
      : []),
  ].join("\n");
}

// 特記事項の表示は、質問に関係する施設（ルーターが選んだ施設・回答に名前が出た施設・館内全体）のものだけ
function buildCitations(facilities: FacilityInfo[], requested: string[], reply: string, guest: GuestContext, today: string): Citation[] {
  const citations: Citation[] = [];
  const related = (f: FacilityInfo) => requested.includes(f.facility) || reply.includes(f.facility) || f.facility === "館内全体のお知らせ";
  for (const f of facilities.filter(related)) {
    for (const n of f.notices) {
      citations.push({ kind: "notice", label: `${f.facility}の特記事項を反映（${fmt(n.updated_at.slice(0, 10))} ${n.updated_at.slice(11)} 更新）` });
    }
  }
  if (guest.checkIn > today && facilities.some((f) => f.hours.length + f.offerings.length > 0)) {
    const periods = [...new Set(facilities.flatMap((f) => f.hours.map((h) => `${fmt(h.from)}〜${fmt(h.to)}`)))];
    citations.push({ kind: "stay_date", label: `ご滞在日の情報で回答${periods.length ? `・適用期間 ${periods.join("、")}` : ""}` });
  }
  return [...new Map(citations.map((c) => [c.label, c])).values()];
}

const fmt = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 小型モデルでも取り違えないよう、施設ごとに「特記事項（優先）→ 通常の営業情報」の順の文章にする
function renderFacilities(facilities: FacilityInfo[], requested: string[]): string {
  const lines: string[] = [];
  for (const f of facilities) {
    lines.push(`■${f.facility}`);
    for (const n of f.notices) lines.push(`  【特記事項・最優先】${n.body}（${n.starts_at}〜${n.ends_at} の間有効）`);
    for (const h of f.hours) {
      const time = h.closed ? "休業" : `${h.opens ?? "?"}〜${h.closes ?? "?"}`;
      lines.push(`  ${h.label}: ${time}（適用期間 ${h.from}〜${h.to}）${h.note ? ` ${h.note}` : ""}`);
    }
    for (const o of f.offerings) {
      const price = o.price_jpy ? ` ${o.price_jpy.toLocaleString("ja-JP")}円` : "";
      lines.push(`  メニュー「${o.name}」${price}（提供期間 ${o.from}〜${o.to}）${o.description ? ` ${o.description}` : ""}`);
    }
    if (f.hours.length === 0 && f.notices.length === 0) lines.push("  営業時間: 情報なし");
  }
  for (const name of requested) {
    if (!facilities.some((f) => f.facility === name)) lines.push(`■${name}`, "  情報なし");
  }
  return lines.length ? lines.join("\n") : "情報なし";
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
