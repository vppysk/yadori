import { z } from "zod";
import { classifyLlmError, type LlmFailure } from "@/lib/llm/errors";
import { generateStructured } from "@/lib/llm/structured";
import { queryOne } from "./db";
import { recordLlmCall } from "./metrics";
import { allCheckBodies } from "./reply-checks";

// ガードレール（plan 4.7、docs/007_ai_settings.md）: 画面では設定せず、内部で常に判定する。
// 前: 必ず人に引き継ぐ条件（安全・強い不満・スタッフと話したい・2回答えられない。guest-chat.ts）
// 後: 固定の項目と、指示・利用ルールから抜き出したチェック項目（reply-checks.ts）に反する回答をゲストに出さない

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
  const rules = (await allCheckBodies(hotelId)).map((body) => ({ body }));
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
