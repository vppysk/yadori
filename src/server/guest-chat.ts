import { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai";
import { classifyLlmError, type LlmFailure } from "@/lib/llm/errors";
import { modelIdFor, type ModelTier } from "@/lib/llm/models";
import type { LlmUsage } from "@/lib/llm/structured";
import { generateAnswer, type Answer, type ConciergeContext } from "@/mastra/agents/concierge";
import { addDays, ISO_TIMESTAMP, query, queryOne } from "./db";
import { getGuestContext, type GuestContext } from "./guest-context";
import { checkReply, unansweredCount } from "./guardrails";
import { activeGuestRequest, cancelGuestRequest, createHandoff, type GuestRequest, type HandoffKind } from "./handoffs";
import { currentTimeBand, getAssignment, getHotel, localNow, type Hotel, type Pattern } from "./hotel";
import { cleanReply, fmtDate, noticeCitations, renderFacilities, type Citation } from "./answer-context";
import { autoUpdateCitations, getAutoUpdates, renderAutoUpdates, type AutoUpdate } from "./source-fetch";
import { getFacilityInfo, listFacilityNames, searchDocuments, type FacilityInfo } from "./knowledge";
import { recordLlmCall, recordWorkEvent } from "./metrics";
import { cancelDraft, listOpenDrafts, orderInstructions, orderReply, proposeOrder, submitDraft, type GuestOrderDraft, type OrderSummary, type SubmitOrderInput } from "./order-drafts";
import { checkOpenTicketsForComplaint, describeOpenTickets, followUpOrders, nudgeFromGuest, rescheduleOrders, rescheduleTicket } from "./order-checks";
import { getCatalog, listConversationTickets, listOpenOrderItems, type GuestTicket } from "./orders";
import { consultIntegrations } from "./integration-agent";
import { usageRules } from "./integrations/mcp";
import { allCheckBodies } from "./reply-checks";
import { route, type RouteResult } from "./router";

const HISTORY_LIMIT = 12;
export const GUEST_MESSAGE_HEADING = "【ゲストのメッセージ】";
// 回答の主担当を決める優先順（重いものを優先）
const PATTERN_PRIORITY: Pattern[] = ["complaint", "reservation", "external", "info", "order"];

export type { Citation };

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
  // ゲストが品目・数量を選ぶ前のお届けの依頼（選択欄）
  orderDrafts: GuestOrderDraft[];
  // 対応中の「スタッフと話す」の依頼。ヘッダーのボタンの表示に使う
  staffRequest: GuestRequest | null;
};

export async function getGuestSession(reservationId: string): Promise<GuestSession | undefined> {
  const guest = await getGuestContext(reservationId);
  if (!guest) return undefined;
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const [messages, tickets, orderDrafts, staffRequest] = await Promise.all([
    listMessages(conversationId),
    listConversationTickets(conversationId),
    listOpenDrafts(conversationId, hotel),
    activeGuestRequest(conversationId),
  ]);
  return {
    hotelName: hotel.name,
    timezone: hotel.timezone,
    guest: { roomNumber: guest.roomNumber, checkIn: guest.checkIn, checkOut: guest.checkOut },
    today: localNow(hotel.timezone).date,
    conversationId,
    messages,
    tickets,
    orderDrafts,
    staffRequest: staffRequest ?? null,
  };
}

// ヘッダーの「スタッフと話す」。会話を人に引き継ぐ（ガードレール: 必ず人に引き継ぐ条件）
export async function requestStaff(reservationId: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const band = await currentTimeBand(hotel);
  return handOffToStaff(hotel, guest, conversationId, "info", band?.id, "ゲストが画面の「スタッフと話す」を押した", { guestRequested: true });
}

// 「スタッフと話す」の取り消し（押し間違い用）。スタッフが引き受ける前だけ
export async function cancelStaffRequest(reservationId: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  const cancelled = await cancelGuestRequest(conversationId);
  if (!cancelled) {
    const accepted = (await activeGuestRequest(conversationId))?.status === "accepted";
    return { cancelled, error: accepted ? "スタッフがすでに対応を始めているため、取り消せませんでした。" : "取り消せるご依頼はありません。" };
  }
  await insertMessage(conversationId, "assistant", "スタッフへのご連絡を取り消しました。引き続きこちらでご質問ください。");
  return { cancelled };
}

