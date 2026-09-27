import { z } from "zod";
import { GAP_REASONS } from "@/lib/gap-reasons";
import { embed } from "@/lib/llm/embeddings";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import { ISO_TIMESTAMP, query, queryOne } from "./db";
import { getHotel, localNow } from "./hotel";
import { recordLlmCall } from "./metrics";

// 会話ログの定期評価（docs/004_knowledge_gap_review.md）: 前回以降にゲストの発言があった会話を読み、
// AIが答えられなかった質問を見つけて追記の提案（knowledge_gaps）にまとめる。スタッフが代わりに答えていれば回答の下書きにする

// 1日1回、ホテル現地のこの時刻を過ぎたら実行する
const RUN_AFTER = "03:00";
// 時刻はミリ秒までのISO文字列で扱う（文字列のまま比較できる）。DBの比較も date_trunc でミリ秒にそろえ、境目の発言を二重に数えない
const MS = (column: string) => `date_trunc('milliseconds', ${column})`;
// 前回の記録がないときに遡る範囲
const FIRST_LOOKBACK_HOURS = 24;
// 実行中のまま止まった記録を失敗とみなす時間
const STALE_MINUTES = 60;
// 未処理の提案と同じ質問とみなす類似度（コサイン類似度）
const SAME_QUESTION_SIMILARITY = 0.85;
const MESSAGE_LIMIT = 200;

const reviewSchema = z.object({
  questions: z
    .array(
      z.object({
        message_no: z.number().int().describe("質問したゲストの発言の番号（【評価対象】の発言だけ）"),
        kind: z
          .enum(["info", "reservation", "request", "complaint", "talk_to_staff", "emergency", "other"])
          .describe(
            "info=ホテルの施設・サービス・周辺の情報を尋ねる質問 / reservation=本人の予約の確認・変更 / request=お届けなどの依頼 / complaint=苦情・不満・値引きの要望 / talk_to_staff=スタッフと話したい / emergency=急病・けが / other=それ以外",
          ),
        question: z.string().describe("質問を、部屋番号・氏名・日付・人数などの個人の事情を除いた一般的な形で短く1文にしたもの（例: 「子どもが熱を出したので近くの病院を知りたい」→「近くで夜間に診てもらえる病院はありますか」）"),
        reason: z.enum(GAP_REASONS).describe(
          "ai_deferred=AIが「確認します」などと答えを保留した / ai_guessed=AIが根拠のない推測やあいまいな答えをした / guest_unsatisfied=ゲストが聞き直した・納得していない / staff_answered=AIではなくスタッフが答えた / handed_off=AIが答える前にスタッフに引き継いだ / ai_failed=AIが回答を作れなかった",
        ),
        staff_answer: z
          .string()
          .optional()
          .describe("スタッフがこの質問の答えになる情報を伝えていれば、その内容（名前や「（スタッフ ○○）」は除く）。「確認して折り返します」など情報のない返信なら入れない"),
      }),
    )
    .describe("AIが答えられなかったゲストの発言。なければ空"),
});

const draftSchema = z.object({
  has_information: z.boolean().describe("スタッフの答えに、質問への具体的な情報が含まれているか（「確認して折り返します」だけなら false）"),
  answer: z.string().describe("ゲストへの案内として使える回答文（has_information が false なら空）"),
});

export type ReviewResult = { skipped?: string; runId?: string; conversations?: number; questions?: number; newGaps?: number };

// cron から1分ごとに呼ばれる。その日の分がまだで、実行時刻を過ぎていれば評価する
export async function runKnowledgeReviewIfDue(hotelId: string): Promise<ReviewResult> {
  const hotel = await getHotel(hotelId);
  const now = localNow(hotel.timezone);
  if (now.time < RUN_AFTER) return { skipped: "実行時刻前" };
  await query(
    `update knowledge_review_runs set status = 'failed', finished_at = now(), error = '実行中のまま止まった'
     where hotel_id = $1 and status = 'running' and started_at < now() - make_interval(mins => $2)`,
    [hotelId, STALE_MINUTES],
  );
  const today = await queryOne<{ id: string }>(
    `select id from knowledge_review_runs
     where hotel_id = $1 and status in ('running', 'done') and (started_at at time zone $2)::date = $3::date limit 1`,
    [hotelId, hotel.timezone, now.date],
  );
  if (today) return { skipped: "本日分は実行済み" };
  return runKnowledgeReview(hotelId);
}

