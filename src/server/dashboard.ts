import { configuredModelId, type ModelTier } from "@/lib/llm/models";
import type { Member } from "./auth";
import { query, transaction } from "./db";
import { getHotel, type Pattern } from "./hotel";

// 経営ダッシュボード（plan 4.3）: AIの担当範囲（パターン×時間帯）と、変更したときの月額見積もり。
// 見積もりの計算そのものはクライアントで行う（セルを切り替えるたびに即時に出すため）。ここではその材料を集める

export const PATTERNS: { key: Pattern; label: string }[] = [
  { key: "info", label: "案内" },
  { key: "order", label: "オーダー受付" },
  { key: "external", label: "外部連携" },
  { key: "reservation", label: "予約・客室" },
  { key: "complaint", label: "クレーム" },
];

export type Handler = "human" | ModelTier;
const TIERS: ModelTier[] = ["small", "medium", "large"];

// 実績が少ないときの想定値（モデル別の引き継ぎ率、1件あたりの入出力トークン）
const DEFAULT_HANDOFF: Record<ModelTier, number> = { small: 0.18, medium: 0.1, large: 0.06 };
const DEFAULT_TOKENS = { input: 2600, output: 150 };
const MIN_SAMPLES = 20;
// 時給・対応時間のマスタが未入力のときのサンプル値（UIモックと同じ）
const SAMPLE_WAGE_JPY = 1500;
const SAMPLE_MINUTES: Record<Pattern, number> = { info: 3, order: 2, external: 5, reservation: 8, complaint: 15 };

export type DashboardData = {
  hotelName: string;
  days: number;
  bands: { id: string; name: string; range: string; wageMultiplier: number }[];
  patterns: { key: Pattern; label: string; volumes: number[]; minutes: number; tokens: { input: number; output: number } }[];
  assignments: Record<string, Handler>; // `${pattern}:${bandId}`
  tiers: Record<ModelTier, { modelId: string; inputUsdPerMtok: number; outputUsdPerMtok: number; handoffRate: number; measured: boolean }>;
  wageJpy: number;
  fxUsdJpy: number;
  sampleMasters: boolean;
  kpi: {
    volume: number;
    aiResolvedRate: number | null;
    costPerCase: number | null;
    wantsStaffRate: number | null;
    orderOnTimeRate: number | null;
    demoData: boolean;
  };
};

