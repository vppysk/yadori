import type { LlmUsage } from "@/lib/llm/structured";
import { query, queryOne } from "./db";
import { dispatchWorkEvent } from "./webhooks";
import type { Pattern } from "./hotel";

type Price = { input_usd_per_mtok: string; output_usd_per_mtok: string };

// 出力トークンには推論（thinking）トークンも含まれる。単価表にないモデル（モック）は0
async function costUsd(usage: LlmUsage): Promise<number> {
  const price = await queryOne<Price>(
    `select input_usd_per_mtok, output_usd_per_mtok from model_prices
     where model_id = $1 and effective_from <= current_date order by effective_from desc limit 1`,
    [usage.modelId],
  );
  if (!price) return 0;
  return (usage.inputTokens * Number(price.input_usd_per_mtok) + usage.outputTokens * Number(price.output_usd_per_mtok)) / 1_000_000;
}

export async function recordLlmCall(params: {
  hotelId: string;
  conversationId?: string;
  messageId?: string;
  purpose: string;
  pattern?: Pattern;
  thinking: boolean;
  usage: LlmUsage;
  request?: unknown;
}): Promise<number> {
  const cost = await costUsd(params.usage);
  await query(
    `insert into llm_calls (hotel_id, conversation_id, message_id, purpose, pattern, model_id, thinking,
       input_tokens, output_tokens, reasoning_tokens, duration_ms, cost_usd, request)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      params.hotelId, params.conversationId ?? null, params.messageId ?? null, params.purpose, params.pattern ?? null,
      params.usage.modelId, params.thinking, params.usage.inputTokens, params.usage.outputTokens,
      params.usage.reasoningTokens, params.usage.ms, cost, params.request ? JSON.stringify(params.request) : null,
    ],
  );
  return cost;
}

export type Outcome = "resolved" | "handed_off" | "escalated_complaint" | "unanswered";

// 実績イベント（plan 4.5）。外部への出力口の契約なので、項目を変えるときは docs/001_db_schema.md も直す
export async function recordWorkEvent(params: {
  hotelId: string;
  conversationId?: string;
  ticketId?: string;
  pattern: Pattern;
  timeBandId?: string;
  handlerKind: "ai" | "human";
  handler: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  costJpy?: number;
  outcome: Outcome;
  signals?: Record<string, unknown>;
}) {
  const [row] = await query<Record<string, unknown>>(
    `insert into work_events (hotel_id, conversation_id, ticket_id, pattern, time_band_id, handler_kind, handler,
       input_tokens, output_tokens, duration_ms, cost_jpy, outcome, signals)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id, occurred_at, pattern, handler_kind, handler, input_tokens, output_tokens, duration_ms, cost_jpy::float cost_jpy, outcome, signals,
       (select name from time_bands where id = time_band_id) time_band`,
    [
      params.hotelId, params.conversationId ?? null, params.ticketId ?? null, params.pattern, params.timeBandId ?? null,
      params.handlerKind, params.handler, params.inputTokens ?? 0, params.outputTokens ?? 0, params.durationMs ?? 0,
      params.costJpy ?? 0, params.outcome, JSON.stringify(params.signals ?? {}),
    ],
  );
  // 出力口（CSV/JSON・MCP）と同じ項目をWebhookでも送る。会話IDなどの内部IDは含めない
  dispatchWorkEvent(params.hotelId, row);
}
