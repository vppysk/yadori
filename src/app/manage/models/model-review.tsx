"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ModelTier } from "@/lib/llm/models";
import { pct, signedJpy, TIER_NAME, TIER_ROLE, yen } from "@/lib/manage-format";
import type { ModelReviewPage, ReportRow, TierStat, TrialRow } from "@/server/model-review";
import { approveReportAction, dismissReportAction, stopTrialAction } from "../actions";
import { tr } from "@/lib/i18n";

const TIERS: ModelTier[] = ["small", "medium", "large"];
const model = (t: ModelTier) => tr(`${TIER_NAME[t]}（${TIER_ROLE[t]}）`, `${TIER_NAME[t]} (${TIER_ROLE[t]})`);
const dateTime = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
const date = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });

type Message = { kind: "ok" | "error"; text: string } | null;

// モデルの見直し（docs/000_plan.md 4.3）: 定期評価の提案レポート → 承認（全部適用か試験運用）、試験運用の進み具合と中断、最近の判断、しくみ
export function ModelReview({ data, minSamples }: { data: ModelReviewPage; minSamples: number }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, ok: string) => {
    setMessage(null);
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? { kind: "ok", text: ok } : { kind: "error", text: r.error });
    });
  };
  const activeTrials = data.trials.filter((t) => t.active);
  const endedTrials = data.trials.filter((t) => !t.active);

  return (
    <div className="flex flex-col gap-4.5">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <p className="text-ink-sub">
          {tr(
            `毎日の定期評価が、過去30日の実績から見直しを提案します。満足度の目標（答えられなかった ${pct(data.targets.unansweredMax)}以下・AI起因の「人と話したい」${pct(data.targets.aiTalkMax)}以下）を満たす範囲で、スタッフに回る問い合わせと費用が少ないモデルを選びます。`,
            `A daily review proposes changes from the last 30 days of real results. Within the satisfaction targets (unanswered ≤ ${pct(data.targets.unansweredMax)}, AI-caused "talk to staff" ≤ ${pct(data.targets.aiTalkMax)}), it picks the model that sends the fewest requests to staff at the lowest cost.`,
          )}
          <Link href="/manage" className="ml-1 text-primary underline underline-offset-2">
            {tr("目標を変える", "Change targets")}
          </Link>
        </p>
        <span className="flex items-center gap-2 whitespace-nowrap">
          {data.demoData && <span className="rounded-lg bg-muted px-3 py-1.5 text-ink-sub">{tr("デモ用の実績データを含む", "Includes demo data")}</span>}
          <span className="text-ink-sub">{tr("最終の定期評価 ", "Last review ")}{data.lastEvaluatedAt ? dateTime(data.lastEvaluatedAt) : "—"}</span>
        </span>
      </div>
      {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}

      <section aria-labelledby="reports-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5">
        <h2 id="reports-title" className="text-lg font-bold">{tr("提案", "Proposals")}</h2>
        {data.reports.length === 0 && <p className="text-sm text-ink-sub">{tr("いまのモデルが、目標の範囲で最もよい状態です。", "The current models are already the best fit within the targets.")}</p>}
        {data.reports.map((r) => (
          <ReportCard
            key={r.id}
            report={r}
            minSamples={minSamples}
            pending={pending}
            onApprove={(decision) =>
              run(() => approveReportAction(r.id, decision), decision.mode === "apply"
                    ? tr("承認して適用しました。変更履歴に理由を残しています。", "Approved and applied. The reason is recorded in History.")
                    : tr("試験運用を始めました。目標を外れたら自動で中断します。", "Trial started. It stops automatically if it misses the targets."),
              )
            }
            onDismiss={() => run(() => dismissReportAction(r.id), tr("見送りました。", "Dismissed."))}
          />
        ))}
      </section>

      <section aria-labelledby="trials-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5">
        <h2 id="trials-title" className="text-lg font-bold">{tr("試験運用", "Trials")}</h2>
        {data.trials.length === 0 && <p className="text-sm text-ink-sub">{tr("試験運用はありません。", "No trials.")}</p>}
        {activeTrials.map((t) => (
          <TrialCard key={t.id} trial={t} minSamples={minSamples} pending={pending} onStop={() => run(() => stopTrialAction(t.id), tr("試験運用を中断しました。", "Trial stopped."))} />
        ))}
        {endedTrials.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {endedTrials.map((t) => (
              <li key={t.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-canvas px-3.5 py-2">
                <span>
                  {tr(`${t.label}：${TIER_NAME[t.tier]}を${Math.round(t.share * 100)}%で試験運用`, `${t.label}: trial of ${TIER_NAME[t.tier]} on ${Math.round(t.share * 100)}%`)}
                  <span className="ml-2 text-xs text-ink-sub">
                    {date(t.startsAt)}
                    {tr("〜", "–")}
                    {date(t.endsAt)}
                  </span>
                </span>
                <span className={`text-xs ${(t.stopReason?.startsWith("自動中断") || t.stopReason?.startsWith("Auto-stopped")) ? "text-danger" : "text-ink-sub"}`}>{t.stopReason ?? tr("期間が終わりました（結果は定期評価の提案に反映）", "Ended (results feed into the next review)")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.decided.length > 0 && (
        <section aria-labelledby="decided-title" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-5">
          <h2 id="decided-title" className="text-lg font-bold">{tr("最近の判断", "Recent decisions")}</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {data.decided.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 border-t border-line py-2">
                <span>
                  {r.label}
                  {tr("：", ": ")}
                  {TIER_NAME[r.from]} → {TIER_NAME[r.to]}
                </span>
                <span className="text-xs text-ink-sub">
                  {{ applied: tr("全部適用", "Applied"), trialing: tr("試験運用", "Trial"), dismissed: tr("見送り", "Dismissed") }[r.status] ?? r.status} ・ {r.decidedBy ?? "—"} ・{" "}
                  {r.decidedAt ? dateTime(r.decidedAt) : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Mechanism data={data} minSamples={minSamples} />
    </div>
  );
}

function ReportCard({
  report: r, minSamples, pending, onApprove, onDismiss,
}: {
  report: ReportRow;
  minSamples: number;
  pending: boolean;
  onApprove: (d: { mode: "apply" } | { mode: "trial"; share: number; days: number }) => void;
  onDismiss: () => void;
}) {
  const d = r.detail;
  const [mode, setMode] = useState<"apply" | "trial">(r.kind === "switch" ? "apply" : "trial");
  const [share, setShare] = useState("10");
  const [days, setDays] = useState("14");
  const cur = d.current.stat;
  const next = d.candidate.stat;
  const upgrade = TIERS.indexOf(r.to) > TIERS.indexOf(r.from);

  // 試験運用のリスクのシミュレーション
  const s = Number(share) / 100;
  const n = Number(days);
  const valid = s > 0 && s <= 0.5 && n >= 1 && n <= 60;
  const perDay = (d.volume * s) / 30;
  const affected = perDay * n;
  const daysToJudge = perDay > 0 ? minSamples / perDay : Infinity;
  // 悲観的に見た人に回る率の差（実測があるときだけ）
  const worstDiff = d.pessimisticTotalPerMonth !== null && d.humanCaseJpy > 0 && d.volume > 0 ? (d.pessimisticTotalPerMonth - d.aiCostPerMonth) / d.humanCaseJpy / d.volume : null;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-[#BFD8D4] bg-primary-soft px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-primary">{r.kind === "switch" ? tr("切り替えの提案", "Switch proposal") : tr("試験運用の提案", "Trial proposal")}</span>
          <h3 className="text-base font-bold">
            {tr(`${r.label}を、${model(r.from)} から `, `${r.label}: from ${model(r.from)} to `)}
            <span className="text-primary">{model(r.to)}</span>
            {tr(" に", "")}
          </h3>
        </div>
        <span className="text-xs text-ink-sub">{tr(`月 ${yen(d.volume)} 件・更新 ${dateTime(r.updatedAt)}`, `${yen(d.volume)} / month · updated ${dateTime(r.updatedAt)}`)}</span>
      </div>

      <p className="text-sm">{r.reason}</p>

      {next && cur && d.totalPerMonth !== null && d.handoffsPerMonth !== null ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Effect
            label={tr("スタッフに回る問い合わせ", "Requests sent to staff")}
            value={tr(`月 約${yen(Math.abs(d.handoffsPerMonth))}件 ${d.handoffsPerMonth <= 0 ? "減る" : "増える"}`, `~${yen(Math.abs(d.handoffsPerMonth))} ${d.handoffsPerMonth <= 0 ? "fewer" : "more"} / month`)}
            good={d.handoffsPerMonth <= 0}
          />
          <Effect
            label={tr("総額（AI費＋人件費）", "Total (AI + labor)")}
            value={tr(`${signedJpy(d.totalPerMonth)}／月`, `${signedJpy(d.totalPerMonth)} / month`)}
            sub={tr(`AI費 ${signedJpy(d.aiCostPerMonth)}・人件費 ${signedJpy(d.humanCostPerMonth ?? 0)}`, `AI ${signedJpy(d.aiCostPerMonth)} · labor ${signedJpy(d.humanCostPerMonth ?? 0)}`)}
            good={d.totalPerMonth <= 0}
          />
          <Effect label={tr("答えられなかった率", "Unanswered rate")} value={`${pct(cur.unansweredRate)} → ${pct(next.unansweredRate)}`} good={next.unansweredRate <= cur.unansweredRate} />
          <Effect
            label={tr("応答の速さ", "Latency")}
            value={tr(`${(cur.avgMs / 1000).toFixed(1)}秒 → ${(next.avgMs / 1000).toFixed(1)}秒`, `${(cur.avgMs / 1000).toFixed(1)} s → ${(next.avgMs / 1000).toFixed(1)} s`)}
            good={next.avgMs <= cur.avgMs}
          />
        </dl>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Effect label={tr("AI費の見込み", "Expected AI cost")} value={tr(`${signedJpy(d.aiCostPerMonth)}／月`, `${signedJpy(d.aiCostPerMonth)} / month`)} good={d.aiCostPerMonth <= 0} />
          {upgrade && d.breakevenPt !== null && (
            <Effect label={tr("元が取れる条件", "Breaks even if")} value={tr(`人に回る率が ${d.breakevenPt.toFixed(2)}ポイント以上下がる`, `handoffs drop by ${d.breakevenPt.toFixed(2)}+ points`)} />
          )}
          <Effect label={tr("いまの人に回る率", "Current handoff rate")} value={cur ? tr(`${pct(cur.handoffRate)}（実測 ${yen(cur.n)}件）`, `${pct(cur.handoffRate)} (${yen(cur.n)} cases)`) : "—"} />
        </dl>
      )}
      {d.pessimisticTotalPerMonth !== null && (
        <p className="text-xs text-ink-sub">
          {tr(
            `リスク：件数が少ないことによるぶれを悲観的に見ても、総額は ${signedJpy(d.pessimisticTotalPerMonth)}／月。根拠は過去30日の実測（${cur?.n ?? 0}件・${next?.n ?? 0}件）です。`,
            `Risk: even allowing pessimistically for small samples, the total is ${signedJpy(d.pessimisticTotalPerMonth)} / month. Based on the last 30 days (${cur?.n ?? 0} and ${next?.n ?? 0} cases).`,
          )}
        </p>
      )}

      <div className="flex flex-col gap-3 rounded-lg bg-surface px-4 py-3">
        <div role="radiogroup" aria-label={tr("進め方", "How to proceed")} className="flex flex-wrap gap-2">
          {r.kind === "switch" && (
            <Choice checked={mode === "apply"} onClick={() => setMode("apply")} label={tr("全部適用する", "Apply to all")} sub={tr("すべての処理をこのモデルにする", "Use this model for all traffic")} />
          )}
          <Choice checked={mode === "trial"} onClick={() => setMode("trial")} label={tr("試験運用する", "Run a trial")} sub={tr("一部だけで試し、目標を外れたら自動で中断", "Try it on part of the traffic; auto-stops if it misses the targets")} />
        </div>
        {mode === "trial" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                {tr("割合", "Share")}
                <input inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} className="min-h-10 w-16 rounded-lg border border-line-input px-2 text-right" />
                %
              </label>
              <label className="flex items-center gap-1.5">
                {tr("期間", "Duration")}
                <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="min-h-10 w-16 rounded-lg border border-line-input px-2 text-right" />
                {tr("日", "days")}
              </label>
            </div>
            {valid ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
                <li>
                  {tr(`この試験運用で ${model(r.to)} が受ける問い合わせは `, `${model(r.to)} would handle `)}
                  <strong>{tr(`約${yen(affected)}件`, `~${yen(affected)} requests`)}</strong>
                  {tr(`（1日 約${perDay.toFixed(1)}件）`, ` in this trial (~${perDay.toFixed(1)} per day)`)}
                </li>
                <li className={daysToJudge > n ? "text-danger" : ""}>
                  {tr(`判断できる件数（${minSamples}件）に届くのは `, `Enough data to judge (${minSamples} cases) in `)}
                  <strong>{tr(`約${Math.ceil(daysToJudge)}日後`, `~${Math.ceil(daysToJudge)} days`)}</strong>
                  {daysToJudge > n && tr("。この割合・期間では届かないため、割合か期間を増やしてください", ". That's longer than the trial, so increase the share or duration")}
                </li>
                <li>{tr(`目標を外れていた場合も、自動中断の判定までに影響を受けるのは最大 約${minSamples}件です`, `Even if it misses the targets, at most ~${minSamples} requests are affected before it auto-stops`)}</li>
                {worstDiff !== null && worstDiff > 0 && (
                  <li>{tr(`悲観的に見ると、期間中にスタッフに回る問い合わせが最大 約${yen(affected * worstDiff)}件増えます`, `Pessimistically, up to ~${yen(affected * worstDiff)} more requests may go to staff during the trial`)}</li>
                )}
              </ul>
            ) : (
              <p className="text-[13px] text-danger">{tr("割合は1〜50%、期間は1〜60日で決めてください", "Choose a share of 1–50% and a duration of 1–60 days")}</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={pending} onClick={onDismiss} className="min-h-11 rounded-[10px] border border-line-input px-4 text-sm disabled:opacity-40">
            {tr("見送る", "Dismiss")}
          </button>
          <button
            type="button"
            disabled={pending || (mode === "trial" && !valid)}
            onClick={() => onApprove(mode === "apply" ? { mode: "apply" } : { mode: "trial", share: s, days: n })}
            className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40"
          >
            {mode === "apply" ? tr("承認して全部適用", "Approve & apply to all") : tr("承認して試験運用を始める", "Approve & start trial")}
          </button>
        </div>
      </div>
    </article>
  );
}

function Effect({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2">
      <dt className="text-xs text-ink-sub">{label}</dt>
      <dd className={`font-bold ${good === undefined ? "" : good ? "text-primary" : "text-caution"}`}>{value}</dd>
      {sub && <dd className="text-xs text-ink-sub">{sub}</dd>}
    </div>
  );
}

function Choice({ checked, onClick, label, sub }: { checked: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={`flex min-h-11 flex-col items-start rounded-lg border px-3.5 py-2 text-left ${checked ? "border-primary bg-primary-soft" : "border-line-input"}`}
    >
      <span className="text-sm font-bold">{label}</span>
      <span className="text-xs text-ink-sub">{sub}</span>
    </button>
  );
}

function TrialCard({ trial: t, minSamples, pending, onStop }: { trial: TrialRow; minSamples: number; pending: boolean; onStop: () => void }) {
  const stat = t.stat;
  const progress = Math.min((stat?.n ?? 0) / minSamples, 1);
  const off = (v: number, max: number) => (v > max ? "text-danger font-bold" : "");
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border border-line px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-base font-bold">
            {tr(`${t.label}：${model(t.tier)} を ${Math.round(t.share * 100)}% で試験運用中`, `${t.label}: trialing ${model(t.tier)} on ${Math.round(t.share * 100)}%`)}
          </h3>
          <span className="text-xs text-ink-sub">
            {tr(`${date(t.startsAt)}〜${date(t.endsAt)}・いまは ${model(t.from)}`, `${date(t.startsAt)}–${date(t.endsAt)} · currently ${model(t.from)}`)}
          </span>
        </div>
        <button type="button" disabled={pending} onClick={onStop} className="min-h-10 rounded-lg border border-line-input px-3.5 text-sm disabled:opacity-40">
          {tr("中断する", "Stop")}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-ink-sub">
          <span>{tr("判断に必要な件数", "Cases needed to judge")}</span>
          <span>
            {stat?.n ?? 0} / {minSamples}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full rounded bg-primary" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      {stat && (
        <p className="text-sm">
          {tr("ここまでの実績：", "So far: ")}
          {t.limit.aiTalkMax < 1 && tr(`人に回る ${pct(stat.handoffRate)}・`, `handoffs ${pct(stat.handoffRate)} · `)}
          <span className={off(stat.unansweredRate, t.limit.unansweredMax)}>
            {tr(`答えられなかった ${pct(stat.unansweredRate)}（基準 ${pct(t.limit.unansweredMax)}以下）`, `unanswered ${pct(stat.unansweredRate)} (limit ≤ ${pct(t.limit.unansweredMax)})`)}
          </span>
          {t.limit.aiTalkMax < 1 && (
            <>
              {tr("・", " · ")}
              <span className={off(stat.aiTalkRate, t.limit.aiTalkMax)}>
                {tr(`AI起因の会話希望 ${pct(stat.aiTalkRate)}（基準 ${pct(t.limit.aiTalkMax)}以下）`, `AI-caused staff requests ${pct(stat.aiTalkRate)} (limit ≤ ${pct(t.limit.aiTalkMax)})`)}
              </span>
            </>
          )}
        </p>
      )}
      <p className="text-xs text-ink-sub">
        {tr(
          `${minSamples}件たまってから、満足度の目標を外れたら自動で中断します（答えられなかった率は1分ごと、「人と話したい」の理由は毎日の分類後に判定）。`,
          `After ${minSamples} cases, it auto-stops if it misses the satisfaction targets (unanswered rate checked every minute; "talk to staff" reasons after the daily classification).`,
        )}
      </p>
    </article>
  );
}

// しくみ（透明性のため）: 仕事ごと・モデルごとの実測と、提案の決め方
function Mechanism({ data, minSamples }: { data: ModelReviewPage; minSamples: number }) {
  const cell = (s: TierStat | undefined) =>
    s ? (
      <>
        <span className="block">{tr(`人に回る ${pct(s.handoffRate)}`, `Handoffs ${pct(s.handoffRate)}`)}</span>
        <span className="block text-xs text-ink-sub">
          {tr(
            `答えられない ${pct(s.unansweredRate)}・AI起因 ${pct(s.aiTalkRate)}・${(s.avgMs / 1000).toFixed(1)}秒・${s.costJpy.toFixed(2)}円`,
            `Unanswered ${pct(s.unansweredRate)} · AI-caused ${pct(s.aiTalkRate)} · ${(s.avgMs / 1000).toFixed(1)} s · ¥${s.costJpy.toFixed(2)}`,
          )}
        </span>
        <span className={`text-xs ${s.n < minSamples ? "text-caution" : "text-ink-sub"}`}>
          {tr(`実測 ${yen(s.n)}件`, `${yen(s.n)} cases`)}
          {s.n < minSamples ? tr("（件数不足）", " (too few)") : ""}
        </span>
      </>
    ) : (
      <span className="text-xs text-ink-sub">{tr("未計測", "Not measured")}</span>
    );
  return (
    <details className="rounded-2xl border border-line bg-surface px-6 py-4">
      <summary className="flex min-h-10 cursor-pointer items-center text-base font-bold">{tr("しくみを見る（仕事ごと・モデルごとの実測と、提案の決め方）", "How it works (measured results per job and model, and how proposals are made)")}</summary>
      <div className="mt-3 flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>{tr("総額 ＝ AI費 ＋ スタッフに回る件数 × 人が対応した場合の1件のコスト（時給 × 対応時間 × 深夜割増）", "Total = AI cost + requests sent to staff × staff cost per case (hourly wage × handling time × night premium)")}</li>
          <li>{tr("満足度の目標を満たすモデルだけを候補にし、いまのモデルと隣り合う段階（Lightning↔Super↔Ultra）で比べる", "Only models that meet the satisfaction targets are candidates, compared one step up or down (Lightning ↔ Super ↔ Ultra)")}</li>
          <li>{tr(`実測が${minSamples}件に満たないうちは切り替えを提案せず、試験運用を提案する。件数が少ないことによるぶれは悲観的に見て判断する（片側95%）`, `Below ${minSamples} measured cases, it proposes a trial instead of a switch. Small-sample noise is judged pessimistically (one-sided 95%)`)}</li>
          <li>{tr("クレームの一次対応（Ultra）、発言の振り分け（Lightning）、回答後のチェックなどは固定で、見直しの対象外", "Complaint first response (Ultra), message routing (Lightning) and reply checks are fixed and not reviewed")}</li>
        </ol>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-ink-sub">
              <tr className="border-b border-line">
                <th className="py-2 font-normal">{tr("仕事", "Job")}</th>
                <th className="py-2 font-normal">{tr("月の件数", "Per month")}</th>
                {TIERS.map((t) => (
                  <th key={t} className="py-2 font-normal">
                    {model(t)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.stats.map((s) => (
                <tr key={s.key} className="border-b border-line align-top">
                  <td className="py-2.5 pr-3">{s.label}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">{yen(s.volume)}</td>
                  {TIERS.map((t) => (
                    <td key={t} className={`py-2.5 pr-3 ${t === s.current ? "bg-primary-soft" : ""}`}>
                      {t === s.current && <span className="mb-0.5 block text-[11px] font-bold text-primary">{tr("いまのモデル", "Current")}</span>}
                      {cell(s.byTier[t])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
