import type { PoolClient } from "pg";
import type { ModelTier } from "@/lib/llm/models";
import { AI_CAUSED } from "@/lib/talk-causes";
import { REVIEWED_JOBS, jobKey, jobLabel, type ModelJob } from "./ai-jobs";
import type { Member } from "./auth";
import { callCostJpy, getCostBasis, multiplierOf, TIERS, tierOfModel, type CostBasis } from "./cost-basis";
import { ISO_TIMESTAMP, query, queryOne, transaction } from "./db";
import type { Pattern } from "./hotel";
import { isEn, tr } from "@/lib/i18n";

// モデルの見直し（docs/000_plan.md 4.3）: 定期評価 → 提案レポート → 承認（全部適用か試験運用）→ 自動中断。
// 定期評価はLLMを使わず、過去30日の実績から計算する

const DAYS = 30;
// 実測とみなす件数（これ未満は「未計測」）。試験運用の自動中断もこの件数から判定する
export const MIN_SAMPLES = 20;
// 切り替えを提案する総額の差（月）、下の段階の試験運用を提案する費用の差（月）
const MIN_SAVING_JPY = 100;
const TRIAL_SAVING_JPY = 1000;
// 上の段階の試験運用を提案する条件: 損益分岐が1ポイント以下で、人に回る率が3%以上
const TRIAL_BREAKEVEN_PT = 1;
const TRIAL_MIN_HANDOFF = 0.03;
const DEFAULT_TOKENS = { input: 2600, output: 150 };
const NEIGHBORS: Record<ModelTier, ModelTier[]> = { small: ["medium"], medium: ["large", "small"], large: ["medium"] };

// モデルごとの実測。AI相談は人への引き継ぎがないため、答えられなかった件数を人に回る件数と同じに扱う（上長に確認する手間）
export type TierStat = { n: number; handoffRate: number; unansweredRate: number; aiTalkRate: number; avgMs: number; costJpy: number };
export type JobStats = {
  job: ModelJob;
  pattern: string;
  key: string;
  label: string;
  volume: number; // 月の件数
  humanCaseJpy: number; // 人が対応した場合の1件のコスト
  current: ModelTier;
  tokens: { input: number; output: number };
  byTier: Partial<Record<ModelTier, TierStat>>;
};
export type Targets = { unansweredMax: number; aiTalkMax: number };

export async function getTargets(hotelId: string): Promise<Targets> {
  const row = await queryOne<{ u: string; t: string }>("select target_unanswered_rate_max u, target_ai_talk_rate_max t from hotels where id = $1", [hotelId]);
  return { unansweredMax: Number(row?.u ?? 0.05), aiTalkMax: Number(row?.t ?? 0.01) };
}

export const meetsTargets = (stat: TierStat, targets: Targets) => stat.unansweredRate <= targets.unansweredMax && stat.aiTalkRate <= targets.aiTalkMax;

// 仕事ごとの判定の基準。満足度の目標はゲストへの回答のもの。AI相談は「答えられなかった」の多くが情報の不足によるため、
// いまのモデルより2ポイント以上悪くならないこと（目標より緩い場合は目標）を基準にする
const AI_ASK_TOLERANCE = 0.02;
export function jobTargets(s: JobStats, targets: Targets): Targets {
  if (s.job === "answer") return targets;
  const current = s.byTier[s.current];
  return { unansweredMax: Math.max(targets.unansweredMax, (current?.unansweredRate ?? 0) + AI_ASK_TOLERANCE), aiTalkMax: 1 };
}

