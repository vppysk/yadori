import { query } from "./db";

// 実績の出力口（plan 4.5）: 業務1件ごとの実績を標準形式で出す。将来の配置エンジンや既存の管理システムとの契約。
// 個人情報（氏名・会話内容）は含めない

export type WorkEventRow = {
  id: string;
  occurred_at: string;
  pattern: string;
  time_band: string | null;
  handler_kind: string;
  handler: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  cost_jpy: number;
  outcome: string;
  signals: Record<string, unknown>;
};

export async function listWorkEvents(hotelId: string, params: { since?: string; until?: string; pattern?: string; limit?: number }): Promise<WorkEventRow[]> {
  return query<WorkEventRow>(
    `select w.id, to_char(w.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') occurred_at, w.pattern, t.name time_band,
       w.handler_kind, w.handler, w.input_tokens, w.output_tokens, w.duration_ms, w.cost_jpy::float cost_jpy, w.outcome, w.signals
     from work_events w left join time_bands t on t.id = w.time_band_id
     where w.hotel_id = $1
       and w.occurred_at >= coalesce($2::timestamptz, now() - interval '30 days')
       and w.occurred_at < coalesce($3::timestamptz, now())
       and ($4::text is null or w.pattern = $4)
     order by w.occurred_at desc
     limit $5`,
    [hotelId, params.since ?? null, params.until ?? null, params.pattern ?? null, Math.min(params.limit ?? 50_000, 50_000)],
  );
}

export async function summarizeWorkEvents(hotelId: string, days = 30) {
  return query<{ pattern: string; handler_kind: string; handler: string; events: number; cost_jpy: number; resolved_rate: number; avg_duration_ms: number }>(
    `select pattern, handler_kind, handler, count(*)::int events, round(sum(cost_jpy)::numeric, 2)::float cost_jpy,
       round(avg((outcome = 'resolved')::int)::numeric, 3)::float resolved_rate, avg(duration_ms)::int avg_duration_ms
     from work_events where hotel_id = $1 and occurred_at > now() - make_interval(days => $2)
     group by pattern, handler_kind, handler order by pattern, events desc`,
    [hotelId, days],
  );
}

const CSV_COLUMNS: (keyof WorkEventRow)[] = [
  "id", "occurred_at", "pattern", "time_band", "handler_kind", "handler", "input_tokens", "output_tokens", "duration_ms", "cost_jpy", "outcome", "signals",
];

export function toCsv(rows: WorkEventRow[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\n");
}
