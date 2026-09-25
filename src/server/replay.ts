import { z } from "zod";
import { configuredModelId, type ModelTier } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import { query } from "./db";
import { draftAnswer, type InstructionOverrides } from "./guest-chat";
import { checkReply } from "./guardrails";
import { getGuestContext } from "./guest-context";
import { getHotel, type Pattern } from "./hotel";
import { listFacilityNames } from "./knowledge";
import { recordLlmCall } from "./metrics";
import { getCatalog } from "./orders";
import { route } from "./router";

// 精密見積もり（plan 4.3）: 過去のゲストの質問を、現在のモデルと新しいモデルで再生して、
// 実際のトークン数・コスト・答えられなかった率（引き継ぎの代わり）・AI採点による品質を比べる。DBの業務データには書かない

const SAMPLES_PER_CELL = 4;
// 実績がない業務の代わりに使う質問（デモ用）
const SAMPLE_QUESTIONS: Record<Pattern, string[]> = {
  info: ["プールは何時まで使えますか？", "明日の朝食は何時から？", "レストランのディナーは何時からですか？", "チェックアウトは何時ですか？"],
  order: ["バスタオルを2枚ください", "枕をもう1つお願いします", "お水を2本持ってきてほしい", "加湿器を貸してください"],
  external: ["近くでおすすめのラーメン屋はありますか？", "レストランを予約したいです", "駅までの行き方を教えて", "近くにコンビニはありますか？"],
  reservation: ["部屋を禁煙室に変えたい", "もう1泊延長できますか？", "チェックアウトを遅くしたい", "人数を1人増やしたい"],
  complaint: ["隣の部屋がうるさくて眠れない", "頼んだタオルがまだ来ない", "エアコンが効かなくて暑い", "部屋が掃除されていない"],
};

// デモ用ホテルの予約（再生時のゲスト文脈）。滞在中の予約を使う
const REPLAY_RESERVATION = "R-1203";

export type ReplayRequest = { pattern: Pattern; from: ModelTier; to: ModelTier };

export type ReplayStats = {
  tier: ModelTier;
  modelId: string;
  samples: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostJpy: number;
  unansweredRate: number;
  avgScore: number | null;
  avgMs: number;
};

export type ReplayResult = { pattern: Pattern; source: "past_questions" | "sample_questions"; questions: string[]; from: ReplayStats; to: ReplayStats };

async function pastQuestions(hotelId: string, pattern: Pattern): Promise<string[]> {
  // 回答のLLM呼び出しに記録したパターンから、その直前のゲストの発言を引く
  const rows = await query<{ content: string }>(
    `select distinct on (u.content) u.content
     from llm_calls c
     join messages a on a.id = c.message_id
     join lateral (
       select m.content, m.created_at from messages m
       where m.conversation_id = a.conversation_id and m.role = 'user' and m.created_at < a.created_at
       order by m.created_at desc limit 1
     ) u on true
     where c.hotel_id = $1 and c.purpose = 'answer' and c.pattern = $2
     order by u.content, c.created_at desc
     limit $3`,
    [hotelId, pattern, SAMPLES_PER_CELL],
  );
  return rows.map((r) => r.content);
}

export async function replay(hotelId: string, request: ReplayRequest): Promise<ReplayResult> {
  const hotel = await getHotel(hotelId);
  const found = await getGuestContext(REPLAY_RESERVATION);
  if (!found) throw new Error("再生用の予約が見つかりません");
  const guest = found;
  const past = await pastQuestions(hotelId, request.pattern);
  const questions = past.length >= 2 ? past : SAMPLE_QUESTIONS[request.pattern];
  const [catalog, facilityNames] = await Promise.all([getCatalog(hotelId), listFacilityNames(hotelId)]);
  const fx = Number(hotel.fx_usd_jpy);

  async function run(tier: ModelTier): Promise<ReplayStats> {
    // 質問ごとの再生は並列に行う（Token Factoryの上限内の件数）
    const rows = await Promise.all(
      questions.map(async (text) => {
        const routed = await route(text, catalog, facilityNames);
        const items = routed.result.intents.flatMap((i) => i.items ?? []);
        const { answer } = await draftAnswer({
          hotel, guest, text, history: [], routed: routed.result, allFacilityNames: facilityNames,
          // オーダーは発行したものとして答えさせる（再生ではチケットを作らない）
          tickets: items.length ? [{ id: "replay", lines: items.map((l) => ({ item: l.label, quantity: l.quantity })), dueMinutes: 30, assigneeName: null }] : [],
          unsupportedItems: routed.result.intents.flatMap((i) => i.unsupported_items ?? []),
          hasComplaint: routed.result.intents.some((i) => i.pattern === "complaint"),
          tier, thinking: false,
        });
        const usage = answer?.usage;
        const costUsd = usage ? await recordLlmCall({ hotelId, purpose: "replay", pattern: request.pattern, thinking: false, usage }) : 0;
        const reply = answer?.reply ?? "";
        return {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          costJpy: costUsd * fx,
          unanswered: !reply || (answer?.unanswered_questions.length ?? 0) > 0,
          score: reply ? await judge(hotelId, text, reply) : null,
          ms: usage?.ms ?? 0,
        };
      }),
    );
    const avg = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(rows.length, 1);
    const scored = rows.filter((r) => r.score !== null);
    return {
      tier,
      modelId: configuredModelId(tier),
      samples: rows.length,
      avgInputTokens: Math.round(avg((r) => r.input)),
      avgOutputTokens: Math.round(avg((r) => r.output)),
      avgCostJpy: avg((r) => r.costJpy),
      unansweredRate: avg((r) => (r.unanswered ? 1 : 0)),
      avgScore: scored.length ? scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length : null,
      avgMs: Math.round(avg((r) => r.ms)),
    };
  }

  const [from, to] = await Promise.all([run(request.from), run(request.to)]);
  return { pattern: request.pattern, source: past.length >= 2 ? "past_questions" : "sample_questions", questions, from, to };
}

