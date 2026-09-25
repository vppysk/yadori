import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import type { Pattern } from "./hotel";

// ホテル別マスタ（plan 4.4）: 人件費・対応時間・時間帯割増・為替・目標値。デモの数値は本人が入力する方針（シードでは入れない）

export type Masters = {
  jobTitles: string[];
  wages: Record<string, number | null>;
  handling: { pattern: Pattern; phase: "all" | "intake" | "delivery"; minutes: number | null }[];
  bands: { id: string; name: string; wageMultiplier: number }[];
  fxUsdJpy: number;
  infraMonthlyJpy: number;
  targetSatisfactionMin: number | null;
  targetHandoffRateMax: number | null;
  actualMinutes: Record<string, number | null>; // 実測（オーダーの配達）
};

const HANDLING_ROWS: { pattern: Pattern; phase: "all" | "intake" | "delivery" }[] = [
  { pattern: "info", phase: "all" },
  { pattern: "order", phase: "intake" },
  { pattern: "order", phase: "delivery" },
  { pattern: "external", phase: "all" },
  { pattern: "reservation", phase: "all" },
  { pattern: "complaint", phase: "all" },
];

export async function getMasters(hotelId: string): Promise<Masters> {
  const [titles, wages, handling, bands, hotel, actual] = await Promise.all([
    query<{ job_title: string }>("select distinct job_title from members where hotel_id = $1 and kind = 'human' and job_title is not null order by job_title", [hotelId]),
    query<{ job_title: string; hourly_wage_jpy: number }>("select job_title, hourly_wage_jpy from wage_rates where hotel_id = $1", [hotelId]),
    query<{ pattern: Pattern; phase: string; minutes: string }>("select pattern, phase, minutes from handling_times where hotel_id = $1", [hotelId]),
    query<{ id: string; name: string; wage_multiplier: string }>("select id, name, wage_multiplier from time_bands where hotel_id = $1 order by sort", [hotelId]),
    queryOne<{ fx_usd_jpy: string; infra_monthly_cost_jpy: number; target_satisfaction_min: string | null; target_handoff_rate_max: string | null }>(
      "select fx_usd_jpy, infra_monthly_cost_jpy, target_satisfaction_min, target_handoff_rate_max from hotels where id = $1",
      [hotelId],
    ),
    // 想定値→実測値の補正（plan 4.4）: チケットの着手〜完了から実際の配達時間を出す（デモ実績は除く）
    query<{ minutes: string | null }>(
      "select round(avg(extract(epoch from (done_at - started_at)) / 60)::numeric, 1) minutes from tickets where hotel_id = $1 and done_at is not null and started_at is not null",
      [hotelId],
    ),
  ]);
  const jobTitles = [...new Set([...titles.map((t) => t.job_title), ...wages.map((w) => w.job_title)])];
  return {
    jobTitles,
    wages: Object.fromEntries(jobTitles.map((t) => [t, wages.find((w) => w.job_title === t)?.hourly_wage_jpy ?? null])),
    handling: HANDLING_ROWS.map((r) => ({ ...r, minutes: (() => {
      const m = handling.find((h) => h.pattern === r.pattern && h.phase === r.phase);
      return m ? Number(m.minutes) : null;
    })() })),
    bands: bands.map((b) => ({ id: b.id, name: b.name, wageMultiplier: Number(b.wage_multiplier) })),
    fxUsdJpy: Number(hotel?.fx_usd_jpy ?? 150),
    infraMonthlyJpy: hotel?.infra_monthly_cost_jpy ?? 0,
    targetSatisfactionMin: hotel?.target_satisfaction_min ? Number(hotel.target_satisfaction_min) : null,
    targetHandoffRateMax: hotel?.target_handoff_rate_max ? Number(hotel.target_handoff_rate_max) : null,
    actualMinutes: { "order:delivery": actual[0]?.minutes ? Number(actual[0].minutes) : null },
  };
}

export async function saveMasters(member: Member, input: Omit<Masters, "jobTitles" | "actualMinutes">) {
  const num = (v: number | null, min: number, max: number) => (v === null ? null : Number.isFinite(v) && v >= min && v <= max ? v : (() => { throw new Error("数値の範囲を確認してください"); })());
  await transaction(async (client) => {
    await client.query("delete from wage_rates where hotel_id = $1", [member.hotel_id]);
    for (const [title, wage] of Object.entries(input.wages)) {
      const v = num(wage, 1, 100_000);
      if (v !== null) await client.query("insert into wage_rates (hotel_id, job_title, hourly_wage_jpy) values ($1, $2, $3)", [member.hotel_id, title.slice(0, 40), Math.round(v)]);
    }
    await client.query("delete from handling_times where hotel_id = $1", [member.hotel_id]);
    for (const h of input.handling) {
      const v = num(h.minutes, 0, 600);
      if (v !== null) await client.query("insert into handling_times (hotel_id, pattern, phase, minutes) values ($1, $2, $3, $4)", [member.hotel_id, h.pattern, h.phase, v]);
    }
    for (const b of input.bands) {
      await client.query("update time_bands set wage_multiplier = $3 where id = $1 and hotel_id = $2", [b.id, member.hotel_id, num(b.wageMultiplier, 0.5, 3)]);
    }
    await client.query(
      "update hotels set fx_usd_jpy = $2, infra_monthly_cost_jpy = $3, target_satisfaction_min = $4, target_handoff_rate_max = $5 where id = $1",
      [member.hotel_id, num(input.fxUsdJpy, 1, 1000), Math.round(num(input.infraMonthlyJpy, 0, 100_000_000) ?? 0), num(input.targetSatisfactionMin, 0, 1), num(input.targetHandoffRateMax, 0, 1)],
    );
  });
}
