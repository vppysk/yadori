import { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai";
import { modelIdFor } from "@/lib/llm/models";
import { generateAnswer, type ConciergeContext } from "@/mastra/agents/concierge";
import type { LlmUsage } from "@/lib/llm/structured";
import { cleanReply, fmtDate, noticeCitations, renderFacilities, type Citation } from "./answer-context";
import { autoUpdateCitations, getAutoUpdates, renderAutoUpdates } from "./source-fetch";
import type { Member } from "./auth";
import { addDays, ISO_TIMESTAMP, query, queryOne } from "./db";
import { getHotel, localNow } from "./hotel";
import { getFacilityInfo, listFacilityNames, searchDocuments } from "./knowledge";
import { recordLlmCall } from "./metrics";
import { consultIntegrations } from "./integration-agent";
import { resolveGuests, type GuestMention } from "./staff-ask-guests";
import { staffAskTier } from "./ai-jobs";
import { isEn, tr } from "@/lib/i18n";

const UNTITLED = tr("（無題）", "(untitled)");

// スタッフ向けの相談相手（plan 4.1）: 新人が、ゲストと同じ知識ベース（マスタ・特記事項・マニュアル）に質問できる。
// 会話（セッション）は人ごとに複数持てる。特定のゲストに言及すると、予約・客室管理システムと対応アラートから情報を取る（staff-ask-guests.ts）
const HISTORY_LIMIT = 10;
const TITLE_LENGTH = 40;

export type AskMessage = { id: string; role: "user" | "assistant"; content: string; citations: Citation[] | null; mentions: GuestMention[] | null };
export type AskSession = { id: string; title: string; updated_at: string };

// 自分の会話だけを開ける（削除したものは除く）
async function ownSession(member: Member, sessionId: string): Promise<{ id: string; title: string | null } | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
  return queryOne<{ id: string; title: string | null }>(
    "select id, title from conversations where id = $1 and channel = 'staff_ask' and staff_member_id = $2 and archived_at is null",
    [sessionId, member.id],
  );
}

export async function listAskSessions(member: Member): Promise<AskSession[]> {
  return query<AskSession>(
    `select c.id, coalesce(c.title, '${UNTITLED}') title, ${ISO_TIMESTAMP("coalesce(max(m.created_at), c.started_at)")} updated_at
     from conversations c left join messages m on m.conversation_id = c.id
     where c.channel = 'staff_ask' and c.staff_member_id = $1 and c.archived_at is null
     group by c.id having count(m.id) > 0
     order by max(m.created_at) desc limit 50`,
    [member.id],
  );
}

export async function getAskSession(member: Member, sessionId: string): Promise<{ id: string; title: string; messages: AskMessage[] } | undefined> {
  const session = await ownSession(member, sessionId);
  if (!session) return undefined;
  return { id: session.id, title: session.title ?? UNTITLED, messages: await listMessages(session.id) };
}

async function listMessages(conversationId: string): Promise<AskMessage[]> {
  const rows = await query<AskMessage>(
    "select id, role, content, citations, mentions from messages where conversation_id = $1 order by created_at desc limit 40",
    [conversationId],
  );
  return rows.reverse();
}

export async function archiveAskSession(member: Member, sessionId: string) {
  await query("update conversations set archived_at = now() where id = $1 and channel = 'staff_ask' and staff_member_id = $2", [sessionId, member.id]);
}