// 見直しの対象の仕事ごとに、モデル別の実測を集める（since 以降。既定は過去30日）
export async function collectJobStats(hotelId: string, basis: CostBasis, since = `now() - make_interval(days => ${DAYS})`): Promise<JobStats[]> {
  const notDelivery = "coalesce(signals->>'phase', '') <> 'delivery'";
  const [events, volumes, calls, talks, models] = await Promise.all([
    query<{ pattern: Pattern; handler: string; n: number; handed: number; unanswered: number }>(
      `select pattern, handler, count(*)::int n, count(*) filter (where outcome in ('handed_off', 'unanswered'))::int handed,
         count(*) filter (where outcome = 'unanswered')::int unanswered
       from work_events where hotel_id = $1 and occurred_at > ${since} and handler_kind = 'ai' and ${notDelivery} group by pattern, handler`,
      [hotelId],
    ),
    query<{ pattern: Pattern; time_band_id: string | null; n: number }>(
      `select pattern, time_band_id, count(*)::int n from work_events where hotel_id = $1 and occurred_at > ${since} and ${notDelivery} group by pattern, time_band_id`,
      [hotelId],
    ),
    query<{ purpose: string; pattern: Pattern | null; model_id: string; n: number; ms: number; cost_usd: string; input: number; output: number; unanswered: string | null }>(
      `select purpose, pattern, model_id, count(*)::int n, avg(duration_ms)::int ms, avg(cost_usd) cost_usd, avg(input_tokens)::int input, avg(output_tokens)::int output,
         avg(unanswered::int) unanswered
       from llm_calls where hotel_id = $1 and created_at > ${since} and purpose in ('answer', 'staff_ask') group by purpose, pattern, model_id`,
      [hotelId],
    ),
    query<{ pattern: Pattern | null; model_id: string | null; n: number }>(
      `select pattern, model_id, count(*)::int n from talk_request_reviews
       where hotel_id = $1 and requested_at > ${since} and cause = any($2) group by pattern, model_id`,
      [hotelId, AI_CAUSED],
    ),
    query<{ job: ModelJob; pattern: string; tier: ModelTier }>("select job, pattern, tier from ai_models where hotel_id = $1", [hotelId]),
  ]);
  const fx = basis.fxUsdJpy;
  return REVIEWED_JOBS.map(({ job, pattern, label }) => {
    const current = models.find((m) => m.job === job && m.pattern === pattern)?.tier ?? "medium";
    const jobCalls = calls.filter((c) => (job === "answer" ? c.purpose === "answer" && c.pattern === pattern : c.purpose === "staff_ask"));
    const callCount = jobCalls.reduce((a, c) => a + c.n, 0);
    const tokens = callCount
      ? { input: Math.round(jobCalls.reduce((a, c) => a + c.input * c.n, 0) / callCount), output: Math.round(jobCalls.reduce((a, c) => a + c.output * c.n, 0) / callCount) }
      : DEFAULT_TOKENS;
    const byTier: Partial<Record<ModelTier, TierStat>> = {};
    let volume: number;
    let humanCaseJpy: number;
    if (job === "answer") {
      const p = pattern as Pattern;
      const bandRows = volumes.filter((v) => v.pattern === p);
      volume = bandRows.reduce((a, v) => a + v.n, 0) * (30 / DAYS);
      const weighted = volume ? bandRows.reduce((a, v) => a + v.n * multiplierOf(basis, v.time_band_id), 0) / bandRows.reduce((a, v) => a + v.n, 0) : 1;
      humanCaseJpy = (basis.wageJpy / 60) * basis.minutes[p] * weighted;
      for (const e of events.filter((x) => x.pattern === p)) {
        const tier = tierOfModel(basis, e.handler);
        if (!tier || e.n === 0) continue;
        const c = jobCalls.find((x) => x.model_id === e.handler);
        const aiTalks = talks.filter((t) => t.pattern === p && t.model_id === e.handler).reduce((a, t) => a + t.n, 0);
        byTier[tier] = {
          n: e.n, handoffRate: e.handed / e.n, unansweredRate: e.unanswered / e.n, aiTalkRate: aiTalks / e.n,
          avgMs: c?.ms ?? 0, costJpy: c ? Number(c.cost_usd) * fx : callCostJpy(basis, tier, tokens),
        };
      }
    } else {
      volume = callCount * (30 / DAYS);
      humanCaseJpy = (basis.wageJpy / 60) * basis.minutes.info;
      for (const c of jobCalls) {
        const tier = tierOfModel(basis, c.model_id);
        if (!tier || c.n === 0) continue;
        const rate = c.unanswered === null ? 0 : Number(c.unanswered);
        byTier[tier] = { n: c.n, handoffRate: rate, unansweredRate: rate, aiTalkRate: 0, avgMs: c.ms, costJpy: Number(c.cost_usd) * fx };
      }
    }
    return { job, pattern, key: jobKey(job, pattern), label, volume, humanCaseJpy, current, tokens, byTier };
  });
}

