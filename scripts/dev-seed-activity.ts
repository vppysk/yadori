// 開発・デモ用: 過去30日分の実績イベント（work_events）を生成する。件数はUIモックと同じ規模。
// 担当は現在の ai_assignments、単価は model_prices、引き継ぎ率は想定値に従う。signals.demo = true を付ける
import { configuredModelId } from "@/lib/llm/models";
import { query } from "@/server/db";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

// 月間件数（日中・夕方・深夜）と1件あたりのトークン
const VOLUMES: Record<string, { volumes: [number, number, number]; input: number; output: number }> = {
  info: { volumes: [2400, 1500, 600], input: 2600, output: 150 },
  order: { volumes: [1800, 1600, 500], input: 1500, output: 90 },
  external: { volumes: [300, 200, 20], input: 2200, output: 160 },
  reservation: { volumes: [120, 60, 15], input: 2400, output: 170 },
  complaint: { volumes: [40, 30, 10], input: 2800, output: 220 },
};
const HANDOFF = { small: 0.18, medium: 0.1, large: 0.06 };

async function main() {
  const removed = await query<{ n: number }>(
    "with d as (delete from work_events where hotel_id = $1 and signals->>'demo' = 'true' returning 1) select count(*)::int n from d",
    [HOTEL_ID],
  );
  console.log(`既存のデモ実績を削除: ${removed[0].n}件`);
  const bands = await query<{ id: string; sort: number }>("select id, sort from time_bands where hotel_id = $1 order by sort", [HOTEL_ID]);
  const assignments = await query<{ pattern: string; time_band_id: string; handler: "human" | "small" | "medium" | "large" }>(
    "select pattern, time_band_id, handler from ai_assignments where hotel_id = $1",
    [HOTEL_ID],
  );
  const fx = Number((await query<{ fx: string }>("select fx_usd_jpy fx from hotels where id = $1", [HOTEL_ID]))[0].fx);

  for (const [pattern, spec] of Object.entries(VOLUMES)) {
    for (const [i, band] of bands.entries()) {
      const handler = assignments.find((a) => a.pattern === pattern && a.time_band_id === band.id)?.handler ?? "small";
      const count = spec.volumes[i];
      if (handler === "human") {
        await query(
          `insert into work_events (hotel_id, pattern, time_band_id, handler_kind, handler, outcome, signals, occurred_at)
           select $1, $2, $3, 'human', 'フロント', 'handed_off', '{"demo": true}', now() - random() * interval '30 days'
           from generate_series(1, $4)`,
          [HOTEL_ID, pattern, band.id, count],
        );
        continue;
      }
      const modelId = configuredModelId(handler);
      const price = (await query<{ i: string; o: string }>(
        "select input_usd_per_mtok i, output_usd_per_mtok o from model_prices where model_id = $1 order by effective_from desc limit 1",
        [modelId],
      ))[0];
      const costJpy = ((spec.input * Number(price?.i ?? 0) + spec.output * Number(price?.o ?? 0)) / 1_000_000) * fx;
      await query(
        `insert into work_events (hotel_id, pattern, time_band_id, handler_kind, handler, input_tokens, output_tokens, duration_ms, cost_jpy, outcome, signals, occurred_at)
         select $1, $2, $3, 'ai', $4,
           ($5 * (0.8 + random() * 0.4))::int, ($6 * (0.8 + random() * 0.4))::int, (1500 + random() * 2500)::int, $7,
           case when $2 = 'complaint' then 'escalated_complaint' when random() < $8 then 'handed_off' else 'resolved' end,
           jsonb_build_object('demo', true, 'wants_staff', random() < 0.034),
           now() - random() * interval '30 days'
         from generate_series(1, $9)`,
        [HOTEL_ID, pattern, band.id, modelId, spec.input, spec.output, costJpy, HANDOFF[handler], count],
      );
    }
  }
  // オーダーの配達（人）の実績。期限内対応はおよそ94%
  await query(
    `insert into work_events (hotel_id, pattern, handler_kind, handler, duration_ms, outcome, signals, occurred_at)
     select $1, 'order', 'human', 'ハウスキーピング', (240000 + random() * 600000)::int, 'resolved',
       jsonb_build_object('demo', true, 'phase', 'delivery', 'on_time', random() < 0.94), now() - random() * interval '30 days'
     from generate_series(1, 3900)`,
    [HOTEL_ID],
  );
  const total = await query<{ n: number }>("select count(*)::int n from work_events where hotel_id = $1 and signals->>'demo' = 'true'", [HOTEL_ID]);
  console.log(`デモ実績を生成: ${total[0].n}件`);
  process.exit(0);
}
main();
