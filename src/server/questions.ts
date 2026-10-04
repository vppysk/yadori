import { z } from "zod";
import type { GapReason } from "@/lib/gap-reasons";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import type { Member } from "./auth";
import { ISO_TIMESTAMP, query, queryOne, transaction } from "./db";
import { insertDocument } from "./documents";
import { createSource } from "./info-sources";
import { recordLlmCall } from "./metrics";
import { tr } from "@/lib/i18n";

// 未回答の質問（plan 4.1、docs/004_knowledge_gap_review.md）: 会話ログの定期評価で見つけた「AIが答えられなかった質問」を一覧にし、
// 回答すると知識に入る。期間のない内容はよくある質問（RAG）、期間のある内容は資料（読み取り → 承認）にする

export type GapEvidence = {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  room_number: string | null;
  reason: GapReason;
  question: string;
  staff_answer: string | null;
  asked_at: string;
};

export type OpenGap = {
  id: string;
  question: string;
  ask_count: number;
  last_asked_at: string;
  draft_answer: string | null;
  evidences: GapEvidence[];
};

export async function listOpenGaps(hotelId: string): Promise<OpenGap[]> {
  return query<OpenGap>(
    `select g.id, g.question, g.ask_count, ${ISO_TIMESTAMP("g.last_asked_at")} last_asked_at, g.draft_answer,
       coalesce((
         select json_agg(json_build_object(
           'id', e.id, 'conversation_id', e.conversation_id, 'message_id', e.message_id, 'room_number', c.room_number, 'reason', e.reason,
           'question', e.question, 'staff_answer', e.staff_answer, 'asked_at', ${ISO_TIMESTAMP("e.asked_at")}
         ) order by e.asked_at desc)
         from knowledge_gap_evidences e left join conversations c on c.id = e.conversation_id where e.gap_id = g.id
       ), '[]') evidences
     from knowledge_gaps g
     where g.hotel_id = $1 and g.status = 'open'
     order by g.ask_count desc, g.last_asked_at desc`,
    [hotelId],
  );
}

export async function countOpenGaps(hotelId: string): Promise<number> {
  const row = await queryOne<{ n: number }>("select count(*)::int n from knowledge_gaps where hotel_id = $1 and status = 'open'", [hotelId]);
  return row?.n ?? 0;
}

export type ReviewRunSummary = { finished_at: string; conversations: number; new_gaps: number };

// 画面の「最終評価」: 最後に終わった定期評価
export async function lastReviewRun(hotelId: string): Promise<ReviewRunSummary | undefined> {
  return queryOne<ReviewRunSummary>(
    `select ${ISO_TIMESTAMP("finished_at")} finished_at, conversations, new_gaps from knowledge_review_runs
     where hotel_id = $1 and status = 'done' order by finished_at desc limit 1`,
    [hotelId],
  );
}

const destinationSchema = z.object({
  kind: z.enum(["faq", "source"]).describe("faq=日付で変わらない内容 / source=期間・日付・曜日・季節で変わる内容（営業時間の変更、季節のメニュー、休業日など）"),
  reason: z.string().describe("判断の理由（1文）"),
});

export type AnswerResult = { destination: "faq" } | { destination: "source"; sourceId: string };

// 回答を登録する。確定した回答文で登録先を判定し、期間のある内容は資料にして案内情報の確認・承認に回す（迷うときは資料）
export async function answerGap(member: Member, gapId: string, answer: string): Promise<AnswerResult> {
  const gap = await queryOne<{ question: string }>("select question from knowledge_gaps where id = $1 and hotel_id = $2 and status = 'open'", [
    gapId, member.hotel_id,
  ]);
  if (!gap) throw new Error(tr("この質問はすでに対応済みです", "This question has already been handled"));
  const text = tr(`質問: ${gap.question}\n\n回答: ${answer}`, `Question: ${gap.question}\n\nAnswer: ${answer}`);

  if (llmMode() === "mock") registerMockToolFixture("choose_destination", { kind: "faq", reason: "モック" });
  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: destinationSchema,
    name: "choose_destination",
    description: "ホテルの案内の回答を、どこに登録するか決める",
    system: [
      "ホテルのスタッフが書いた、ゲストの質問への回答を読み、期間・日付・曜日・季節によって内容が変わるかを判定する。",
      "変わる内容（例: 年末年始の営業時間、冬季休業、季節限定のメニュー、特定の日のイベント）は source、いつでも同じ内容（例: 設備の場所、貸し出し品の有無、周辺の施設）は faq。",
      "迷うときは source にする。",
    ].join("\n"),
    prompt: text,
  });
  await recordLlmCall({ hotelId: member.hotel_id, purpose: "knowledge_destination", thinking: false, usage });

  if (object.kind === "source") {
    // 資料はAIが施設・項目・期間を読み取り、案内情報でスタッフが承認したものだけを回答に使う
    const sourceId = await createSource(member, { title: tr(`未回答の質問から: ${gap.question}`, `From unanswered question: ${gap.question}`).slice(0, 200), fileName: null, body: text });
    await query(
      "update knowledge_gaps set status = 'answered', answer = $2, answered_by = $3, answered_at = now(), source_id = $4 where id = $1 and status = 'open'",
      [gapId, answer, member.id, sourceId],
    );
    return { destination: "source", sourceId };
  }
  await transaction(async (client) => {
    const { rowCount } = await client.query("select 1 from knowledge_gaps where id = $1 and status = 'open' for update", [gapId]);
    if (!rowCount) throw new Error(tr("この質問はすでに対応済みです", "This question has already been handled"));
    const documentId = await insertDocument(client, {
      hotelId: member.hotel_id,
      title: tr(`よくある質問: ${gap.question}`, `FAQ: ${gap.question}`),
      source: "answered_question",
      text,
      createdBy: member.id,
    });
    await client.query(
      "update knowledge_gaps set status = 'answered', answer = $2, answered_by = $3, answered_at = now(), document_id = $4 where id = $1",
      [gapId, answer, member.id, documentId],
    );
  });
  return { destination: "faq" };
}

// 「案内しない」: 知識には入れずに一覧から外す
export async function dismissGap(member: Member, gapId: string) {
  await query(
    "update knowledge_gaps set status = 'dismissed', answered_by = $2, answered_at = now() where id = $1 and hotel_id = $3 and status = 'open'",
    [gapId, member.id, member.hotel_id],
  );
}

export type ConversationMessage = { id: string; role: "user" | "assistant" | "staff"; content: string; created_at: string };

// 根拠の会話を読むだけの表示に使う
export async function getConversationMessages(hotelId: string, conversationId: string): Promise<ConversationMessage[]> {
  return query<ConversationMessage>(
    `select m.id, m.role, m.content, ${ISO_TIMESTAMP("m.created_at")} created_at
     from messages m join conversations c on c.id = m.conversation_id
     where m.conversation_id = $1 and c.hotel_id = $2 and m.role in ('user', 'assistant', 'staff')
     order by m.created_at`,
    [conversationId, hotelId],
  );
}
