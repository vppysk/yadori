import { z } from "zod";
import { classifyLlmError, type LlmFailure } from "@/lib/llm/errors";
import { generateStructured } from "@/lib/llm/structured";
import { query, queryOne } from "./db";
import { recordLlmCall } from "./metrics";

// ガードレール（plan 4.7）: 指示より優先し、応答の前後で自動チェックする。
// 前: 必ず人に引き継ぐ条件（code で判定を実装した組み込みの条件。オフにしたものは判定しない）
// 後: してはいけないことに反する回答をゲストに出さない

export type HandoffCode = "wants_staff" | "strong_complaint" | "unanswered_twice" | "safety";

export async function enabledHandoffCodes(hotelId: string): Promise<Set<HandoffCode>> {
  const rows = await query<{ code: HandoffCode }>(
    "select code from guardrails where hotel_id = $1 and kind = 'handoff_condition' and enabled and code is not null",
    [hotelId],
  );
  return new Set(rows.map((r) => r.code));
}

// 同じ会話で答えられなかった回数（この発言を含めて2回で人へ）
export async function unansweredCount(conversationId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "select count(*)::int n from work_events where conversation_id = $1 and outcome = 'unanswered'",
    [conversationId],
  );
  return row?.n ?? 0;
}

// failure: チェック自体が失敗した（違反の判定ではない）
export type ReplyCheck = { ok: true } | { ok: false; rule: string; reason: string; failure?: LlmFailure };

// 回答の後チェック。「してはいけないこと」への違反をモデルで判定する
export async function checkReply(hotelId: string, reply: string, conversationId?: string): Promise<ReplyCheck> {
  const rules = await query<{ body: string }>(
    "select body from guardrails where hotel_id = $1 and kind = 'forbidden' and enabled order by sort",
    [hotelId],
  );
  if (rules.length === 0) return { ok: true };
  try {
    // 小型（Lightning）は値引きの約束や他の客の情報を見逃したため、中型で判定する（2026-09-26 検証）
    const { object, usage } = await generateStructured({
      tier: "medium",
      schema: z.object({
        violated: z.boolean(),
        rule_number: z.number().int().optional().describe("違反した決まりの番号（違反がなければ省略）"),
        reason: z.string().optional(),
      }),
      name: "check_reply",
      description: "ホテルのAIの回答が決まりに反していないか判定する",
      system: [
        "ホテルのAIがゲストに送ろうとしている回答が、次の決まりに反していないかを判定する。",
        "決まりに当たる内容を実際に約束・提供・助言している場合だけ違反とする。「担当者から改めて連絡します」「フロントへおつなぎします」は違反ではない。",
        ...rules.map((r, i) => `${i + 1}. ${r.body}`),
      ].join("\n"),
      prompt: reply,
    });
    await recordLlmCall({ hotelId, conversationId, purpose: "guardrail", thinking: false, usage });
    if (!object.violated) return { ok: true };
    const rule = rules[(object.rule_number ?? 1) - 1]?.body ?? rules[0].body;
    return { ok: false, rule, reason: object.reason ?? "" };
  } catch (error) {
    // 判定できないときは出してしまうより止める
    console.warn("[guardrails] 後チェックに失敗", error);
    return { ok: false, rule: "判定できなかった", reason: String(error), failure: classifyLlmError(error) };
  }
}