// 選択欄の「この内容で依頼する」: チケットを作り、機械ロジックで割り当てる（docs/005_order.md 2章）
export async function submitOrder(reservationId: string, draftId: string, input: SubmitOrderInput) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  return submitDraft({ hotel, guest, conversationId, draftId, input });
}

// 未完了のご依頼の「時間を変更」（docs/005_order.md 6章）
export async function rescheduleOrder(reservationId: string, ticketId: string, date: string, time: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  const conversationId = await findOrCreateConversation(hotel, guest);
  return { message: await rescheduleTicket(hotel, { conversationId, ticketId, date, time, checkOut: guest.checkOut }) };
}

// 未完了のご依頼の「状況を確認する」（docs/005_order.md 6章）。担当者に状況を確認し、遅れていればクレームとして引き継ぐ
export async function nudgeOrder(reservationId: string, ticketId: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  return nudgeFromGuest(hotel, await findOrCreateConversation(hotel, guest), ticketId, guest.roomNumber);
}

export async function cancelOrder(reservationId: string, draftId: string) {
  const guest = await getGuestContext(reservationId);
  if (!guest) throw new Error(`予約が見つかりません: ${reservationId}`);
  const hotel = await getHotel(guest.hotelId);
  await cancelDraft(await findOrCreateConversation(hotel, guest), draftId);
}

