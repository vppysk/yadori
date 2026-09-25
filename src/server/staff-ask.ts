import { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai";
import { modelIdFor } from "@/lib/llm/models";
import { generateAnswer, type ConciergeContext } from "@/mastra/agents/concierge";
import type { LlmUsage } from "@/lib/llm/structured";
import { fmtDate, noticeCitations, renderFacilities, type Citation } from "./answer-context";
import type { Member } from "./auth";
import { addDays, query, queryOne } from "./db";
import { getHotel, localNow } from "./hotel";
import { getFacilityInfo, listFacilityNames, searchDocuments } from "./knowledge";
import { recordLlmCall } from "./metrics";

// スタッフ向けの相談相手（plan 4.1）: 新人が、ゲストと同じ知識ベース（マスタ・特記事項・マニュアル）に質問できる
const HISTORY_LIMIT = 10;

export type AskMessage = { id: string; role: "user" | "assistant"; content: string; citations: Citation[] | null };

async function conversationFor(member: Member): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    "select id from conversations where channel = 'staff_ask' and staff_member_id = $1 order by started_at desc limit 1",
    [member.id],
  );
  if (existing) return existing.id;
  const [{ id }] = await query<{ id: string }>(
    "insert into conversations (hotel_id, channel, staff_member_id) values ($1, 'staff_ask', $2) returning id",
    [member.hotel_id, member.id],
  );
  return id;
}

export async function listAskMessages(member: Member): Promise<AskMessage[]> {
  const conversationId = await conversationFor(member);
  const rows = await query<AskMessage>(
    "select id, role, content, citations from messages where conversation_id = $1 order by created_at desc limit 40",
    [conversationId],
  );
  return rows.reverse();
}

export async function askAi(member: Member, text: string) {
  const hotel = await getHotel(member.hotel_id);
  const conversationId = await conversationFor(member);
  const history = (await listAskMessages(member)).slice(-HISTORY_LIMIT);
  await query("insert into messages (conversation_id, role, content) values ($1, 'user', $2)", [conversationId, text]);

  // 今日と明日の営業情報・特記事項は全施設分を渡す（1ホテル分なら小さい）。マニュアルは質問で検索する
  const today = localNow(hotel.timezone).date;
  const [facilities, facilityNames, documents] = await Promise.all([
    getFacilityInfo(hotel.id, { from: today, to: addDays(today, 1), timezone: hotel.timezone }),
    listFacilityNames(hotel.id),
    searchDocuments(hotel.id, text),
  ]);
  const now = localNow(hotel.timezone);
  const instructions = [
    `あなたは「${hotel.name}」のスタッフ向けの相談相手。新人スタッフの質問に、館内のルール・マニュアル・今日の営業情報をもとに短く具体的に答える。`,
    "下の情報に書かれていないことは推測せず、あるともないとも断定せずに「上長に確認してください」と答える。",
    "【特記事項】は通常の営業情報より優先する。マークダウン記法は使わない。",
    "質問の前に付いている【最新の館内情報】を根拠にする。会話の中の過去の回答より、必ずこちらを優先する。",
    `今日: ${now.date} ${now.time}`,
  ].join("\n");
  // 館内の情報は最後の質問と一緒に渡す（過去の回答の繰り返しを防ぐ。guest-chat.ts の withLatestKnowledge と同じ理由）
  const latest = [
    "【最新の館内情報】（今日と明日）",
    renderFacilities(facilities, facilityNames),
    ...(documents.length ? ["", "【館内案内・マニュアルからの抜粋】", ...documents.map((d) => `・${d.title}: ${d.content}`)] : []),
    "",
    "【スタッフの質問】",
    text,
  ].join("\n");

  const requestContext = new RequestContext<ConciergeContext>();
  requestContext.set("tier", "medium");
  requestContext.set("thinking", false);
  requestContext.set("instructions", instructions);
  let reply = "うまく答えられませんでした。上長に確認してください。";
  let usage: LlmUsage = { modelId: modelIdFor("medium"), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  try {
    const answer = await generateAnswer(
      { tier: "medium", thinking: false, instructions },
      [
        ...history.map((m): ModelMessage => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content })),
        { role: "user", content: latest } satisfies ModelMessage,
      ],
      requestContext,
    );
    reply = answer.reply.replace(/\*\*|__|^#+\s*/gm, "").trim() || reply;
    usage = answer.usage;
  } catch (error) {
    console.warn("[staff-ask] 回答を作れなかった", error);
  }

  // 根拠: 関係する施設の特記事項と、使ったマニュアル（類似度の高いもの）
  const citations: Citation[] = [
    ...noticeCitations(facilities, [], `${text}\n${reply}`),
    ...documents.filter((d) => d.similarity > 0.5).slice(0, 2).map((d) => ({ kind: "document" as const, label: `${d.title}（更新 ${fmtDate(d.updated_at)}）` })),
  ];
  const [{ id }] = await query<{ id: string }>(
    "insert into messages (conversation_id, role, content, citations) values ($1, 'assistant', $2, $3) returning id",
    [conversationId, reply, citations.length ? JSON.stringify(citations) : null],
  );
  await recordLlmCall({ hotelId: hotel.id, conversationId, messageId: id, purpose: "staff_ask", pattern: "info", thinking: false, usage });
}
