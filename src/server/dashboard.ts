import type { ModelTier } from "@/lib/llm/models";
import { AI_CAUSED, TALK_CAUSES, type TalkCause } from "@/lib/talk-causes";
import { AI_JOBS, COMPLAINT_TIER, listModels, REVIEWED_JOBS, jobKey } from "./ai-jobs";
import type { Member } from "./auth";
import { getCostBasis, multiplierOf, PATTERN_LABELS, PATTERNS, tierOfModel, type CostBasis } from "./cost-basis";
import { query, queryOne, transaction } from "./db";
import type { Pattern } from "./hotel";
import { countOpenReviews, getTargets, type Targets } from "./model-review";

// 経営ダッシュボード（docs/000_plan.md 4.3）: AIの成果・取りこぼし・満足度・AIの仕事の一覧・前提の値。
// モデルの見直し（提案レポート・試験運用）は /manage/models（model-review.ts）

export type JobRow = {
  key: string;
  group: string;
  label: string;
  reviewed: boolean;
  fixedReason?: string;
  models: string[]; // 使っているモデル（表示名、件数の多い順）
  monthlyCalls: number;
  monthlyJpy: number;
  avgMs: number | null;
};

export type Assumptions = {
  wageJpy: number | null;
  nightPremiumRate: number; // 法定の深夜割増（22〜5時、25%以上）
  minutes: Record<Pattern, number | null>;
  fxUsdJpy: number;
};

export type DashboardData = {
  days: number;
  demoData: boolean;
  sampleAssumptions: boolean;
  assumptions: Assumptions;
  wageJpy: number;
  patterns: { key: Pattern; label: string; minutes: number }[];
  results: { volume: number; aiResolved: number; savedMinutes: number; savedJpy: number; aiCostJpy: number; costByModel: { model: string; jpy: number }[] };
  misses: {
    reasons: { key: string; label: string; n: number; minutes: number }[];
    // 「人と話したい」の理由（分類済みのもの。月あたり）
    talkCauses: { cause: TalkCause; n: number }[];
    unansweredMinutes: number;
    gaps: { question: string; askCount: number }[];
    openGaps: number;
  };
  satisfaction: {
    targets: Targets;
    unansweredRate: number | null; // AIが受けた回答に対する率
    aiTalkRate: number | null;
    wantsStaffRate: number | null;
    orderOnTimeRate: number | null;
  };
  jobs: JobRow[];
  // 見直しの対象の仕事の、いまのモデル
  models: { key: string; label: string; tier: ModelTier; fixed?: boolean }[];
  reviews: { reports: number; trials: number };
};