async function handOffToStaff(
  hotel: Hotel,
  guest: GuestContext,
  conversationId: string,
  pattern: Pattern,
  timeBandId: string | undefined,
  summary: string,
  // ordered: 同じ発言のお届けの依頼の選択欄を出した（回答でそのことにも触れる）
  // messageId: 引き継ぎのきっかけになったゲストの発言（ボタンのときはなし）
  options: { kind?: HandoffKind; reply?: string; guestRequested?: boolean; ordered?: boolean; messageId?: string } = {},
) {
  const accepted = options.ordered ? "お届けの品は下の欄でお選びください。" : "";
  const handoffId = await createHandoff({
    hotelId: hotel.id, kind: options.kind ?? "talk_request", conversationId, roomNumber: guest.roomNumber, summary, guestRequested: options.guestRequested,
    messageId: options.messageId,
  });
  // すでに依頼を受けている会話では、引き継ぎ・通知・実績を重ねて作らない
  if (!handoffId) {
    const reply = `${accepted}すでにスタッフにおつなぎしています。こちらの画面でそのままお待ちください。`;
    await insertMessage(conversationId, "assistant", reply);
    return { reply, citations: [] as Citation[], tickets: await listConversationTickets(conversationId) };
  }
  const reply = options.reply ?? (options.ordered
    ? `${accepted}あわせてスタッフにおつなぎします。こちらの画面でそのままお待ちください。`
    : "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。");
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
  // スタッフと話している間（ゲストが求めた引き継ぎが未対応・対応中）は、AIは回答せず発言を記録するだけ。
  // 対応完了やゲストの取り消しでAIの応対に戻る
  if (await activeGuestRequest(conversationId)) {
    return { reply: null, citations: [] as Citation[], tickets: await listConversationTickets(conversationId), waitingForStaff: true };
  }
  const band = await currentTimeBand(hotel);
  const [catalog, facilityNames, openOrders] = await Promise.all([getCatalog(hotel.id), listFacilityNames(hotel.id), listOpenOrderItems(conversationId)]);

  // 未完了のご依頼を渡し、「タオルまだ？」のような催促を新しい依頼と取り違えないようにする
  const routed = await route(text, catalog, facilityNames, openOrders);
  await recordLlmCall({ hotelId: hotel.id, conversationId, messageId: userMessageId, purpose: "router", thinking: false, usage: routed.usage });
  const { intents } = routed.result;

  // ガードレール（前）: 必ず人に引き継ぐ条件（設定では変えられない。docs/007_ai_settings.md）
  if (routed.result.safety) {
    return handOffToStaff(hotel, guest, conversationId, intents[0]?.pattern ?? "order", band?.id, text, {
      kind: "safety",
      messageId: userMessageId,
      reply: "すぐにスタッフにおつなぎします。命に関わる緊急の場合は、ためらわず119番に通報してください。",
    });
  }
  // 未完了のご依頼への催促: 「状況を確認する」と同じく担当者に確認し、遅れていればクレームとして引き継ぐ（docs/005_order.md 6章）
  const reschedule = routed.result.order_reschedule;
  const today = localNow(hotel.timezone).date;
  // 未完了のご依頼のお届け時間の変更（日付は本日／明日だけ読み取らせ、ここで決める）
  const rescheduled = reschedule
    ? await rescheduleOrders(hotel, {
        conversationId, date: reschedule.day === "today" ? today : addDays(today, 1), time: reschedule.time, until: reschedule.until, checkOut: guest.checkOut,
      })
    : undefined;
  const followUp = [rescheduled, routed.result.order_follow_up ? await followUpOrders(hotel, conversationId, guest.roomNumber) : undefined]
    .filter(Boolean)
    .join("\n") || undefined;
  // お届けの依頼は選択欄を出し、ゲストが確定したときにチケットを作る（取り扱いのない品・品切れは引き継ぐ）
  const order = await proposeOrder({ hotel, guest, conversationId, messageId: userMessageId, text, intents });
  const complaints = intents.filter((i) => i.pattern === "complaint");
  // クレームと強い不満は人へ引き継ぐ（AIは一次受け止めのみ）
  for (const complaint of complaints) {
    await createHandoff({ hotelId: hotel.id, kind: "complaint", conversationId, roomNumber: guest.roomNumber, summary: complaint.summary, messageId: userMessageId });
  }
  if (complaints.length === 0 && routed.result.strong_emotion) {
    await createHandoff({ hotelId: hotel.id, kind: "complaint", conversationId, roomNumber: guest.roomNumber, summary: `強い不満: ${text}`, messageId: userMessageId });
  }
  // 未完了のオーダーがある会話での不満・催促（「まだ届かない」など）は、オーダーの催促として担当者に状況を確認する（docs/005_order.md 6章）
  if (!followUp && (complaints.length > 0 || routed.result.strong_emotion)) await checkOpenTicketsForComplaint(conversationId);
  // 「スタッフと話したい」: 同じ発言のオーダーとクレームの引き継ぎを済ませてから人へ（AIは回答しない）
  if (routed.result.wants_staff) {
    // オーダーの実績は発行時に記録済みのため、引き継ぎはオーダー以外の要望として数える
    const pattern = intents.find((i) => i.pattern !== "order")?.pattern ?? "info";
    return handOffToStaff(hotel, guest, conversationId, pattern, band?.id, text, {
      guestRequested: true, ordered: order?.draftId !== undefined, messageId: userMessageId,
    });
  }

  // お届けの依頼・催促だけの発言は、回答係を呼ばずに定型文で返す（品目・数量は選択欄で確定する）
  if ((order || followUp) && intents.every((i) => i.pattern === "order")) {
    const reply = [followUp, order ? orderReply(order) : ""].filter(Boolean).join("\n");
    await insertMessage(conversationId, "assistant", reply);
    return { reply, citations: [] as Citation[], tickets: await listConversationTickets(conversationId) };
  }

  const primary = PATTERN_PRIORITY.find((p) => intents.some((i) => i.pattern === p)) ?? "info";
  const assignment = await getAssignment(hotel.id, primary, band?.id);

  // 人に直接回す設定の業務（オーダーは受付済みなので除く）
  if (assignment.handler === "human" && primary !== "order") {
    await createHandoff({ hotelId: hotel.id, kind: "staff_assigned", conversationId, roomNumber: guest.roomNumber, summary: text, messageId: userMessageId });
    const reply = "担当のスタッフからご案内いたします。少々お待ちください。";
    await insertMessage(conversationId, "assistant", reply);
    await recordWorkEvent({ hotelId: hotel.id, conversationId, pattern: primary, timeBandId: band?.id, handlerKind: "human", handler: "引き継ぎ", outcome: "handed_off" });
    return { reply, citations: [] as Citation[], tickets: await listConversationTickets(conversationId) };
  }

  const tier: ModelTier = assignment.handler === "human" ? "small" : assignment.handler;
  // 外部の連携先が要る発言（周辺・外部の予約、予約・客室）は、連携係がツールを選んで調べる。書き込みは利用ルールで決められているときだけ積む
  const integrationFacts = intents.some((i) => i.pattern === "external" || i.pattern === "reservation")
    ? await consultIntegrations({ guest, conversationId, text, history })
    : undefined;
  const { answer, facilities, autoUpdates, failure } = await draftAnswer({
    hotel, guest, text, history, routed: routed.result, allFacilityNames: facilityNames, order, orderUpdate: followUp, integrationFacts: integrationFacts?.text,
    openTickets: await describeOpenTickets(conversationId, hotel.timezone),
    hasComplaint: complaints.length > 0, tier, thinking: assignment.thinking,
  });
  const usage: LlmUsage = answer?.usage ?? { modelId: modelIdFor(tier), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  // 答えられなかったか（ガードレールの「同じ会話で2回答えられなかった」と実績に使う）。未回答の質問の一覧は会話ログの定期評価で作る（knowledge-review.ts）
  // モデルが「確認します」と答えたのに一覧を空で返すことがあるため、そのときも答えられなかったとみなす
  const unanswered = answer?.unanswered_questions.length
    ? answer.unanswered_questions
    : answer && /スタッフに確認|確認して(ご連絡|お知らせ)/.test(answer.reply)
      ? [text]
      : [];
  // 指示してもマークダウンの強調・見出しを出すことがあるため取り除く
  const generated = cleanReply(answer?.reply ?? "");
  const failed = generated === "";
  if (failed) {
    // 例外がなく回答文だけが空だったときも、期待した出力が得られなかったものとして扱う
    const { cause, detail } = failure ?? { cause: "invalid_output" as const, detail: "回答文が空だった" };
    await createHandoff({
      hotelId: hotel.id, kind: "system_error", conversationId, roomNumber: guest.roomNumber, summary: `AIが回答を作れなかった質問: ${text}`,
      messageId: userMessageId, failure: { stage: "answer", cause, detail, modelId: usage.modelId },
    });
  }
  // ガードレール（後）: してはいけないことに反する回答はゲストに出さず、人に引き継ぐ
  const check = failed ? ({ ok: true } as const) : await checkReply(hotel.id, generated, conversationId);
  if (!check.ok) {
    console.warn("[guest-chat] ガードレールで回答を止めた", { rule: check.rule, reason: check.reason, generated });
    // チェック自体が失敗したときはシステムの不具合、違反と判定したときはガードレールによる引き継ぎ
    await createHandoff(
      check.failure
        ? {
            hotelId: hotel.id, kind: "system_error", conversationId, roomNumber: guest.roomNumber,
            summary: `AIの回答を確認できなかったため、ゲストに出していない。ゲストの発言: ${text}`, messageId: userMessageId,
            failure: { stage: "guardrail", cause: check.failure.cause, detail: `${check.failure.detail}\n止めた回答: ${generated}`, modelId: modelIdFor("medium") },
          }
        : {
            hotelId: hotel.id, kind: "guardrail_blocked", conversationId, roomNumber: guest.roomNumber,
            summary: `AIの回答が決まり「${check.rule}」に反したため止めた。ゲストの発言: ${text}`, messageId: userMessageId,
            failure: { detail: `理由: ${check.reason}\n止めた回答: ${generated}` },
          },
    );
  }
  // 同じ会話で2回答えられなかったら人へ
  const isUnanswered = failed || unanswered.length > 0;
  // 回答を作れなかったときはシステムの不具合として引き継ぎ済みのため重ねない
  if (!failed && isUnanswered && (await unansweredCount(conversationId)) >= 1) {
    await createHandoff({
      hotelId: hotel.id, kind: "unanswerable", conversationId, roomNumber: guest.roomNumber, summary: `同じ会話で2回答えられなかった。直近の質問: ${text}`,
      messageId: userMessageId,
    });
  }
  const reply = failed ? "確認してすぐにご連絡いたします。少々お待ちください。" : !check.ok ? "担当のスタッフから改めてご案内いたします。少々お待ちください。" : generated;
  const citations = failed ? [] : [...buildCitations(facilities, routed.result.facilities, reply, guest, today), ...autoUpdateCitations(autoUpdates, answer?.used_sources, reply)];

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

// 回答の下書き（DBには書かない）: 滞在日で館内情報を取り、指示を組み立てて回答係に答えさせる。
// ゲスト対応と、精密見積もりの再生（replay.ts）で共通に使う
export async function draftAnswer(params: {
  hotel: Hotel;
  guest: GuestContext;
  text: string;
  history: { role: string; content: string }[];
  routed: RouteResult;
  allFacilityNames: string[];
  order: OrderSummary | undefined;
  orderUpdate?: string; // 未完了のご依頼への催促・時間の変更に返した内容
  openTickets?: string[]; // 未完了のご依頼の状況（回答係はこれ以外のお届けの状況を言わない）
  hasComplaint: boolean;
  // 連携係が連携先から取得した情報（integration-agent.ts）
  integrationFacts?: string;
  tier: ModelTier;
  thinking: boolean;
}): Promise<{ answer: Answer | undefined; facilities: FacilityInfo[]; autoUpdates: AutoUpdate[]; failure?: LlmFailure }> {
  const { hotel, guest, text, history, routed, tier, thinking } = params;
  const intents = routed.intents;
  // 回答に使う知識をゲストの滞在日で取得する（ご滞在中は今日から、ご到着前は滞在期間。チェックアウト日の朝食なども含める）
  const today = localNow(hotel.timezone).date;
  const needsKnowledge = intents.some((i) => i.pattern === "info" || i.pattern === "external");
  // ご出発後のゲストは今日の情報で答える（チェックアウト日が今日より前だと期間が逆になる）
  const from = today > guest.checkIn ? today : guest.checkIn;
  // 承認して反映する資料（外部の資料も含む）は承認済みの値として、自動反映のURL（運行情報・天気など）は定期取得済みの要約として渡す
  // （その場で検索・取得はしない。docs/006_guide_info.md）
  const [facilities, documents, autoUpdates] = await Promise.all([
    needsKnowledge
      ? getFacilityInfo(hotel.id, { facilities: routed.facilities, from, to: guest.checkOut < from ? from : guest.checkOut, timezone: hotel.timezone })
      : [],
    needsKnowledge ? searchDocuments(hotel.id, text) : [],
    needsKnowledge ? getAutoUpdates(hotel.id) : [],
  ]);

  const instructions = await buildInstructions({
    hotel, guest, order: params.order, orderUpdate: params.orderUpdate, openTickets: params.openTickets, hasComplaint: params.hasComplaint,
    integrationFacts: params.integrationFacts, hasExternal: facilities.some((f) => f.fields.some((x) => x.values.some((v) => v.external))),
    hasAuto: autoUpdates.length > 0,
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
            text, needsKnowledge, facilities, documents, autoUpdates,
            // ルーターが選んだ施設（空なら全施設）。情報が1件もない施設も「情報なし」と明示する
            facilityNames: routed.facilities.length ? routed.facilities : params.allFacilityNames,
          }),
        } satisfies ModelMessage,
      ],
      requestContext,
    );
    return { answer, facilities, autoUpdates };
  } catch (error) {
    console.warn("[guest-chat] 回答を作れなかった", { modelId: modelIdFor(tier), error });
    return { answer: undefined, facilities, autoUpdates, failure: classifyLlmError(error) };
  }
}

