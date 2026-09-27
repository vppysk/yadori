import { APICallError, RetryError } from "ai";

// LLMの呼び出しが失敗した原因。対応アラートの「システムの不具合」に表示し、同じ原因の件数を数える
export type LlmFailureCause = "timeout" | "api_error" | "invalid_output" | "unknown";

export type LlmFailure = { cause: LlmFailureCause; detail: string };

// 再試行しても期待した形の出力（ツール呼び出し・スキーマ）が得られなかった
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

export function classifyLlmError(error: unknown): LlmFailure {
  const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000);
  for (const cause of causeChain(error)) {
    if (cause instanceof InvalidOutputError) return { cause: "invalid_output", detail };
    if (APICallError.isInstance(cause)) {
      return { cause: isTimeout(cause) ? "timeout" : "api_error", detail: cause.statusCode ? `HTTP ${cause.statusCode} ${detail}` : detail };
    }
    if (isTimeout(cause)) return { cause: "timeout", detail };
  }
  return { cause: "unknown", detail };
}

// Mastra はプロバイダーのエラーを cause に包み、AI SDK は再試行を使い切ると lastError に残すため、元のエラーまでたどる
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current && chain.length < 6) {
    chain.push(current);
    current = RetryError.isInstance(current) ? current.lastError : current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timeout|timed out|ETIMEDOUT/i.test(error.message);
}