export async function runKnowledgeReview(hotelId: string): Promise<ReviewResult> {
  const previous = await queryOne<{ cursor: string | null }>(
    `select ${ISO_TIMESTAMP("cursor")} cursor from knowledge_review_runs where hotel_id = $1 and status = 'done' order by started_at desc limit 1`,
    [hotelId],
  );
  const run = await queryOne<{ id: string; started_at: string }>(
    `insert into knowledge_review_runs (hotel_id) values ($1) returning id, ${ISO_TIMESTAMP("started_at")} started_at`,
    [hotelId],
  );
  const runId = run!.id;
  const from = previous?.cursor ?? new Date(Date.now() - FIRST_LOOKBACK_HOURS * 3_600_000).toISOString();
  let cost = 0;
  let questionCount = 0;
  let newGaps = 0;
  try {
    const conversations = await targetConversations(hotelId, from, run!.started_at);
    const touched = new Set<string>();
    for (const conversation of conversations) {
      const found = await reviewConversation(hotelId, conversation.id, from);
      cost += found.cost;
      for (const item of found.questions) {
        questionCount++;
        const { gapId, created } = await addToGap(hotelId, runId, conversation.id, item);
        if (created) newGaps++;
        if (item.staff_answer) touched.add(gapId);
      }
    }
    for (const gapId of touched) cost += await draftAnswer(hotelId, gapId);
    const cursor = conversations.reduce<string | null>((max, c) => (!max || c.last_at > max ? c.last_at : max), null) ?? from;
    await query(
      `update knowledge_review_runs set status = 'done', finished_at = now(), cursor = $2, conversations = $3, questions = $4, new_gaps = $5, cost_usd = $6
       where id = $1`,
      [runId, cursor, conversations.length, questionCount, newGaps, cost],
    );
    return { runId, conversations: conversations.length, questions: questionCount, newGaps };
  } catch (error) {
    console.error("[knowledge-review] 評価に失敗", error);
    await query("update knowledge_review_runs set status = 'failed', finished_at = now(), cost_usd = $2, error = $3 where id = $1", [
      runId, cost, String(error).slice(0, 1000),
    ]);
    throw error;
  }
}

// 前回以降にゲストの発言があった会話。オーダーの受付だけで終わった会話（実績がオーダーだけで、引き継ぎもスタッフの返信もない）は評価しない
async function targetConversations(hotelId: string, from: string, to: string) {
  return query<{ id: string; last_at: string }>(
    `select c.id, ${ISO_TIMESTAMP("max(m.created_at)")} last_at
     from conversations c join messages m on m.conversation_id = c.id and m.role = 'user' and ${MS("m.created_at")} > $2 and m.created_at <= $3
     where c.hotel_id = $1 and c.channel = 'guest'
       and not (
         exists (select 1 from work_events w where w.conversation_id = c.id and w.occurred_at > $2 and w.pattern = 'order')
         and not exists (select 1 from work_events w where w.conversation_id = c.id and w.occurred_at > $2 and w.pattern <> 'order')
         and not exists (select 1 from handoffs h where h.conversation_id = c.id and h.created_at > $2)
         and not exists (select 1 from messages s where s.conversation_id = c.id and s.role = 'staff' and s.created_at > $2)
       )
     group by c.id
     order by last_at`,
    [hotelId, from, to],
  );
}

type FoundQuestion = z.infer<typeof reviewSchema>["questions"][number] & { messageId: string; askedAt: string };

async function reviewConversation(hotelId: string, conversationId: string, from: string): Promise<{ questions: FoundQuestion[]; cost: number }> {
  const messages = await query<{ id: string; role: string; content: string; created_at: string }>(
    `select id, role, content, ${ISO_TIMESTAMP("created_at")} created_at from (
       select id, role, content, created_at from messages where conversation_id = $1 and role in ('user', 'assistant', 'staff')
       order by created_at desc limit $2
     ) x order by x.created_at`,
    [conversationId, MESSAGE_LIMIT],
  );
  const handoffs = await query<{ kind: string; created_at: string }>(`select kind, ${ISO_TIMESTAMP("created_at")} created_at from handoffs where conversation_id = $1 order by created_at`, [
    conversationId,
  ]);
  if (llmMode() === "mock") registerMockToolFixture("review_conversation", { questions: [] });

  // 会話を番号付きの文字にする。前回以降のゲストの発言に【評価対象】を付け、引き継ぎの時点も書き入れる
  const lines: string[] = [];
  let h = 0;
  for (const [i, m] of messages.entries()) {
    while (h < handoffs.length && handoffs[h].created_at <= m.created_at) lines.push(`（ここでスタッフに引き継ぎ: ${handoffs[h++].kind}）`);
    const who = m.role === "user" ? "ゲスト" : m.role === "staff" ? "スタッフ" : "AI";
    const target = m.role === "user" && m.created_at > from ? "【評価対象】" : "";
    lines.push(`${i + 1}. ${target}${who}: ${m.content}`);
  }
  while (h < handoffs.length) lines.push(`（ここでスタッフに引き継ぎ: ${handoffs[h++].kind}）`);

  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: reviewSchema,
    name: "review_conversation",
    description: "ホテルのゲストとの会話から、AIが答えられなかった質問を抜き出す",
    system: [
      "ホテルのAIコンシェルジュとゲストの会話を読み、AIが答えられなかったゲストの質問を抜き出す。目的は、館内・周辺の情報の不足を見つけて、次からAIが答えられるように情報を追加すること。",
      "【評価対象】の付いたゲストの発言に含まれる質問だけを見る。",
      "抜き出すのは、ホテルの施設・サービス・周辺について情報を尋ねる質問で、答えを用意しておけば他のゲストにも同じ答えが使えるものだけ（例: 近くにコインランドリーはあるか、駐車場は予約が必要か、大浴場にタオルはあるか）。",
      "次のものは抜き出さない: AIが具体的に答えられた質問／ゲスト個人の予約の確認・変更（「私の予約は何泊？」「夕食の時間を変えたい」）／備品のお届けなどの依頼／苦情・不満（「うるさい」「暑い」）／値引き・補償の要望／「スタッフと話したい」／急病・けがなど緊急の相談／挨拶。",
      "スタッフが代わりに答えていれば、その内容を staff_answer に入れる（「フロントの山本です」などの名乗りと「（スタッフ ○○）」は除く）。",
      "質問文には部屋番号・氏名・個人の事情を入れない。",
    ].join("\n"),
    prompt: lines.join("\n"),
  });
  const cost = await recordLlmCall({ hotelId, conversationId, purpose: "knowledge_review", thinking: false, usage });
  const questions = object.questions.flatMap((q) => {
    const message = messages[q.message_no - 1];
    // 情報の質問だけを提案にする（指示で除外させても依頼・苦情などを返すため、種類を分類させてコードで絞る）。
    // 番号の読み違いで評価対象外の発言を指したものも捨てる
    if (q.kind !== "info" || !message || message.role !== "user" || message.created_at <= from) return [];
    return [{ ...q, question: q.question.trim(), messageId: message.id, askedAt: message.created_at }];
  });
  return { questions: questions.filter((q) => q.question), cost };
}