const TIER_NAME: Record<ModelTier, string> = { small: "Lightning", medium: "Super", large: "Ultra" };
const modelName = (basis: CostBasis, modelId: string) => {
  const tier = tierOfModel(basis, modelId);
  return tier ? TIER_NAME[tier] : modelId.replace(/^.*\//, "");
};

const MISS_LABELS: Record<string, string> = {
  unanswered: "AIが答えられなかった",
  safety: "安全に関わる内容（必ず人へ）",
  talk: "スタッフとの会話を希望",
  guardrail: "禁止事項に反した回答を止めた",
  staff_assigned: "担当が人（直接受けた）",
  complaint: "クレーム（必ず人へ）",
  other: "その他の引き継ぎ",
};

export async function getDashboard(hotelId: string, days = 30): Promise<DashboardData> {
  const since = `now() - make_interval(days => ${Number(days)})`;
  const month = 30 / days;
  // 配達（人）の実績はゲスト対応の件数に数えない
  const notDelivery = "coalesce(signals->>'phase', '') <> 'delivery'";
  const [basis, targets, resolved, llmByPurpose, misses, gaps, kpi, talks, models, reviews] = await Promise.all([
    getCostBasis(hotelId),
    getTargets(hotelId),
    query<{ pattern: Pattern; time_band_id: string | null; n: number }>(
      `select pattern, time_band_id, count(*)::int n from work_events
       where hotel_id = $1 and occurred_at > ${since} and handler_kind = 'ai' and outcome = 'resolved' and ${notDelivery} group by pattern, time_band_id`,
      [hotelId],
    ),
    query<{ purpose: string; model_id: string; calls: number; cost_usd: string; avg_ms: number }>(
      `select purpose, model_id, count(*)::int calls, coalesce(sum(cost_usd), 0) cost_usd, avg(duration_ms)::int avg_ms
       from llm_calls where hotel_id = $1 and created_at > ${since} and purpose not like 'replay%' group by purpose, model_id`,
      [hotelId],
    ),
    query<{ reason: string; pattern: Pattern; n: number }>(
      `select case
           when outcome = 'escalated_complaint' then 'complaint'
           when outcome = 'unanswered' then 'unanswered'
           when signals ? 'guardrail_blocked' then 'guardrail'
           when signals->>'safety' = 'true' then 'safety'
           when signals->>'wants_staff' = 'true' then 'talk'
           when handler_kind = 'human' then 'staff_assigned'
           else 'other' end reason, pattern, count(*)::int n
       from work_events where hotel_id = $1 and occurred_at > ${since} and ${notDelivery} and outcome <> 'resolved'
       group by 1, 2`,
      [hotelId],
    ),
    query<{ question: string; ask_count: number; total: number }>(
      "select question, ask_count, count(*) over ()::int total from knowledge_gaps where hotel_id = $1 and status = 'open' order by ask_count desc, last_asked_at desc limit 5",
      [hotelId],
    ),
    queryOne<{ volume: number; ai: number; unanswered: number; wants_staff: number; deliveries: number; on_time: number; demo: number }>(
      `select count(*) filter (where ${notDelivery})::int volume,
         count(*) filter (where ${notDelivery} and handler_kind = 'ai')::int ai,
         count(*) filter (where ${notDelivery} and handler_kind = 'ai' and outcome = 'unanswered')::int unanswered,
         count(*) filter (where signals->>'wants_staff' = 'true')::int wants_staff,
         count(*) filter (where signals->>'phase' = 'delivery')::int deliveries,
         count(*) filter (where signals->>'phase' = 'delivery' and signals->>'on_time' = 'true')::int on_time,
         count(*) filter (where signals->>'demo' = 'true')::int demo
       from work_events where hotel_id = $1 and occurred_at > ${since}`,
      [hotelId],
    ),
    query<{ cause: TalkCause; n: number }>(
      `select cause, count(*)::int n from talk_request_reviews where hotel_id = $1 and requested_at > ${since} group by cause`,
      [hotelId],
    ),
    listModels(hotelId),
    countOpenReviews(hotelId),
  ]);
  const fx = basis.fxUsdJpy;

  let savedMinutes = 0;
  let savedJpy = 0;
  for (const r of resolved) {
    const minutes = r.n * basis.minutes[r.pattern];
    savedMinutes += minutes;
    savedJpy += (minutes / 60) * basis.wageJpy * multiplierOf(basis, r.time_band_id);
  }

  const jobOf = (purpose: string) => AI_JOBS.find((j) => j.purposes.includes(purpose)) ?? AI_JOBS.find((j) => j.key === "other")!;
  const jobs: JobRow[] = AI_JOBS.map(({ key, group, label, reviewed, fixedReason }) => {
    const rows = llmByPurpose.filter((r) => jobOf(r.purpose).key === key).sort((a, b) => b.calls - a.calls);
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    return {
      key, group, label, reviewed: !!reviewed, fixedReason,
      models: [...new Set(rows.map((r) => modelName(basis, r.model_id)))],
      monthlyCalls: calls * month,
      monthlyJpy: rows.reduce((a, r) => a + Number(r.cost_usd), 0) * fx * month,
      avgMs: calls ? Math.round(rows.reduce((a, r) => a + r.avg_ms * r.calls, 0) / calls) : null,
    };
  });
  const costByModel = new Map<string, number>();
  for (const r of llmByPurpose) {
    const cost = Number(r.cost_usd) * fx * month;
    // 単価表にないモデル（モック）は0円なので内訳に出さない
    if (cost > 0) costByModel.set(modelName(basis, r.model_id), (costByModel.get(modelName(basis, r.model_id)) ?? 0) + cost);
  }

  const missReasons = Object.keys(MISS_LABELS).map((key) => {
    const rows = misses.filter((m) => m.reason === key);
    return { key, label: MISS_LABELS[key], n: rows.reduce((a, r) => a + r.n, 0) * month, minutes: rows.reduce((a, r) => a + r.n * basis.minutes[r.pattern], 0) * month };
  }).filter((r) => r.n > 0);
  const k = kpi!;
  const aiTalks = talks.filter((t) => AI_CAUSED.includes(t.cause)).reduce((a, t) => a + t.n, 0);

  return {
    days,
    demoData: k.demo > 0,
    sampleAssumptions: basis.sample,
    assumptions: { wageJpy: basis.wageEntered, nightPremiumRate: basis.nightPremiumRate, minutes: basis.minutesEntered, fxUsdJpy: fx },
    wageJpy: basis.wageJpy,
    patterns: PATTERNS.map((p) => ({ key: p, label: PATTERN_LABELS[p], minutes: basis.minutes[p] })),
    results: {
      volume: k.volume * month,
      aiResolved: resolved.reduce((a, r) => a + r.n, 0) * month,
      savedMinutes: savedMinutes * month,
      savedJpy: savedJpy * month,
      aiCostJpy: [...costByModel.values()].reduce((a, b) => a + b, 0),
      costByModel: [...costByModel.entries()].map(([model, jpy]) => ({ model, jpy })).sort((a, b) => b.jpy - a.jpy),
    },
    misses: {
      reasons: missReasons,
      talkCauses: (Object.keys(TALK_CAUSES) as TalkCause[]).map((cause) => ({ cause, n: (talks.find((t) => t.cause === cause)?.n ?? 0) * month })).filter((c) => c.n > 0),
      unansweredMinutes: missReasons.find((r) => r.key === "unanswered")?.minutes ?? 0,
      gaps: gaps.map((g) => ({ question: g.question, askCount: g.ask_count })),
      openGaps: gaps[0]?.total ?? 0,
    },
    satisfaction: {
      targets,
      unansweredRate: k.ai ? k.unanswered / k.ai : null,
      aiTalkRate: k.ai ? aiTalks / k.ai : null,
      wantsStaffRate: k.volume ? k.wants_staff / k.volume : null,
      orderOnTimeRate: k.deliveries ? k.on_time / k.deliveries : null,
    },
    jobs,
    models: [
      ...REVIEWED_JOBS.map((j) => ({ key: jobKey(j.job, j.pattern), label: j.label, tier: models[jobKey(j.job, j.pattern)] })),
      { key: "answer:complaint", label: "ゲストへの回答：クレーム", tier: COMPLAINT_TIER, fixed: true },
    ],
    reviews,
  };
}

// 満足度の目標（上限）。モデルの見直しの提案と、試験運用の自動中断に使う
export async function saveTargets(member: Member, targets: Targets) {
  for (const v of [targets.unansweredMax, targets.aiTalkMax]) {
    if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error("目標は0より大きく100%以下にしてください");
  }
  await transaction(async (client) => {
    const { rows } = await client.query("select target_unanswered_rate_max, target_ai_talk_rate_max from hotels where id = $1", [member.hotel_id]);
    await client.query("update hotels set target_unanswered_rate_max = $2, target_ai_talk_rate_max = $3 where id = $1", [member.hotel_id, targets.unansweredMax, targets.aiTalkMax]);
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'ai_assignments', $2, $3, $4)", [
      member.hotel_id,
      JSON.stringify({ before: rows[0], after: { target_unanswered_rate_max: targets.unansweredMax, target_ai_talk_rate_max: targets.aiTalkMax } }),
      "満足度の目標の変更",
      member.id,
    ]);
  });
}