async function buildInstructions(params: {
  hotel: Hotel;
  guest: GuestContext;
  order: OrderSummary | undefined;
  orderUpdate?: string; // 未完了のご依頼への催促・時間の変更に返した内容
  openTickets?: string[]; // 未完了のご依頼の状況（回答係はこれ以外のお届けの状況を言わない）
  hasComplaint: boolean;
  integrationFacts?: string;
  // 外部情報の資料から読み取った値を渡すか（出どころの添え方を指示に足す）
  hasExternal: boolean;
  // 自動取得の最新情報（自動反映のURL）を渡すか
  hasAuto: boolean;
}): Promise<string> {
  const { hotel, guest, order, orderUpdate, openTickets, hasComplaint, integrationFacts, hasExternal, hasAuto } = params;
  const [instruction, checks, rules] = await Promise.all([
    queryOne<{ body: string }>("select body from ai_instructions where hotel_id = $1 and scope = 'common'", [hotel.id]).then((r) => r?.body ?? ""),
    allCheckBodies(hotel.id),
    usageRules(hotel.id),
  ]);
  const now = localNow(hotel.timezone);
  const stayStatus = now.date < guest.checkIn ? "ご到着前" : now.date >= guest.checkOut ? "ご出発後" : "ご滞在中";
  // 連携先の情報（毎回読むゲストの情報と、連携係が調べた結果）に添える利用ルール
  const usedIntegrations = [...new Set(guest.preloaded.map((p) => p.integrationId))];
  const ruleLines = [...rules.entries()]
    .filter(([id]) => usedIntegrations.includes(id) || integrationFacts)
    .map(([, body]) => body);

  return [
    `あなたは「${hotel.name}」のゲスト向けアシスタント。日本語だけで、ゲストに直接話しかける文章だけを書く。`,
    "施設の営業時間・メニューなどの情報と特記事項は、ゲストの発言の前に付いている【最新の館内情報】だけを根拠に答える。書かれていないことは推測せず、スタッフに確認してご連絡すると伝える。",
    "日付の指定がなければ、ご滞在中なら今日、ご到着前ならご滞在の期間の情報で答える。期間によって違う場合は、どの日がどうなるかを分けて伝える。",
    "【特記事項】は通常の営業情報より優先する。特記事項がある日は、特記事項の内容で答え、通常との違いも伝える。",
    "「情報なし」の施設・項目について聞かれたら、時間などを推測せず、スタッフに確認してご連絡すると伝える。「情報なし」「特記事項」などの内部の表記はそのまま言わない。",
    "日付は「本日」「明日」「10/21」のように短く書く（年は書かない）。",
    "ご到着前のゲストには「現在」「本日」ではなく「ご滞在中（10/20〜10/23）は」のように滞在日を主語にして答える。",
    "館内の情報に書かれていないサービス（ルームサービスなど）を勧めない。",
    // AIがお届けの時刻を約束したが、チケットは変わっていなかった（2026-09-28）。手配の内容はシステムが決める
    "お届け（備品・飲み物）の時刻・時間の変更・到着の見込み・手配の完了を、自分から約束しない。お届けの状況は【ご依頼の状況】に書かれたことだけを伝える。時間を変えたいと言われたら、画面の「ご依頼の状況」の「時間を変更」から変えられると案内する。",
    // 好みを伺っただけの枕を「ご用意いたします」と約束した（2026-09-28）
    "お届けの依頼として受け付けていない品やサービス（好みとして伺っただけのものなど）を「ご用意します」「手配します」と約束しない。好みは「承りました。スタッフと共有いたします」までにする。",
        "答えられた質問には「スタッフに確認します」を付けない。",
    "営業時間などは、会話の中の過去の回答ではなく、必ず【最新の館内情報】で答える（情報は更新されていることがある）。",
    "ゲストの状況に書かれていない事実（到着からの経過時間など）を付け足さない。",
    "館内の情報・抜粋に書かれていないことは、あるともないとも断定しない（「ございません」「お断りしています」も言わない）。スタッフに確認してご連絡すると伝え、その質問を unanswered_questions に入れる。",
    "マークダウン記法（**や#）は使わない。",
    "",
    "## ホテルの指示",
    instruction,
    "",
    // 回答後にもチェックする（guardrails.ts）
    "## 必ず守ること",
    ...checks.map((c) => `・${c}`),
    "",
    "## ゲストの状況",
    `・今日: ${now.date} ${now.time}（${stayStatus}）`,
    `・ご滞在: ${guest.checkIn}（チェックイン）〜 ${guest.checkOut}（チェックアウト）、${guest.roomNumber}号室、${guest.adults}名`,
    ...(order ? orderInstructions(order) : []),
    ...(orderUpdate ? [`・未完了のご依頼について、次の内容を伝える（新しく手配したとは言わない）: ${orderUpdate}`] : []),
    "",
    "## ご依頼の状況（お届けについてはここに書かれたことだけを伝える）",
    ...(openTickets?.length ? openTickets.map((t) => `・${t}`) : ["・未完了のご依頼はない"]),
    ...(hasComplaint ? ["・不満の内容はスタッフに引き継ぎ済み。お詫びし、担当者から改めて連絡すると伝える"] : []),
    // 連携先（予約・客室管理システムなど）のゲストの情報と、連携係が調べた結果。現場が書いた利用ルールに沿って使う
    ...guest.preloaded.flatMap((p) => ["", `## ${p.integrationName}: ${p.description}`, p.text]),
    ...(integrationFacts ? ["", "## 連携先から取得した情報（ゲストの発言に関係するときだけ使う。書かれていないことは推測しない）", integrationFacts] : []),
    ...(ruleLines.length ? ["", "## 連携先の情報の使い方", ...ruleLines] : []),
    ...(hasAuto
      ? [
          "",
          "## 自動取得の最新情報の使い方",
          "・【自動取得の最新情報】は、ゲストの質問に関係するときだけ使い、時点を添える。書かれていないこと（運転再開の見込みなど）は推測しない",
          "・使った資料名を used_sources に入れる",
        ]
      : []),
    ...(hasExternal
      ? [
          "",
          "## 外部情報の使い方",
          "・「（外部情報: ○○）」と付いた内容はホテル以外が管理する情報。「（外部情報: …）」の表記はそのまま書かず、「○○によると」のように出どころを文の中で添える。書かれていないこと（運転再開の見込みなど）は推測しない",
        ]
      : []),
    // 外部の情報（運行情報・天気など）の扱い。旧 Webページの連携の読み取りルールを内部の決まりにした（docs/007_ai_settings.md 3.5）
    ...(hasAuto || hasExternal ? ["・運休や荒天のときは、代わりの手段や時間に余裕を持つことを提案し、詳しくはフロントにおつなぎすると伝える"] : []),
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
  autoUpdates: AutoUpdate[];
}): string {
  const { text, needsKnowledge, facilities, facilityNames, documents, autoUpdates } = params;
  if (!needsKnowledge) return text;
  return [
    "【最新の館内情報】（ゲストの滞在日にかかる期間のもの。会話の中の過去の回答より、必ずこちらを優先する）",
    renderFacilities(facilities, facilityNames),
    ...(documents.length ? ["", "【館内案内・マニュアルからの抜粋】", ...documents.map((d) => `・${d.title}: ${d.content}`)] : []),
    ...renderAutoUpdates(autoUpdates),
    "",
    GUEST_MESSAGE_HEADING,
    text,
  ].join("\n");
}

// ゲスト向けの根拠表示: 関係する施設の特記事項と、ご到着前なら滞在日で答えたこと
function buildCitations(facilities: FacilityInfo[], requested: string[], reply: string, guest: GuestContext, today: string): Citation[] {
  const citations: Citation[] = noticeCitations(facilities, requested, reply);
  const fields = facilities.flatMap((f) => f.fields);
  if (guest.checkIn > today && fields.some((x) => x.values.length > 0)) {
    // 適用期間は最初の項目（営業時間など）から出す。メニューの提供期間まで並べると読みにくいため
    const periods = [...new Set(facilities.flatMap((f) => (f.fields[0]?.values ?? []).map((v) => `${fmtDate(v.from)}〜${v.to ? fmtDate(v.to) : ""}`)))];
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