const measured = (s: JobStats, tier: ModelTier) => {
  const stat = s.byTier[tier];
  return stat && stat.n >= MIN_SAMPLES ? stat : undefined;
};
const costOf = (basis: CostBasis, s: JobStats, tier: ModelTier) => measured(s, tier)?.costJpy ?? callCostJpy(basis, tier, s.tokens);

// 人に回る率の差の片側95%の上限（小さい件数の偶然の差で提案しないため、悲観的な値で判断する）
function pessimisticDiff(from: TierStat, to: TierStat): number {
  const p = (s: TierStat) => Math.min(Math.max(s.handoffRate, 0.5 / s.n), 1);
  const se = Math.sqrt((p(from) * (1 - p(from))) / from.n + (p(to) * (1 - p(to))) / to.n);
  return to.handoffRate - from.handoffRate + 1.645 * se;
}

const TIER_NAME: Record<ModelTier, string> = { small: "Lightning", medium: "Super", large: "Ultra" };
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const yen = (v: number) => (isEn ? `${v >= 0 ? "+" : "−"}¥${Math.round(Math.abs(v)).toLocaleString("ja-JP")}` : `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v)).toLocaleString("ja-JP")}円`);

export type ReportDetail = {
  volume: number;
  humanCaseJpy: number;
  current: { tier: ModelTier; stat: TierStat | null };
  candidate: { tier: ModelTier; stat: TierStat | null };
  targets: Targets;
  aiCostPerMonth: number; // AI費の差（月）
  // 実測があるときだけ
  handoffsPerMonth: number | null; // 人に回る件数の差（月）
  humanCostPerMonth: number | null;
  totalPerMonth: number | null;
  pessimisticTotalPerMonth: number | null;
  breakevenPt: number | null; // 人に回る率が何ポイント下がれば元が取れるか
};
type Candidate = { kind: "switch" | "trial"; to: ModelTier; reason: string; detail: ReportDetail; score: number };