// AI採点: ホテルの案内として適切か（正確さ・簡潔さ・丁寧さ・約束しすぎないこと）を1〜5で。採点役は常に同じモデル（Super）
async function judge(hotelId: string, question: string, reply: string): Promise<number | null> {
  try {
    const { object, usage } = await generateStructured({
      tier: "medium",
      schema: z.object({ score: z.number().int().min(1).max(5), reason: z.string() }),
      name: "score_reply",
      description: "ホテルのAIの回答を採点する",
      system:
        "ホテルのゲストへのAIの回答を1〜5で採点する。5=質問に的確・簡潔・丁寧で、根拠のない約束や断定がない。3=無難だが冗長か一部不十分。1=誤り・不適切。わからないことをスタッフに確認すると答えるのは、推測で答えるより高く評価する。",
      prompt: `質問: ${question}\n回答: ${reply}`,
    });
    await recordLlmCall({ hotelId, purpose: "replay_judge", thinking: false, usage });
    return object.score;
  } catch {
    return null;
  }
}

// ---------- 指示の変更を過去の会話で試す（plan 4.7「変更の安全策」） ----------

export type InstructionTrial = {
  pattern: Pattern;
  source: "past_questions" | "sample_questions";
  followsCount: number;
  violationCount: number;
  cases: { question: string; before: string; after: string; follows: boolean; reason: string; violation: string | null }[];
};

export async function tryInstructions(hotelId: string, pattern: Pattern, draft: InstructionOverrides): Promise<InstructionTrial> {
  const hotel = await getHotel(hotelId);
  const found = await getGuestContext(REPLAY_RESERVATION);
  if (!found) throw new Error("再生用の予約が見つかりません");
  const guest = found;
  const past = await pastQuestions(hotelId, pattern);
  const questions = past.length >= 2 ? past : SAMPLE_QUESTIONS[pattern];
  const [catalog, facilityNames] = await Promise.all([getCatalog(hotelId), listFacilityNames(hotelId)]);
  const instruction = [draft.common, draft.patterns[pattern] ?? ""].filter((x) => x.trim()).join("\n");

  const cases = await Promise.all(
    questions.map(async (text) => {
      const routed = await route(text, catalog, facilityNames);
      const items = routed.result.intents.flatMap((i) => i.items ?? []);
      const base = {
        hotel, guest, text, history: [], routed: routed.result, allFacilityNames: facilityNames,
        tickets: items.length ? [{ id: "replay", lines: items.map((l) => ({ item: l.label, quantity: l.quantity })), dueMinutes: 30, assigneeName: null }] : [],
        unsupportedItems: routed.result.intents.flatMap((i) => i.unsupported_items ?? []),
        hasComplaint: routed.result.intents.some((i) => i.pattern === "complaint"),
        tier: "medium" as const, thinking: false,
      };
      const [before, after] = await Promise.all([draftAnswer(base), draftAnswer({ ...base, instructionOverrides: draft })]);
      const afterText = after.answer?.reply ?? "";
      const [judged, check] = await Promise.all([judgeInstruction(hotelId, instruction, text, afterText), checkReply(hotelId, afterText)]);
      return { question: text, before: before.answer?.reply ?? "", after: afterText, follows: judged.follows, reason: judged.reason, violation: check.ok ? null : check.rule };
    }),
  );
  return {
    pattern,
    source: past.length >= 2 ? "past_questions" : "sample_questions",
    followsCount: cases.filter((c) => c.follows).length,
    violationCount: cases.filter((c) => c.violation).length,
    cases,
  };
}

async function judgeInstruction(hotelId: string, instruction: string, question: string, reply: string): Promise<{ follows: boolean; reason: string }> {
  try {
    const { object, usage } = await generateStructured({
      tier: "medium",
      schema: z.object({ follows: z.boolean(), reason: z.string().describe("判定の理由を短く") }),
      name: "judge_instruction",
      description: "回答が指示に沿っているか判定する",
      system: `ホテルのAIの回答が、次の指示に沿っているかを判定する。\n## 指示\n${instruction}`,
      prompt: `ゲスト: ${question}\nAIの回答: ${reply}`,
    });
    await recordLlmCall({ hotelId, purpose: "replay_judge", thinking: false, usage });
    return object;
  } catch {
    return { follows: false, reason: "判定できなかった" };
  }
}