export async function getDashboard(hotelId: string, days = 30): Promise<DashboardData> {
  const hotel = await getHotel(hotelId);
  const since = `now() - make_interval(days => ${Number(days)})`;
  const [bands, assignments, volumes, tokens, handoffs, prices, minutes, wage, kpi] = await Promise.all([
    query<{ id: string; name: string; starts_at: string; ends_at: string; wage_multiplier: string }>(
      "select id, name, to_char(starts_at, 'FMHH24') starts_at, to_char(ends_at, 'FMHH24') ends_at, wage_multiplier from time_bands where hotel_id = $1 order by sort",
      [hotelId],
    ),
    query<{ pattern: Pattern; time_band_id: string; handler: Handler }>("select pattern, time_band_id, handler from ai_assignments where hotel_id = $1", [hotelId]),
    // 件数はゲスト対応の単位で数える（配達の実績は数えない）
    query<{ pattern: Pattern; time_band_id: string; n: number }>(
      `select pattern, time_band_id, count(*)::int n from work_events
       where hotel_id = $1 and occurred_at > ${since} and coalesce(signals->>'phase', '') <> 'delivery' and time_band_id is not null
       group by pattern, time_band_id`,
      [hotelId],
    ),
    query<{ pattern: Pattern; input: number; output: number; n: number }>(
      `select pattern, avg(input_tokens)::int input, avg(output_tokens)::int output, count(*)::int n from work_events
       where hotel_id = $1 and occurred_at > ${since} and handler_kind = 'ai' and input_tokens > 0 group by pattern`,
      [hotelId],
    ),
    query<{ handler: string; handed: number; n: number }>(
      `select handler, count(*) filter (where outcome in ('handed_off', 'unanswered'))::int handed, count(*)::int n from work_events
       where hotel_id = $1 and occurred_at > ${since} and handler_kind = 'ai' and pattern <> 'complaint' group by handler`,
      [hotelId],
    ),
    query<{ model_id: string; input_usd_per_mtok: string; output_usd_per_mtok: string }>(
      "select distinct on (model_id) model_id, input_usd_per_mtok, output_usd_per_mtok from model_prices where effective_from <= current_date order by model_id, effective_from desc",
    ),
    query<{ pattern: Pattern; minutes: string }>(
      "select pattern, sum(minutes) minutes from handling_times where hotel_id = $1 and phase in ('all', 'intake') group by pattern",
      [hotelId],
    ),
    query<{ wage: string | null }>("select avg(hourly_wage_jpy) wage from wage_rates where hotel_id = $1", [hotelId]),
    query<{ volume: number; ai_resolved: number; cost_jpy: string; wants_staff: number; deliveries: number; on_time: number; demo: number }>(
      `select
         count(*) filter (where coalesce(signals->>'phase', '') <> 'delivery')::int volume,
         count(*) filter (where handler_kind = 'ai' and outcome = 'resolved' and coalesce(signals->>'phase', '') <> 'delivery')::int ai_resolved,
         coalesce(sum(cost_jpy), 0) cost_jpy,
         count(*) filter (where signals->>'wants_staff' = 'true')::int wants_staff,
         count(*) filter (where signals->>'phase' = 'delivery')::int deliveries,
         count(*) filter (where signals->>'phase' = 'delivery' and signals->>'on_time' = 'true')::int on_time,
         count(*) filter (where signals->>'demo' = 'true')::int demo
       from work_events where hotel_id = $1 and occurred_at > ${since}`,
      [hotelId],
    ),
  ]);

  const priceOf = (modelId: string) => prices.find((p) => p.model_id === modelId);
  const tiers = Object.fromEntries(
    TIERS.map((tier) => {
      const modelId = configuredModelId(tier);
      const price = priceOf(modelId);
      const observed = handoffs.find((h) => h.handler === modelId);
      const measured = !!observed && observed.n >= MIN_SAMPLES;
      return [
        tier,
        {
          modelId,
          inputUsdPerMtok: Number(price?.input_usd_per_mtok ?? 0),
          outputUsdPerMtok: Number(price?.output_usd_per_mtok ?? 0),
          handoffRate: measured ? observed.handed / observed.n : DEFAULT_HANDOFF[tier],
          measured,
        },
      ];
    }),
  ) as DashboardData["tiers"];

  const sampleMasters = minutes.length === 0 || !wage[0]?.wage;
  const k = kpi[0];
  const nonDelivery = k.volume;
  return {
    hotelName: hotel.name,
    days,
    bands: bands.map((b) => ({ id: b.id, name: b.name, range: `${b.starts_at}–${b.ends_at}時`, wageMultiplier: Number(b.wage_multiplier) })),
    patterns: PATTERNS.map((p) => {
      const t = tokens.find((x) => x.pattern === p.key);
      const m = minutes.find((x) => x.pattern === p.key);
      return {
        ...p,
        volumes: bands.map((b) => volumes.find((v) => v.pattern === p.key && v.time_band_id === b.id)?.n ?? 0),
        minutes: m ? Number(m.minutes) : SAMPLE_MINUTES[p.key],
        tokens: t && t.n >= 5 ? { input: t.input, output: t.output } : DEFAULT_TOKENS,
      };
    }),
    assignments: Object.fromEntries(assignments.map((a) => [`${a.pattern}:${a.time_band_id}`, a.handler])),
    tiers,
    wageJpy: wage[0]?.wage ? Number(wage[0].wage) : SAMPLE_WAGE_JPY,
    fxUsdJpy: Number(hotel.fx_usd_jpy),
    sampleMasters,
    kpi: {
      volume: nonDelivery,
      aiResolvedRate: nonDelivery ? k.ai_resolved / nonDelivery : null,
      costPerCase: nonDelivery ? Number(k.cost_jpy) / nonDelivery : null,
      wantsStaffRate: nonDelivery ? k.wants_staff / nonDelivery : null,
      orderOnTimeRate: k.deliveries ? k.on_time / k.deliveries : null,
      demoData: k.demo > 0,
    },
  };
}

// 「この設定を適用」: 担当範囲を保存し、変更前後の全体を変更履歴に残す（元に戻せるように）
export async function applyAssignments(member: Member, next: Record<string, Handler>) {
  await transaction(async (client) => {
    const { rows: before } = await client.query<{ pattern: string; time_band_id: string; handler: string; locked: boolean }>(
      "select pattern, time_band_id, handler, locked from ai_assignments where hotel_id = $1 for update",
      [member.hotel_id],
    );
    for (const row of before) {
      const handler = next[`${row.pattern}:${row.time_band_id}`];
      // クレームは固定（常に大型＋人）。ここでは変更させない
      if (!handler || row.locked || handler === row.handler) continue;
      if (!["human", "small", "medium", "large"].includes(handler)) throw new Error("担当の値が不正です");
      await client.query("update ai_assignments set handler = $4 where hotel_id = $1 and pattern = $2 and time_band_id = $3", [
        member.hotel_id, row.pattern, row.time_band_id, handler,
      ]);
    }
    const { rows: after } = await client.query("select pattern, time_band_id, handler, thinking, handoff_threshold, locked from ai_assignments where hotel_id = $1", [
      member.hotel_id,
    ]);
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'ai_assignments', $2, $3, $4)", [
      member.hotel_id, JSON.stringify({ before, after }), "担当範囲の変更", member.id,
    ]);
  });
}