// 1つの仕事の見直し案（切り替えを優先。なければ試験運用。どちらもなければ undefined）
export function evaluateJob(basis: CostBasis, s: JobStats, hotelTargets: Targets): Candidate | undefined {
  const targets = jobTargets(s, hotelTargets);
  const from = s.current;
  const current = measured(s, from);
  if (!current) return undefined;
  const currentOk = meetsTargets(current, targets);
  let best: Candidate | undefined;
  for (const to of NEIGHBORS[from]) {
    const stat = measured(s, to);
    const costDiff = costOf(basis, s, to) - costOf(basis, s, from);
    const aiCostPerMonth = s.volume * costDiff;
    const breakevenPt = s.humanCaseJpy > 0 ? (costDiff / s.humanCaseJpy) * 100 : null;
    const base = { volume: s.volume, humanCaseJpy: s.humanCaseJpy, current: { tier: from, stat: current }, targets, aiCostPerMonth, breakevenPt };
    if (stat) {
      if (!meetsTargets(stat, targets)) continue;
      const handoffsPerMonth = s.volume * (stat.handoffRate - current.handoffRate);
      const humanCostPerMonth = handoffsPerMonth * s.humanCaseJpy;
      const total = aiCostPerMonth + humanCostPerMonth;
      const pessimistic = aiCostPerMonth + s.volume * pessimisticDiff(current, stat) * s.humanCaseJpy;
      if (currentOk && pessimistic > -MIN_SAVING_JPY) continue;
      const candidate: Candidate = {
        kind: "switch", to, score: currentOk ? total : -1e9 + total,
        detail: { ...base, candidate: { tier: to, stat }, handoffsPerMonth, humanCostPerMonth, totalPerMonth: total, pessimisticTotalPerMonth: pessimistic },
        reason: [
          currentOk ? null : tr(`いまの${TIER_NAME[from]}は満足度の目標を外れています（答えられなかった ${pct(current.unansweredRate)}・AI起因の会話希望 ${pct(current.aiTalkRate)}）`, `The current ${TIER_NAME[from]} misses the satisfaction targets (unanswered ${pct(current.unansweredRate)}, AI-caused staff requests ${pct(current.aiTalkRate)})`),
          tr(`人に回る率 ${pct(current.handoffRate)}→${pct(stat.handoffRate)}（実測 ${current.n}件・${stat.n}件）`, `Handoff rate ${pct(current.handoffRate)} → ${pct(stat.handoffRate)} (measured on ${current.n} and ${stat.n} cases)`),
          tr(`総額 ${yen(total)}／月（悲観的に見ても ${yen(pessimistic)}）`, `Total ${yen(total)}/month (${yen(pessimistic)} even in a pessimistic case)`),
        ].filter(Boolean).join(tr("。", ". ")),
      };
      if (!best || best.kind === "trial" || candidate.score < best.score) best = candidate;
      continue;
    }
    if (best?.kind === "switch") continue;
    const upgrade = TIERS.indexOf(to) > TIERS.indexOf(from);
    const why = !currentOk && upgrade
      ? tr(`いまの${TIER_NAME[from]}は満足度の目標を外れています（答えられなかった ${pct(current.unansweredRate)}・AI起因の会話希望 ${pct(current.aiTalkRate)}）`, `The current ${TIER_NAME[from]} misses the satisfaction targets (unanswered ${pct(current.unansweredRate)}, AI-caused staff requests ${pct(current.aiTalkRate)})`)
      : upgrade && breakevenPt !== null && breakevenPt <= TRIAL_BREAKEVEN_PT && current.handoffRate >= TRIAL_MIN_HANDOFF
        ? tr(
            `人に回る率 ${pct(current.handoffRate)}。${TIER_NAME[to]}は人に回る率が ${breakevenPt.toFixed(2)}ポイント下がれば元が取れます`,
            `Handoff rate is ${pct(current.handoffRate)}. ${TIER_NAME[to]} pays for itself if it lowers handoffs by ${breakevenPt.toFixed(2)} points`,
          )
        : !upgrade && -aiCostPerMonth >= TRIAL_SAVING_JPY
          ? tr(`${TIER_NAME[to]}にするとAI費が ${yen(aiCostPerMonth)}／月`, `Switching to ${TIER_NAME[to]} changes AI cost by ${yen(aiCostPerMonth)}/month`)
          : undefined;
    if (!why) continue;
    const candidate: Candidate = {
      kind: "trial", to, score: upgrade ? 0 : 1,
      detail: { ...base, candidate: { tier: to, stat: null }, handoffsPerMonth: null, humanCostPerMonth: null, totalPerMonth: null, pessimisticTotalPerMonth: null },
      reason: tr(`${why}。${TIER_NAME[to]}の実測がないため、一部で試して確かめます`, `${why}. There is no measured data for ${TIER_NAME[to]} yet, so try it on part of the traffic`),
    };
    if (!best || candidate.score < best.score) best = candidate;
  }
  return best;
}