// 質問を送る。sessionId がなければ新しい会話を作り、その会話のIDを返す。
// guests: 画面で選んだゲスト（予約番号）。ゲストの参照を許されていない人（canViewGuests=false）は、選択も文からの照合もしない
export async function askAi(
  member: Member,
  params: { sessionId: string | null; text: string; guestIds: string[]; canViewGuests: boolean },
): Promise<{ sessionId: string; mentions: GuestMention[] }> {
  const { text } = params;
  const hotel = await getHotel(member.hotel_id);
  const today = localNow(hotel.timezone).date;
  const session = params.sessionId ? await ownSession(member, params.sessionId) : undefined;
  if (params.sessionId && !session) throw new Error(tr("会話が見つかりません", "Conversation not found"));
  const conversationId =
    session?.id ??
    (
      await query<{ id: string }>("insert into conversations (hotel_id, channel, staff_member_id, title) values ($1, 'staff_ask', $2, $3) returning id", [
        member.hotel_id, member.id, text.replace(/\s+/g, " ").slice(0, TITLE_LENGTH),
      ])
    )[0].id;
  const history = session ? (await listMessages(conversationId)).slice(-HISTORY_LIMIT) : [];

  const previous = history.findLast((m) => m.role === "user")?.mentions ?? [];
  const guests = params.canViewGuests
    ? await resolveGuests({ hotelId: hotel.id, today, text, selectedIds: params.guestIds, previous, staffMemberId: member.id })
    : { mentions: [], context: null, guests: [] };
  await query("insert into messages (conversation_id, role, content, mentions) values ($1, 'user', $2, $3)", [
    conversationId, text, guests.mentions.length ? JSON.stringify(guests.mentions) : null,
  ]);

  // 今日と明日の営業情報・特記事項は全施設分を渡す（1ホテル分なら小さい）。マニュアルは質問で検索する
  // 話題のゲストが1人なら、連携係が連携先を調べる（読み取りだけ。相談しているスタッフにも権限があるツールだけ。docs/007_ai_settings.md）
  const [facilities, facilityNames, documents, autoUpdates, integrationFacts] = await Promise.all([
    getFacilityInfo(hotel.id, { from: today, to: addDays(today, 1), timezone: hotel.timezone }),
    listFacilityNames(hotel.id),
    searchDocuments(hotel.id, text),
    getAutoUpdates(hotel.id),
    guests.guests.length === 1
      ? consultIntegrations({ guest: guests.guests[0], conversationId, text, history, staffMemberId: member.id })
      : undefined,
  ]);
  const now = localNow(hotel.timezone);
  const instructions = [
    `あなたは「${hotel.name}」のスタッフ向けの相談相手。新人スタッフの質問に、館内のルール・マニュアル・今日の営業情報をもとに短く具体的に答える。`,
    "下の情報に書かれていないことは推測せず、あるともないとも断定せずに「上長に確認してください」と答える。",
    "【特記事項】は通常の営業情報より優先する。マークダウン記法は使わない。",
    "質問の前に付いている【最新の館内情報】を根拠にする。会話の中の過去の回答より、必ずこちらを優先する。",
    "「（外部情報: ○○）」と付いた内容はホテル以外が管理する情報（運行情報・周辺施設など）。質問に関係するときだけ使い、「（外部情報: …）」の表記はそのまま書かず「○○によると」と出どころを添える。",
    "【自動取得の最新情報】（運行情報・天気など）は質問に関係するときだけ使い、時点を添える。使った資料名を used_sources に入れる。",
    "【話題のゲスト】は予約・客室管理システムと対応アラートから取った、そのゲストの情報。書かれていることだけを使い、書かれていない要望や経緯を推測しない。料金・支払いは見られないので「フロントで確認してください」と答える。",
    "当てはまる予約が複数あるときや見つからないときは、推測で1人に決めず、部屋番号かお名前を確かめるよう返す。ゲストの話題でない質問には【話題のゲスト】を使わない。",
    `今日: ${now.date} ${now.time}`,
    ...(isEn ? ["Answer in English (the information below may be in Japanese; translate it). Instead of 「上長に確認してください」, say \"Please check with your supervisor.\""] : []),
  ].join("\n");
  // 館内の情報は最後の質問と一緒に渡す（過去の回答の繰り返しを防ぐ。guest-chat.ts の withLatestKnowledge と同じ理由）
  const latest = [
    "【最新の館内情報】（今日と明日）",
    renderFacilities(facilities, facilityNames),
    ...(documents.length ? ["", "【館内案内・マニュアルからの抜粋】", ...documents.map((d) => `・${d.title}: ${d.content}`)] : []),
    ...renderAutoUpdates(autoUpdates),
    ...(guests.context ? ["", guests.context] : []),
    ...(integrationFacts ? ["", "【連携先から取得した情報】（話題のゲストについて。質問に関係するときだけ使う）", integrationFacts.text] : []),
    "",
    "【スタッフの質問】",
    text,
  ].join("\n");

  // モデルは定期評価で見直す（試験運用中は一部を試すモデルで処理する。docs/000_plan.md 4.3）
  const tier = await staffAskTier(hotel.id);
  const requestContext = new RequestContext<ConciergeContext>();
  requestContext.set("tier", tier);
  requestContext.set("thinking", false);
  requestContext.set("instructions", instructions);
  let reply = tr("うまく答えられませんでした。上長に確認してください。", "I couldn't answer that. Please check with your supervisor.");
  let usedSources: string[] | undefined;
  let usage: LlmUsage = { modelId: modelIdFor(tier), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  // 答えられなかったか（モデルごとの品質の比較に使う。docs/000_plan.md 4.3）
  let unanswered = true;
  try {
    const answer = await generateAnswer(
      { tier, thinking: false, instructions },
      [
        ...history.map((m): ModelMessage => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content })),
        { role: "user", content: latest } satisfies ModelMessage,
      ],
      requestContext,
    );
    reply = cleanReply(answer.reply) || reply;
    usage = answer.usage;
    usedSources = answer.used_sources;
    unanswered = answer.unanswered_questions.length > 0 || /上長に確認|check with your supervisor/i.test(reply);
  } catch (error) {
    console.warn("[staff-ask] 回答を作れなかった", error);
  }

  // 根拠: 関係する施設の特記事項と、使ったマニュアル（類似度の高いもの）と、使った自動取得の情報
  const citations: Citation[] = [
    ...noticeCitations(facilities, [], `${text}\n${reply}`),
    ...documents.filter((d) => d.similarity > 0.5).slice(0, 2).map((d) => ({ kind: "document" as const, label: tr(`${d.title}（更新 ${fmtDate(d.updated_at)}）`, `${d.title} (updated ${fmtDate(d.updated_at)})`) })),
    ...autoUpdateCitations(autoUpdates, usedSources, reply),
  ];
  const [{ id }] = await query<{ id: string }>(
    "insert into messages (conversation_id, role, content, citations) values ($1, 'assistant', $2, $3) returning id",
    [conversationId, reply, citations.length ? JSON.stringify(citations) : null],
  );
  await recordLlmCall({ hotelId: hotel.id, conversationId, messageId: id, purpose: "staff_ask", pattern: "info", thinking: false, usage, unanswered });
  return { sessionId: conversationId, mentions: guests.mentions };
}