// 未処理の提案のうち同じ意味の質問があれば根拠を足し、なければ新しい提案にする
async function addToGap(hotelId: string, runId: string, conversationId: string, item: FoundQuestion): Promise<{ gapId: string; created: boolean }> {
  const { embedding, model } = await embed(item.question);
  const vector = JSON.stringify(embedding);
  const nearest = await queryOne<{ id: string; similarity: number }>(
    `select id, 1 - (embedding <=> $2::extensions.vector) similarity from knowledge_gaps
     where hotel_id = $1 and status = 'open' and embedding_model = $3
     order by embedding <=> $2::extensions.vector limit 1`,
    [hotelId, vector, model],
  );
  let gapId: string;
  let created = false;
  if (nearest && nearest.similarity >= SAME_QUESTION_SIMILARITY) {
    gapId = nearest.id;
    // 同じ会話で同じ質問を繰り返したときは回数に数えない
    const already = await queryOne("select 1 from knowledge_gap_evidences where gap_id = $1 and conversation_id = $2", [gapId, conversationId]);
    await query(
      `update knowledge_gaps set ask_count = ask_count + $2, last_asked_at = greatest(last_asked_at, $3) where id = $1`,
      [gapId, already ? 0 : 1, item.askedAt],
    );
  } else {
    const row = await queryOne<{ id: string }>(
      `insert into knowledge_gaps (hotel_id, question, embedding, embedding_model, first_asked_at, last_asked_at)
       values ($1, $2, $3::extensions.vector, $4, $5, $5) returning id`,
      [hotelId, item.question, vector, model, item.askedAt],
    );
    gapId = row!.id;
    created = true;
  }
  await query(
    `insert into knowledge_gap_evidences (gap_id, conversation_id, message_id, review_run_id, reason, question, staff_answer, asked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [gapId, conversationId, item.messageId, runId, item.reason, item.question, item.staff_answer?.trim() || null, item.askedAt],
  );
  return { gapId, created };
}

// スタッフの答えから回答の下書きを作る（個人の事情とその場限りの内容を除く）。費用を返す
async function draftAnswer(hotelId: string, gapId: string): Promise<number> {
  const gap = await queryOne<{ question: string; answers: string[] }>(
    `select g.question, array_agg(e.staff_answer order by e.asked_at desc) answers
     from knowledge_gaps g join knowledge_gap_evidences e on e.gap_id = g.id and e.staff_answer is not null
     where g.id = $1 and g.status = 'open' group by g.id`,
    [gapId],
  );
  if (!gap) return 0;
  if (llmMode() === "mock") registerMockToolFixture("draft_answer", { has_information: true, answer: gap.answers[0] });
  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: draftSchema,
    name: "draft_answer",
    description: "スタッフの答えから、よくある質問の回答文を作る",
    system: [
      "ホテルのスタッフがゲストに答えた内容をもとに、今後ほかのゲストにも使える回答文を作る。",
      "スタッフの名乗り（「フロントの山本です」など）・部屋番号・氏名・個人の事情・その場限りの約束（「折り返します」「お部屋に伺います」など）は含めない。スタッフの答えにない情報は足さない。丁寧な案内の文にする。",
    ].join("\n"),
    prompt: [`質問: ${gap.question}`, ...gap.answers.map((a, i) => `スタッフの答え${i + 1}: ${a}`)].join("\n"),
  });
  // 情報のない返信からは下書きを作らない（空の回答欄のままスタッフが書く）
  if (object.has_information && object.answer.trim()) await query("update knowledge_gaps set draft_answer = $2 where id = $1", [gapId, object.answer.trim()]);
  return recordLlmCall({ hotelId, purpose: "knowledge_review", thinking: false, usage });
}