// 前提の値（人が対応した場合のコストの計算に使う）。デモの数値は本人が入力する（シードでは入れない）
export async function saveAssumptions(member: Member, input: Assumptions) {
  const num = (v: number | null, min: number, max: number) => {
    if (v === null) return null;
    if (!Number.isFinite(v) || v < min || v > max) throw new Error("数値の範囲を確認してください");
    return v;
  };
  if (!(input.nightPremiumRate >= 0.25)) throw new Error("深夜割増は25%以上にしてください（労働基準法37条4項）");
  await transaction(async (client) => {
    await client.query("update hotels set hourly_wage_jpy = $2, fx_usd_jpy = $3, night_premium_rate = $4 where id = $1", [
      member.hotel_id, input.wageJpy === null ? null : Math.round(num(input.wageJpy, 1, 100_000)!), num(input.fxUsdJpy, 1, 1000), num(input.nightPremiumRate, 0.25, 1),
    ]);
    await client.query("delete from handling_times where hotel_id = $1 and phase in ('all', 'intake')", [member.hotel_id]);
    for (const p of PATTERNS) {
      const v = num(input.minutes[p], 0, 600);
      if (v !== null) {
        await client.query("insert into handling_times (hotel_id, pattern, phase, minutes) values ($1, $2, $3, $4)", [
          member.hotel_id, p, p === "order" ? "intake" : "all", v,
        ]);
      }
    }
  });
}
