import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { getModel, llmMode, modelIdFor, registerMockToolFixture, type ModelTier } from "@/lib/llm/models";
import type { LlmUsage } from "@/lib/llm/structured";

// リクエストごとに決まる値。モデル（時間帯×パターンの担当）と指示はホテルの設定から作る
export type ConciergeContext = {
  tier: ModelTier;
  thinking: boolean;
  instructions: string;
};

function ctx(requestContext: RequestContext | undefined): ConciergeContext {
  const get = <K extends keyof ConciergeContext>(key: K) => requestContext?.get(key) as ConciergeContext[K];
  const instructions = get("instructions");
  if (!instructions) throw new Error("requestContext に instructions がありません");
  return { tier: get("tier") ?? "small", thinking: get("thinking") ?? false, instructions };
}

const answerSchema = z.object({
  reply: z.string().describe("相手に送る回答の文章"),
  unanswered_questions: z
    .array(z.string())
    .describe("情報がなくて答えられなかった質問（短くまとめたもの）。すべて答えられたなら空"),
});

// 回答は必ずこのツールの引数で返させる（回答文と、答えられなかった質問を分けて確実に受け取るため）
const answerTool = createTool({
  id: "answer",
  description: "回答を返す。回答は必ずこのツールで返す",
  inputSchema: answerSchema,
  execute: async (input) => input,
});

// 回答係。営業情報・特記事項・文書はサーバー側で取得し、文章にして指示に入れて渡す。
// 館内情報を調べるツールは持たせない。Nemotronがツール呼び出しを文字で書く・同じ呼び出しを繰り返すことがあったため（2026-09-25 検証）
export const conciergeAgent = new Agent({
  id: "concierge",
  name: "concierge",
  instructions: ({ requestContext }) => ctx(requestContext).instructions,
  model: ({ requestContext }) => {
    const { tier, thinking } = ctx(requestContext);
    return getModel(tier, { thinking });
  },
  tools: { answer: answerTool },
});

export type Answer = z.infer<typeof answerSchema> & { usage: LlmUsage };

const MAX_ATTEMPTS = 2;

export async function generateAnswer(context: ConciergeContext, messages: ModelMessage[], requestContext: RequestContext<ConciergeContext>): Promise<Answer> {
  if (llmMode() === "mock") {
    // 最新の館内情報が前に付いている場合は、ゲストの発言部分だけを返す
    registerMockToolFixture("answer", (text: string) => ({
      reply: `[mock-${context.tier}] ${text.split(/【(?:ゲストのメッセージ|スタッフの質問)】\n/).pop()}`,
      unanswered_questions: [],
    }));
  }
  const usage: LlmUsage = { modelId: modelIdFor(context.tier), inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = performance.now();
    const result = await conciergeAgent.generate(messages, {
      requestContext,
      maxSteps: 1,
      toolChoice: { type: "tool", toolName: "answer" },
    });
    usage.ms += Math.round(performance.now() - startedAt);
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    usage.reasoningTokens += result.usage?.reasoningTokens ?? 0;
    const call = result.toolCalls?.find((c) => c.payload?.toolName === "answer");
    const parsed = answerSchema.safeParse(call?.payload?.args);
    if (parsed.success && parsed.data.reply.trim()) return { ...parsed.data, usage };
  }
  throw new Error("回答を作れませんでした");
}
