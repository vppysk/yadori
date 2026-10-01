"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ModelTier } from "@/lib/llm/models";
import { pct, signedYen, TIER_NAME, TIER_ROLE, yen } from "@/lib/manage-format";
import type { ModelReviewPage, ReportRow, TierStat, TrialRow } from "@/server/model-review";
import { approveReportAction, dismissReportAction, stopTrialAction } from "../actions";

const TIERS: ModelTier[] = ["small", "medium", "large"];
const model = (t: ModelTier) => `${TIER_NAME[t]}（${TIER_ROLE[t]}）`;
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
          毎日の定期評価が、過去30日の実績から見直しを提案します。満足度の目標（答えられなかった {pct(data.targets.unansweredMax)}以下・AI起因の「人と話したい」{pct(data.targets.aiTalkMax)}以下）を満たす範囲で、スタッフに回る問い合わせと費用が少ないモデルを選びます。
          <Link href="/manage" className="ml-1 text-primary underline underline-offset-2">目標を変える</Link>
        </p>
        <span className="flex items-center gap-2 whitespace-nowrap">
          {data.demoData && <span className="rounded-lg bg-muted px-3 py-1.5 text-ink-sub">デモ用の実績データを含む</span>}
          <span className="text-ink-sub">最終の定期評価 {data.lastEvaluatedAt ? dateTime(data.lastEvaluatedAt) : "—"}</span>
        </span>
      </div>
      {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}

      <section aria-labelledby="reports-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5">
        <h2 id="reports-title" className="text-lg font-bold">提案</h2>
        {data.reports.length === 0 && <p className="text-sm text-ink-sub">いまのモデルが、目標の範囲で最もよい状態です。</p>}
        {data.reports.map((r) => (
          <ReportCard
            key={r.id}
            report={r}
            minSamples={minSamples}
            pending={pending}
            onApprove={(decision) =>
              run(() => approveReportAction(r.id, decision), decision.mode === "apply" ? "承認して適用しました。変更履歴に理由を残しています。" : "試験運用を始めました。目標を外れたら自動で中断します。")
            }
            onDismiss={() => run(() => dismissReportAction(r.id), "見送りました。")}
          />
        ))}
      </section>

      <section aria-labelledby="trials-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5">
        <h2 id="trials-title" className="text-lg font-bold">試験運用</h2>
        {data.trials.length === 0 && <p className="text-sm text-ink-sub">試験運用はありません。</p>}
        {activeTrials.map((t) => (
          <TrialCard key={t.id} trial={t} minSamples={minSamples} pending={pending} onStop={() => run(() => stopTrialAction(t.id), "試験運用を中断しました。")} />
        ))}
        {endedTrials.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {endedTrials.map((t) => (
              <li key={t.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-canvas px-3.5 py-2">
                <span>
                  {t.label}：{TIER_NAME[t.tier]}を{Math.round(t.share * 100)}%で試験運用
                  <span className="ml-2 text-xs text-ink-sub">{date(t.startsAt)}〜{date(t.endsAt)}</span>
                </span>
                <span className={`text-xs ${t.stopReason?.startsWith("自動中断") ? "text-danger" : "text-ink-sub"}`}>{t.stopReason ?? "期間が終わりました（結果は定期評価の提案に反映）"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.decided.length > 0 && (
        <section aria-labelledby="decided-title" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-5">
          <h2 id="decided-title" className="text-lg font-bold">最近の判断</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {data.decided.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 border-t border-line py-2">
                <span>
                  {r.label}：{TIER_NAME[r.from]} → {TIER_NAME[r.to]}
                </span>
                <span className="text-xs text-ink-sub">
                  {{ applied: "全部適用", trialing: "試験運用", dismissed: "見送り" }[r.status] ?? r.status}・{r.decidedBy ?? "—"}・{r.decidedAt ? dateTime(r.decidedAt) : ""}
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
          <span className="text-xs font-bold text-primary">{r.kind === "switch" ? "切り替えの提案" : "試験運用の提案"}</span>
          <h3 className="text-base font-bold">
            {r.label}を、{model(r.from)} から <span className="text-primary">{model(r.to)}</span> に
          </h3>
        </div>
        <span className="text-xs text-ink-sub">月 {yen(d.volume)} 件・更新 {dateTime(r.updatedAt)}</span>
      </div>

      <p className="text-sm">{r.reason}</p>

      {next && cur && d.totalPerMonth !== null && d.handoffsPerMonth !== null ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Effect label="スタッフに回る問い合わせ" value={`月 約${yen(Math.abs(d.handoffsPerMonth))}件 ${d.handoffsPerMonth <= 0 ? "減る" : "増える"}`} good={d.handoffsPerMonth <= 0} />
          <Effect label="総額（AI費＋人件費）" value={`${signedYen(d.totalPerMonth)}円／月`} sub={`AI費 ${signedYen(d.aiCostPerMonth)}円・人件費 ${signedYen(d.humanCostPerMonth ?? 0)}円`} good={d.totalPerMonth <= 0} />
          <Effect label="答えられなかった率" value={`${pct(cur.unansweredRate)} → ${pct(next.unansweredRate)}`} good={next.unansweredRate <= cur.unansweredRate} />
          <Effect label="応答の速さ" value={`${(cur.avgMs / 1000).toFixed(1)}秒 → ${(next.avgMs / 1000).toFixed(1)}秒`} good={next.avgMs <= cur.avgMs} />
        </dl>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Effect label="AI費の見込み" value={`${signedYen(d.aiCostPerMonth)}円／月`} good={d.aiCostPerMonth <= 0} />
          {upgrade && d.breakevenPt !== null && <Effect label="元が取れる条件" value={`人に回る率が ${d.breakevenPt.toFixed(2)}ポイント以上下がる`} />}
          <Effect label="いまの人に回る率" value={cur ? `${pct(cur.handoffRate)}（実測 ${yen(cur.n)}件）` : "—"} />
        </dl>
      )}
      {d.pessimisticTotalPerMonth !== null && (
        <p className="text-xs text-ink-sub">
          リスク：件数が少ないことによるぶれを悲観的に見ても、総額は {signedYen(d.pessimisticTotalPerMonth)}円／月。根拠は過去30日の実測（{cur?.n ?? 0}件・{next?.n ?? 0}件）です。
        </p>
      )}

      <div className="flex flex-col gap-3 rounded-lg bg-surface px-4 py-3">
        <div role="radiogroup" aria-label="進め方" className="flex flex-wrap gap-2">
          {r.kind === "switch" && (
            <Choice checked={mode === "apply"} onClick={() => setMode("apply")} label="全部適用する" sub="すべての処理をこのモデルにする" />
          )}
          <Choice checked={mode === "trial"} onClick={() => setMode("trial")} label="試験運用する" sub="一部だけで試し、目標を外れたら自動で中断" />
        </div>
        {mode === "trial" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                割合
                <input inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} className="min-h-10 w-16 rounded-lg border border-line-input px-2 text-right" />%
              </label>
              <label className="flex items-center gap-1.5">
                期間
                <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="min-h-10 w-16 rounded-lg border border-line-input px-2 text-right" />日
              </label>
            </div>
            {valid ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
                <li>
                  この試験運用で {model(r.to)} が受ける問い合わせは <strong>約{yen(affected)}件</strong>（1日 約{perDay.toFixed(1)}件）
                </li>
                <li className={daysToJudge > n ? "text-danger" : ""}>
                  判断できる件数（{minSamples}件）に届くのは <strong>約{Math.ceil(daysToJudge)}日後</strong>
                  {daysToJudge > n && "。この割合・期間では届かないため、割合か期間を増やしてください"}
                </li>
                <li>目標を外れていた場合も、自動中断の判定までに影響を受けるのは最大 約{minSamples}件です</li>
                {worstDiff !== null && worstDiff > 0 && <li>悲観的に見ると、期間中にスタッフに回る問い合わせが最大 約{yen(affected * worstDiff)}件増えます</li>}
              </ul>
            ) : (
              <p className="text-[13px] text-danger">割合は1〜50%、期間は1〜60日で決めてください</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={pending} onClick={onDismiss} className="min-h-11 rounded-[10px] border border-line-input px-4 text-sm disabled:opacity-40">
            見送る
          </button>
          <button
            type="button"
            disabled={pending || (mode === "trial" && !valid)}
            onClick={() => onApprove(mode === "apply" ? { mode: "apply" } : { mode: "trial", share: s, days: n })}
            className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40"
          >
            {mode === "apply" ? "承認して全部適用" : "承認して試験運用を始める"}
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
            {t.label}：{model(t.tier)} を {Math.round(t.share * 100)}% で試験運用中
          </h3>
          <span className="text-xs text-ink-sub">
            {date(t.startsAt)}〜{date(t.endsAt)}・いまは {model(t.from)}
          </span>
        </div>
        <button type="button" disabled={pending} onClick={onStop} className="min-h-10 rounded-lg border border-line-input px-3.5 text-sm disabled:opacity-40">
          中断する
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-ink-sub">
          <span>判断に必要な件数</span>
          <span>
            {stat?.n ?? 0} / {minSamples}件
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full rounded bg-primary" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      {stat && (
        <p className="text-sm">
          ここまでの実績：{t.limit.aiTalkMax < 1 && `人に回る ${pct(stat.handoffRate)}・`}<span className={off(stat.unansweredRate, t.limit.unansweredMax)}>答えられなかった {pct(stat.unansweredRate)}（基準 {pct(t.limit.unansweredMax)}以下）</span>
          {t.limit.aiTalkMax < 1 && (
            <>
              ・<span className={off(stat.aiTalkRate, t.limit.aiTalkMax)}>AI起因の会話希望 {pct(stat.aiTalkRate)}（基準 {pct(t.limit.aiTalkMax)}以下）</span>
            </>
          )}
        </p>
      )}
      <p className="text-xs text-ink-sub">{minSamples}件たまってから、満足度の目標を外れたら自動で中断します（答えられなかった率は1分ごと、「人と話したい」の理由は毎日の分類後に判定）。</p>
    </article>
  );
}

// しくみ（透明性のため）: 仕事ごと・モデルごとの実測と、提案の決め方
function Mechanism({ data, minSamples }: { data: ModelReviewPage; minSamples: number }) {
  const cell = (s: TierStat | undefined) =>
    s ? (
      <>
        <span className="block">人に回る {pct(s.handoffRate)}</span>
        <span className="block text-xs text-ink-sub">
          答えられない {pct(s.unansweredRate)}・AI起因 {pct(s.aiTalkRate)}・{(s.avgMs / 1000).toFixed(1)}秒・{s.costJpy.toFixed(2)}円
        </span>
        <span className={`text-xs ${s.n < minSamples ? "text-caution" : "text-ink-sub"}`}>実測 {yen(s.n)}件{s.n < minSamples ? "（件数不足）" : ""}</span>
      </>
    ) : (
      <span className="text-xs text-ink-sub">未計測</span>
    );
  return (
    <details className="rounded-2xl border border-line bg-surface px-6 py-4">
      <summary className="flex min-h-10 cursor-pointer items-center text-base font-bold">しくみを見る（仕事ごと・モデルごとの実測と、提案の決め方）</summary>
      <div className="mt-3 flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>総額 ＝ AI費 ＋ スタッフに回る件数 × 人が対応した場合の1件のコスト（時給 × 対応時間 × 深夜割増）</li>
          <li>満足度の目標を満たすモデルだけを候補にし、いまのモデルと隣り合う段階（Lightning↔Super↔Ultra）で比べる</li>
          <li>実測が{minSamples}件に満たないうちは切り替えを提案せず、試験運用を提案する。件数が少ないことによるぶれは悲観的に見て判断する（片側95%）</li>
          <li>クレームの一次対応（Ultra）、発言の振り分け（Lightning）、回答後のチェックなどは固定で、見直しの対象外</li>
        </ol>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-ink-sub">
              <tr className="border-b border-line">
                <th className="py-2 font-normal">仕事</th>
                <th className="py-2 font-normal">月の件数</th>
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
                  <td className="py-2.5 pr-3 whitespace-nowrap">{yen(s.volume)}件</td>
                  {TIERS.map((t) => (
                    <td key={t} className={`py-2.5 pr-3 ${t === s.current ? "bg-primary-soft" : ""}`}>
                      {t === s.current && <span className="mb-0.5 block text-[11px] font-bold text-primary">いまのモデル</span>}
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
