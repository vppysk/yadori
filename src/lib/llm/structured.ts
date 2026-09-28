import { generateText, tool } from "ai";
import type { z } from "zod";
import { InvalidOutputError } from "./errors";
import { getModel, modelIdFor, type ModelOptions, type ModelTier } from "./models";

type StructuredParams<T extends z.ZodType> = {
  tier: ModelTier;
  schema: T;
  // 強制呼び出しする関数名と説明。モデルへの指示にもなる
  name: string;
  description: string;
  system: string;
  prompt: string;
  maxAttempts?: number;
  // 出力の上限。同じ内容を繰り返して止まらないときに早めに打ち切る（再試行する）
  maxOutputTokens?: number;
} & ModelOptions;

// コスト計測（plan 4.3）の元データ。再試行分も合算する
export type LlmUsage = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  ms: number;
};

export type StructuredResult<T> = {
  object: T;
  usage: LlmUsage;
  attempts: number;
};

// Token Factoryのjson_schemaはスキーマを保証しないため、
// 関数を指定したツール呼び出しで引数として受け取り、Zodで検証して失敗時は再試行する
export async function generateStructured<T extends z.ZodType>({
  tier,
  schema,
  name,
  description,
  system,
  prompt,
  maxAttempts = 2,
  maxOutputTokens,
  thinking,
}: StructuredParams<T>): Promise<StructuredResult<z.infer<T>>> {
  const usage: LlmUsage = { modelId: modelIdFor(tier), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = performance.now();
    let result;
    try {
      result = await generateText({
        model: getModel(tier, { thinking }),
        system,
        prompt,
        tools: { [name]: tool({ description, inputSchema: schema }) },
        toolChoice: { type: "tool", toolName: name },
        maxOutputTokens,
      });
    } catch (error) {
      // Lightningが同じ要素を繰り返して上限で止まり、ツール呼び出しを文字で書くことがある（ToolChoiceViolation）。再試行する
      usage.ms += Math.round(performance.now() - startedAt);
      lastError = error;
      continue;
    }
    usage.ms += Math.round(performance.now() - startedAt);
    usage.inputTokens += result.usage.inputTokens ?? 0;
    usage.outputTokens += result.usage.outputTokens ?? 0;
    usage.reasoningTokens += result.usage.outputTokenDetails.reasoningTokens ?? 0;

    const call = result.toolCalls.find((c) => c.toolName === name);
    const parsed = schema.safeParse(call?.input);
    if (parsed.success) return { object: parsed.data, usage, attempts: attempt };
    lastError = parsed.error;
  }
  throw new InvalidOutputError(`構造化出力の検証に${maxAttempts}回失敗しました: ${String(lastError)}`);
}