// 定期評価: 仕事ごとに見直し案を作り、提案レポートを更新する（会話ログの定期評価のあとに呼ぶ）
export async function evaluateModels(hotelId: string): Promise<{ open: number }> {
  const [basis, targets] = await Promise.all([getCostBasis(hotelId), getTargets(hotelId)]);
  const stats = await collectJobStats(hotelId, basis);
  const trials = await query<{ job: ModelJob; pattern: string }>(
    "select job, pattern from model_trials where hotel_id = $1 and stopped_at is null and ends_at > now()",
    [hotelId],
  );
  let open = 0;
  for (const s of stats) {
    const existing = await queryOne<{ id: string; kind: string; to_tier: string; from_tier: string }>(
      "select id, kind, to_tier, from_tier from model_reports where hotel_id = $1 and job = $2 and pattern = $3 and status = 'open'",
      [hotelId, s.job, s.pattern],
    );
    // 試験運用中の仕事は提案しない
    const candidate = trials.some((t) => t.job === s.job && t.pattern === s.pattern) ? undefined : evaluateJob(basis, s, targets);
    if (existing && candidate && existing.kind === candidate.kind && existing.to_tier === candidate.to && existing.from_tier === s.current) {
      await query("update model_reports set reason = $2, detail = $3, updated_at = now() where id = $1", [existing.id, candidate.reason, JSON.stringify(candidate.detail)]);
      open++;
      continue;
    }
    if (existing) await query("update model_reports set status = 'withdrawn', updated_at = now() where id = $1", [existing.id]);
    if (candidate) {
      await query(
        `insert into model_reports (hotel_id, job, pattern, kind, from_tier, to_tier, reason, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [hotelId, s.job, s.pattern, candidate.kind, s.current, candidate.to, candidate.reason, JSON.stringify(candidate.detail)],
      );
      open++;
    }
  }
  return { open };
}

async function snapshot(client: PoolClient, hotelId: string) {
  const [models, trials] = await Promise.all([
    client.query("select job, pattern, tier from ai_models where hotel_id = $1 order by job, pattern", [hotelId]),
    client.query("select id, job, pattern, tier, share, starts_at, ends_at, stopped_at, stop_reason from model_trials where hotel_id = $1 and (stopped_at is null and ends_at > now())", [hotelId]),
  ]);
  return { models: models.rows, trials: trials.rows };
}

async function revise(client: PoolClient, hotelId: string, memberId: string | null, note: string, fn: () => Promise<void>) {
  const before = await snapshot(client, hotelId);
  await fn();
  const after = await snapshot(client, hotelId);
  await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'ai_assignments', $2, $3, $4)", [
    hotelId, JSON.stringify({ before, after }), note, memberId,
  ]);
}

export type Decision = { mode: "apply" } | { mode: "trial"; share: number; days: number };

// 提案レポートの承認: 全部適用するか、割合と期間を決めて試験運用する
export async function approveReport(member: Member, reportId: string, decision: Decision) {
  await transaction(async (client) => {
    const { rows } = await client.query<{ job: ModelJob; pattern: string; kind: string; from_tier: ModelTier; to_tier: ModelTier; reason: string }>(
      "select job, pattern, kind, from_tier, to_tier, reason from model_reports where id = $1 and hotel_id = $2 and status = 'open' for update",
      [reportId, member.hotel_id],
    );
    const report = rows[0];
    if (!report) throw new Error(tr("この提案はすでに判断済みか、取り下げられています", "This proposal has already been decided or withdrawn"));
    const { rows: model } = await client.query<{ tier: ModelTier }>("select tier from ai_models where hotel_id = $1 and job = $2 and pattern = $3 for update", [
      member.hotel_id, report.job, report.pattern,
    ]);
    if (model[0]?.tier !== report.from_tier) throw new Error(tr("いまのモデルが提案の時点から変わっています。次の定期評価を待ってください", "The model has changed since this proposal. Please wait for the next review"));
    const label = `${jobLabel(report.job, report.pattern)}：${TIER_NAME[report.from_tier]}→${TIER_NAME[report.to_tier]}`;
    if (decision.mode === "apply") {
      if (report.kind !== "switch") throw new Error(tr("実測がないため、まず試験運用してください", "There is no measured data, so run a trial first"));
      await revise(client, member.hotel_id, member.id, tr(`提案の承認（全部適用）: ${label}。${report.reason}`, `Approved proposal (applied to all): ${label}. ${report.reason}`), async () => {
        await client.query("update ai_models set tier = $4 where hotel_id = $1 and job = $2 and pattern = $3", [member.hotel_id, report.job, report.pattern, report.to_tier]);
      });
      await client.query("update model_reports set status = 'applied', decided_by = $2, decided_at = now() where id = $1", [reportId, member.id]);
      return;
    }
    const share = Number(decision.share);
    const days = Math.round(Number(decision.days));
    if (!(share >= 0.01 && share <= 0.5)) throw new Error(tr("割合は1〜50%にしてください", "Share must be 1–50%"));
    if (!(days >= 1 && days <= 60)) throw new Error(tr("期間は1〜60日にしてください", "Duration must be 1–60 days"));
    await revise(client, member.hotel_id, member.id, tr(`提案の承認（試験運用 ${Math.round(share * 100)}%・${days}日）: ${label}。${report.reason}`, `Approved proposal (trial ${Math.round(share * 100)}%, ${days} days): ${label}. ${report.reason}`), async () => {
      await client.query(
        `insert into model_trials (hotel_id, job, pattern, report_id, from_tier, tier, share, ends_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9)`,
        [member.hotel_id, report.job, report.pattern, reportId, report.from_tier, report.to_tier, share, days, member.id],
      );
    });
    await client.query("update model_reports set status = 'trialing', decided_by = $2, decided_at = now() where id = $1", [reportId, member.id]);
  });
}

export async function dismissReport(member: Member, reportId: string) {
  const rows = await query("update model_reports set status = 'dismissed', decided_by = $3, decided_at = now() where id = $1 and hotel_id = $2 and status = 'open' returning id", [
    reportId, member.hotel_id, member.id,
  ]);
  if (rows.length === 0) throw new Error(tr("この提案はすでに判断済みか、取り下げられています", "This proposal has already been decided or withdrawn"));
}

async function stop(client: PoolClient, hotelId: string, trialId: string, memberId: string | null, reason: string): Promise<boolean> {
  const { rows } = await client.query<{ job: ModelJob; pattern: string; tier: ModelTier; from_tier: ModelTier }>(
    "select job, pattern, tier, from_tier from model_trials where id = $1 and hotel_id = $2 and stopped_at is null and ends_at > now() for update",
    [trialId, hotelId],
  );
  const trial = rows[0];
  if (!trial) return false;
  await revise(client, hotelId, memberId, tr(`試験運用の中断: ${jobLabel(trial.job, trial.pattern)}の${TIER_NAME[trial.tier]}。${reason}`, `Stopped trial: ${TIER_NAME[trial.tier]} for ${jobLabel(trial.job, trial.pattern)}. ${reason}`), async () => {
    await client.query("update model_trials set stopped_at = now(), stop_reason = $2 where id = $1", [trialId, reason]);
  });
  return true;
}

export async function stopTrial(member: Member, trialId: string) {
  const stopped = await transaction((client) => stop(client, member.hotel_id, trialId, member.id, tr("手動で中断", "Stopped manually")));
  if (!stopped) throw new Error(tr("この試験運用はすでに終わっています", "This trial has already ended"));
}

// 試験運用の自動中断（cron から呼ぶ）: 試すモデルの実績が MIN_SAMPLES 件以上たまり、満足度の目標を外れたら止めて、承認できる人に通知する
export async function monitorTrials(hotelId: string): Promise<number> {
  const trials = await query<{ id: string; job: ModelJob; pattern: string; tier: ModelTier; starts_at: string }>(
    `select id, job, pattern, tier, ${ISO_TIMESTAMP("starts_at")} starts_at from model_trials where hotel_id = $1 and stopped_at is null and ends_at > now() and not demo`,
    [hotelId],
  );
  if (trials.length === 0) return 0;
  const [basis, targets] = await Promise.all([getCostBasis(hotelId), getTargets(hotelId)]);
  let stopped = 0;
  const recent = await collectJobStats(hotelId, basis);
  for (const t of trials) {
    const stats = await collectJobStats(hotelId, basis, `'${t.starts_at}'::timestamptz`);
    const stat = stats.find((s) => s.job === t.job && s.pattern === t.pattern)?.byTier[t.tier];
    const base = recent.find((s) => s.job === t.job && s.pattern === t.pattern);
    const limit = base ? jobTargets(base, targets) : targets;
    if (!stat || stat.n < MIN_SAMPLES || meetsTargets(stat, limit)) continue;
    const reason = t.job === "answer"
      ? tr(
          `自動中断: 答えられなかった ${pct(stat.unansweredRate)}（目標 ${pct(limit.unansweredMax)}以下）・AI起因の会話希望 ${pct(stat.aiTalkRate)}（目標 ${pct(limit.aiTalkMax)}以下）、実測 ${stat.n}件`,
          `Auto-stopped: unanswered ${pct(stat.unansweredRate)} (target ≤ ${pct(limit.unansweredMax)}), AI-caused staff requests ${pct(stat.aiTalkRate)} (target ≤ ${pct(limit.aiTalkMax)}), measured on ${stat.n} cases`,
        )
      : tr(
          `自動中断: 答えられなかった ${pct(stat.unansweredRate)}（いまのモデルより悪い。基準 ${pct(limit.unansweredMax)}以下）、実測 ${stat.n}件`,
          `Auto-stopped: unanswered ${pct(stat.unansweredRate)} (worse than the current model; limit ≤ ${pct(limit.unansweredMax)}), measured on ${stat.n} cases`,
        );
    const done = await transaction((client) => stop(client, hotelId, t.id, null, reason));
    if (!done) continue;
    stopped++;
    await query(
      `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
       select id, 'model_trial_stopped', $2, $3, 'model_trial', $4 from members
       where hotel_id = $1 and kind = 'human' and active and has_permission(id, 'settings.ai_assignment')`,
      [hotelId, tr(`試験運用を自動で中断しました（${jobLabel(t.job, t.pattern)}）`, `A trial was stopped automatically (${jobLabel(t.job, t.pattern)})`), reason, t.id],
    );
  }
  return stopped;
}

// 画面（/manage/models）の材料
export type ReportRow = { id: string; job: ModelJob; pattern: string; label: string; kind: "switch" | "trial"; from: ModelTier; to: ModelTier; reason: string; detail: ReportDetail; status: string; updatedAt: string; decidedAt: string | null; decidedBy: string | null };
export type TrialRow = {
  id: string; label: string; from: ModelTier; tier: ModelTier; share: number; startsAt: string; endsAt: string; active: boolean; stopReason: string | null;
  stat: TierStat | null; volume: number;
  limit: Targets; // 自動中断の基準（AI相談はいまのモデルとの比較）
};
export type ModelReviewPage = { targets: Targets; stats: JobStats[]; reports: ReportRow[]; decided: ReportRow[]; trials: TrialRow[]; lastEvaluatedAt: string | null; demoData: boolean };

export async function getModelReviewPage(hotelId: string): Promise<ModelReviewPage> {
  const [basis, targets] = await Promise.all([getCostBasis(hotelId), getTargets(hotelId)]);
  const [stats, reports, trials, last, demo] = await Promise.all([
    collectJobStats(hotelId, basis),
    query<{ id: string; job: ModelJob; pattern: string; kind: "switch" | "trial"; from_tier: ModelTier; to_tier: ModelTier; reason: string; detail: ReportDetail; status: string; updated_at: string; decided_at: string | null; decided_by: string | null }>(
      `select r.id, r.job, r.pattern, r.kind, r.from_tier, r.to_tier, r.reason, r.detail, r.status, ${ISO_TIMESTAMP("r.updated_at")} updated_at,
         ${ISO_TIMESTAMP("r.decided_at")} decided_at, m.display_name decided_by
       from model_reports r left join members m on m.id = r.decided_by
       where r.hotel_id = $1 and (r.status = 'open' or r.decided_at > now() - interval '30 days') order by r.updated_at desc`,
      [hotelId],
    ),
    query<{ id: string; job: ModelJob; pattern: string; from_tier: ModelTier; tier: ModelTier; share: string; starts_at: string; ends_at: string; active: boolean; stop_reason: string | null }>(
      `select id, job, pattern, from_tier, tier, share, ${ISO_TIMESTAMP("starts_at")} starts_at, ${ISO_TIMESTAMP("coalesce(stopped_at, ends_at)")} ends_at,
         stopped_at is null and ends_at > now() active, stop_reason
       from model_trials where hotel_id = $1 and coalesce(stopped_at, ends_at) > now() - interval '30 days' order by created_at desc`,
      [hotelId],
    ),
    queryOne<{ at: string | null }>(`select ${ISO_TIMESTAMP("max(finished_at)")} at from knowledge_review_runs where hotel_id = $1 and status = 'done'`, [hotelId]),
    queryOne<{ n: number }>("select count(*)::int n from work_events where hotel_id = $1 and signals->>'demo' = 'true' limit 1", [hotelId]),
  ]);
  // 試験運用の実測は、開始以降のものだけで見る
  const trialRows: TrialRow[] = [];
  for (const t of trials) {
    const since = await collectJobStats(hotelId, basis, `'${t.starts_at}'::timestamptz`);
    const s = since.find((x) => x.job === t.job && x.pattern === t.pattern);
    const base = stats.find((x) => x.job === t.job && x.pattern === t.pattern);
    trialRows.push({
      limit: base ? jobTargets(base, targets) : targets,
      id: t.id, label: jobLabel(t.job, t.pattern), from: t.from_tier, tier: t.tier, share: Number(t.share), startsAt: t.starts_at, endsAt: t.ends_at,
      active: t.active, stopReason: t.stop_reason, stat: s?.byTier[t.tier] ?? null, volume: stats.find((x) => x.job === t.job && x.pattern === t.pattern)?.volume ?? 0,
    });
  }
  const toRow = (r: (typeof reports)[number]): ReportRow => ({
    id: r.id, job: r.job, pattern: r.pattern, label: jobLabel(r.job, r.pattern), kind: r.kind, from: r.from_tier, to: r.to_tier, reason: r.reason, detail: r.detail,
    status: r.status, updatedAt: r.updated_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
  });
  return {
    targets,
    stats,
    // 切り替えの提案を先に出す
    reports: reports.filter((r) => r.status === "open").sort((a, b) => Number(a.kind === "trial") - Number(b.kind === "trial")).map(toRow),
    decided: reports.filter((r) => r.status !== "open" && r.status !== "withdrawn").map(toRow),
    trials: trialRows,
    lastEvaluatedAt: last?.at ?? null,
    demoData: (demo?.n ?? 0) > 0,
  };
}

export async function countOpenReviews(hotelId: string): Promise<{ reports: number; trials: number }> {
  const row = await queryOne<{ reports: number; trials: number }>(
    `select (select count(*) from model_reports where hotel_id = $1 and status = 'open')::int reports,
       (select count(*) from model_trials where hotel_id = $1 and stopped_at is null and ends_at > now())::int trials`,
    [hotelId],
  );
  return row ?? { reports: 0, trials: 0 };
}
