import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import { TALK_CAUSE_KEYS, type TalkCause } from "@/lib/talk-causes";
import { ISO_TIMESTAMP, query, queryOne } from "./db";
import { recordLlmCall } from "./metrics";

// 「人と話したい」の理由の分類（docs/000_plan.md 4.3）。会話ログの定期評価（knowledge-review.ts）から呼ぶ。
// 引き継ぎの直前まで会話を読み、AIの応対が原因かを分ける。直前のAIの回答のモデル・業務・時間帯を残し、モデルごとの品質の比較に使う

// 遡る範囲（まだ分類していない引き継ぎだけを見る）
const LOOKBACK_DAYS = 7;
const MESSAGE_LIMIT = 16;

const causeSchema = z.object({
  cause: z
    .enum(TALK_CAUSE_KEYS as [TalkCause, ...TalkCause[]])
    .describe(
      "no_info=AIが情報がなく答えられなかった・確認すると保留した / wrong_answer=AIの答えが誤り・古い（ゲストが否定した） / misunderstood=AIが質問の意図を取り違えた・的外れ / tone=AIの言い方・態度に不満 / not_possible=返金・例外・予約の確定などAIでは対応できない依頼 / initial=AIの回答に関係なく最初から人を希望 / emotion=不安・怒り・急ぎなど感情や緊急性 / other=それ以外",
    ),
  reason: z.string().describe("判断の根拠（会話のどの発言からそう判断したか、1文）"),
});

export async function reviewTalkRequests(hotelId: string): Promise<number> {
  const targets = await query<{ id: string; conversation_id: string; created_at: string }>(
    `select h.id, h.conversation_id, ${ISO_TIMESTAMP("h.created_at")} created_at from handoffs h
     where h.hotel_id = $1 and h.kind = 'talk_request' and h.conversation_id is not null
       and h.created_at > now() - make_interval(days => $2)
       and not exists (select 1 from talk_request_reviews r where r.handoff_id = h.id)
     order by h.created_at`,
    [hotelId, LOOKBACK_DAYS],
  );
  let cost = 0;
  for (const t of targets) cost += await reviewOne(hotelId, t);
  return cost;
}

async function reviewOne(hotelId: string, handoff: { id: string; conversation_id: string; created_at: string }): Promise<number> {
  // 直前のAIの回答（モデル・業務）と、そのときの時間帯
  const answer = await queryOne<{ model_id: string; pattern: string | null; created_at: string }>(
    `select model_id, pattern, ${ISO_TIMESTAMP("created_at")} created_at from llm_calls
     where conversation_id = $1 and purpose = 'answer' and created_at <= $2 order by created_at desc limit 1`,
    [handoff.conversation_id, handoff.created_at],
  );
  const band = answer
    ? await queryOne<{ time_band_id: string | null }>(
        `select time_band_id from work_events where conversation_id = $1 and handler_kind = 'ai' and occurred_at <= $2 order by occurred_at desc limit 1`,
        [handoff.conversation_id, handoff.created_at],
      )
    : undefined;
  const save = (cause: TalkCause, reason: string | null) =>
    query(
      `insert into talk_request_reviews (handoff_id, hotel_id, conversation_id, cause, reason, model_id, pattern, time_band_id, requested_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (handoff_id) do nothing`,
      [handoff.id, hotelId, handoff.conversation_id, cause, reason, answer?.model_id ?? null, answer?.pattern ?? null, band?.time_band_id ?? null, handoff.created_at],
    );
  // AIが一度も答えていなければ、AIの応対が原因ではない（LLMを呼ばない）
  if (!answer) {
    await save("initial", "AIの回答の前に人を希望した");
    return 0;
  }

  const messages = await query<{ role: string; content: string }>(
    `select role, content from (
       select role, content, created_at from messages where conversation_id = $1 and role in ('user', 'assistant') and created_at <= $2
       order by created_at desc limit $3
     ) x order by created_at`,
    [handoff.conversation_id, handoff.created_at, MESSAGE_LIMIT],
  );
  if (llmMode() === "mock") registerMockToolFixture("classify_talk_request", { cause: "other", reason: "モック" });
  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: causeSchema,
    name: "classify_talk_request",
    description: "ゲストがスタッフとの会話を希望した理由を分類する",
    system: [
      "ホテルのAIコンシェルジュとゲストの会話を読み、最後にゲストが「スタッフと話したい」と求めた理由を1つ選ぶ。",
      "目的は、AIの応対の改善につながるもの（情報不足・誤り・意図の取り違え・言い方）と、そもそも人が対応すべきもの・ゲストの好みを分けること。",
      "AIの答えに問題が見当たらず、ゲストが最初から人を望んでいたなら initial にする。推測で AI の問題にしない。",
    ].join("\n"),
    prompt: messages.map((m, i) => `${i + 1}. ${m.role === "user" ? "ゲスト" : "AI"}: ${m.content}`).join("\n") + "\n（ここでゲストがスタッフとの会話を希望）",
  });
  await save(object.cause, object.reason.trim() || null);
  return recordLlmCall({ hotelId, conversationId: handoff.conversation_id, purpose: "talk_review", thinking: false, usage });
}
