import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

// 小型=速い処理（ルーター・抽出）、中型=ツール付き案内、大型=クレーム・難問（plan 4.3）
export type ModelTier = "small" | "medium" | "large";

export type ModelOptions = {
  // Nemotronの推論（thinking）。ルーター・抽出はfalse、難しい応答はtrueを基本にする
  thinking?: boolean;
};

const NEBIUS_BASE_URL = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/";

const MODEL_IDS: Record<ModelTier, string> = {
  small: process.env.LLM_MODEL_SMALL ?? "nvidia/Nemotron-3_5-Lightning",
  medium: process.env.LLM_MODEL_MEDIUM ?? "nvidia/nemotron-3-super-120b-a12b",
  large: process.env.LLM_MODEL_LARGE ?? "nvidia/Nemotron-3-Ultra-550b-a55b",
};

// 画像の書き起こし用（Token FactoryにNemotronの画像対応モデルがないため別系統。docs/000_plan.md 6章）
export const VISION_MODEL_ID = process.env.LLM_MODEL_VISION ?? "zai-org/GLM-5.3-Flash";

export function llmMode(): "mock" | "nebius" {
  return process.env.LLM_MODE === "nebius" ? "nebius" : "mock";
}

// 設定上のモデルID（モックのときも本番のIDを返す）。コスト見積もりの単価引き当てに使う
export function configuredModelId(tier: ModelTier): string {
  return MODEL_IDS[tier];
}

export function modelIdFor(tier: ModelTier): string {
  return llmMode() === "mock" ? `mock-${tier}` : MODEL_IDS[tier];
}

export function getModel(tier: ModelTier, { thinking = false }: ModelOptions = {}): LanguageModelV4 {
  if (llmMode() === "mock") return createMockModel(tier);

  // Token Factoryはjson_schemaを保証しないため、構造化出力は強制ツール呼び出しで行う（structured.ts）
  return nebiusProvider(thinking).chatModel(MODEL_IDS[tier]);
}

function nebiusProvider(thinking: boolean) {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) throw new Error("LLM_MODE=nebius には NEBIUS_API_KEY が必要です");
  return createOpenAICompatible({
    name: "nebius",
    apiKey,
    baseURL: NEBIUS_BASE_URL,
    includeUsage: true,
    transformRequestBody: (body) => ({
      ...body,
      chat_template_kwargs: { ...body.chat_template_kwargs, enable_thinking: thinking },
    }),
  });
}

export function getVisionModel(): LanguageModelV4 {
  if (llmMode() === "mock") return createMockModel("small");
  return nebiusProvider(false).chatModel(VISION_MODEL_ID);
}

// --- ローカル確認用のモック（LLM費用なし） ---

// 強制ツール呼び出しで返す引数。toolName → 固定の引数、または最後のユーザー発言から作る関数
type MockFixture = unknown | ((userText: string) => unknown);
const mockToolFixtures: Record<string, MockFixture> = {};

export function registerMockToolFixture(toolName: string, input: MockFixture) {
  mockToolFixtures[toolName] = input;
}

function mockUsage(inputChars: number, outputChars: number) {
  return {
    inputTokens: { total: inputChars, noCache: inputChars, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputChars, text: outputChars, reasoning: 0 },
  };
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

function createMockModel(tier: ModelTier): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: `mock-${tier}`,
    doGenerate: async (options) => {
      const inputChars = JSON.stringify(options.prompt).length;
      const choice = options.toolChoice;
      if (choice?.type === "tool" && choice.toolName in mockToolFixtures) {
        const fixture = mockToolFixtures[choice.toolName];
        const input = JSON.stringify(typeof fixture === "function" ? fixture(lastUserText(options)) : fixture);
        return {
          content: [{ type: "tool-call", toolCallId: "mock-call", toolName: choice.toolName, input }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: mockUsage(inputChars, input.length),
          warnings: [],
        };
      }
      const text = `[mock-${tier}] ${lastUserText(options)}`;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: mockUsage(inputChars, text.length),
        warnings: [],
      };
    },
    doStream: async (options) => {
      const text = `[mock-${tier}] ${lastUserText(options)}`;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: mockUsage(JSON.stringify(options.prompt).length, text.length),
            },
          ],
        }),
      };
    },
  });
}
