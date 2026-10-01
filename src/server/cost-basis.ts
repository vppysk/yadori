import { configuredModelId, type ModelTier } from "@/lib/llm/models";
import { query, queryOne } from "./db";
import type { Pattern } from "./hotel";

// 人が対応した場合のコストとAIの単価の前提（docs/000_plan.md 4.3）。経営ダッシュボードとモデルの見直しで共通に使う

export const TIERS: ModelTier[] = ["small", "medium", "large"];
export const PATTERN_LABELS: Record<Pattern, string> = { info: "案内", order: "オーダー受付", external: "館外の案内", reservation: "予約の問い合わせ", complaint: "クレーム" };
export const PATTERNS = Object.keys(PATTERN_LABELS) as Pattern[];

// 前提の値が未入力のときのサンプル値（画面に「サンプル値」と出す）
const SAMPLE_WAGE_JPY = 1500;
const SAMPLE_MINUTES: Record<Pattern, number> = { info: 3, order: 2, external: 5, reservation: 8, complaint: 15 };

// 法定の深夜（22〜5時）。時間帯の割増率は、帯のうちこの時間にかかる割合 × 深夜割増率
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4]);
function bandMultiplier(startsAt: number, endsAt: number, nightRate: number): number {
  const hours: number[] = [];
  for (let h = startsAt; h !== endsAt || hours.length === 0; h = (h + 1) % 24) hours.push(h);
  return 1 + nightRate * (hours.filter((h) => NIGHT_HOURS.has(h)).length / hours.length);
}

export type CostBasis = {
  wageJpy: number; // 計算に使う値（未入力ならサンプル値）
  wageEntered: number | null;
  minutes: Record<Pattern, number>;
  minutesEntered: Record<Pattern, number | null>;
  sample: boolean;
  fxUsdJpy: number;
  nightPremiumRate: number;
  bands: { id: string; name: string; range: string; multiplier: number }[];
  prices: Record<ModelTier, { modelId: string; inputUsdPerMtok: number; outputUsdPerMtok: number }>;
};

export async function getCostBasis(hotelId: string): Promise<CostBasis> {
  const [settings, bands, handling, prices] = await Promise.all([
    queryOne<{ hourly_wage_jpy: number | null; fx_usd_jpy: string; night_premium_rate: string }>(
      "select hourly_wage_jpy, fx_usd_jpy, night_premium_rate from hotels where id = $1",
      [hotelId],
    ),
    query<{ id: string; name: string; starts_at: string; ends_at: string }>(
      "select id, name, to_char(starts_at, 'FMHH24') starts_at, to_char(ends_at, 'FMHH24') ends_at from time_bands where hotel_id = $1 order by sort",
      [hotelId],
    ),
    query<{ pattern: Pattern; minutes: string }>("select pattern, minutes from handling_times where hotel_id = $1 and phase in ('all', 'intake')", [hotelId]),
    query<{ model_id: string; input_usd_per_mtok: string; output_usd_per_mtok: string }>(
      "select distinct on (model_id) model_id, input_usd_per_mtok, output_usd_per_mtok from model_prices where effective_from <= current_date order by model_id, effective_from desc",
    ),
  ]);
  const nightRate = Number(settings?.night_premium_rate ?? 0.25);
  const minutesEntered = Object.fromEntries(PATTERNS.map((p) => {
    const m = handling.find((h) => h.pattern === p);
    return [p, m ? Number(m.minutes) : null];
  })) as Record<Pattern, number | null>;
  return {
    wageJpy: settings?.hourly_wage_jpy ?? SAMPLE_WAGE_JPY,
    wageEntered: settings?.hourly_wage_jpy ?? null,
    minutes: Object.fromEntries(PATTERNS.map((p) => [p, minutesEntered[p] ?? SAMPLE_MINUTES[p]])) as Record<Pattern, number>,
    minutesEntered,
    sample: !settings?.hourly_wage_jpy || handling.length === 0,
    fxUsdJpy: Number(settings?.fx_usd_jpy ?? 150),
    nightPremiumRate: nightRate,
    bands: bands.map((b) => ({ id: b.id, name: b.name, range: `${b.starts_at}–${b.ends_at}時`, multiplier: bandMultiplier(Number(b.starts_at), Number(b.ends_at), nightRate) })),
    prices: Object.fromEntries(
      TIERS.map((tier) => {
        const modelId = configuredModelId(tier);
        const price = prices.find((p) => p.model_id === modelId);
        return [tier, { modelId, inputUsdPerMtok: Number(price?.input_usd_per_mtok ?? 0), outputUsdPerMtok: Number(price?.output_usd_per_mtok ?? 0) }];
      }),
    ) as CostBasis["prices"],
  };
}

export function multiplierOf(basis: CostBasis, bandId: string | null): number {
  return basis.bands.find((b) => b.id === bandId)?.multiplier ?? 1;
}

// 1件あたりのAI費（平均トークン × 単価）
export function callCostJpy(basis: CostBasis, tier: ModelTier, tokens: { input: number; output: number }): number {
  const p = basis.prices[tier];
  return ((tokens.input * p.inputUsdPerMtok + tokens.output * p.outputUsdPerMtok) / 1_000_000) * basis.fxUsdJpy;
}

export function tierOfModel(basis: CostBasis, modelId: string): ModelTier | undefined {
  return TIERS.find((t) => basis.prices[t].modelId === modelId);
}
