"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { pct, TIER_NAME, TIER_ROLE, yen } from "@/lib/manage-format";
import type { DashboardData } from "@/server/dashboard";
import { saveTargetsAction } from "./actions";
import { AssumptionsEditor } from "./assumptions-editor";
import { Overview } from "./overview";

// 経営ダッシュボード（docs/000_plan.md 4.3）: 成果 → 取りこぼし → 満足度 → AIの仕事の一覧 → 前提の値
export function Dashboard({ data, canEditAssumptions }: { data: DashboardData; canEditAssumptions: boolean }) {
  const [showAssumptions, setShowAssumptions] = useState(false);
  return (
    <div className="flex flex-1 flex-col gap-4.5">
      <div className="flex flex-wrap items-center justify-end gap-2.5 text-[13px] whitespace-nowrap">
        {data.demoData && <span className="rounded-lg bg-muted px-3 py-1.5 text-ink-sub">デモ用の実績データを含む</span>}
        {data.sampleAssumptions && <span className="rounded-lg bg-caution-soft px-3 py-1.5 text-caution">時給・対応時間はサンプル値（前提の値が未入力）</span>}
        <span className="text-ink-sub">集計期間 過去{data.days}日</span>
        {canEditAssumptions && (
          <button type="button" onClick={() => setShowAssumptions((v) => !v)} className="flex min-h-10 items-center rounded-lg border border-line-input bg-surface px-3.5">
            前提を編集
          </button>
        )}
        <a href="/api/export/work-events?format=csv" className="flex min-h-10 items-center rounded-lg border border-line-input bg-surface px-3.5">
          実績を出力
        </a>
      </div>

      {showAssumptions && <AssumptionsEditor data={data} onClose={() => setShowAssumptions(false)} />}

      <Overview data={data} />
      <Satisfaction data={data} />
      <AiJobs data={data} />
    </div>
  );
}

// 満足度の目標と実績。目標はモデルの見直しの提案と、試験運用の自動中断に使う
function Satisfaction({ data }: { data: DashboardData }) {
  const s = data.satisfaction;
  const [unanswered, setUnanswered] = useState((s.targets.unansweredMax * 100).toString());
  const [aiTalk, setAiTalk] = useState((s.targets.aiTalkMax * 100).toString());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = Number(unanswered) / 100 !== s.targets.unansweredMax || Number(aiTalk) / 100 !== s.targets.aiTalkMax;
  const input = "min-h-10 w-20 rounded-lg border border-line-input px-2.5 text-right text-sm outline-none focus:border-primary";
  const target = (label: string, hint: string, value: string, set: (v: string) => void, actual: number | null, max: number) => (
    <div className="flex flex-col gap-2 rounded-xl bg-canvas px-4 py-3.5">
      <span className="text-sm font-bold">{label}</span>
      <span className="text-xs text-ink-sub">{hint}</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-xs text-ink-sub">実績</span>
          <strong className={`text-2xl ${actual !== null && actual > max ? "text-danger" : ""}`}>{pct(actual)}</strong>
        </span>
        <label className="flex items-center gap-1.5 text-sm">
          目標
          <input inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} className={input} />% 以下
        </label>
      </div>
    </div>
  );
  return (
    <section aria-labelledby="satisfaction-title" className="flex flex-col gap-3.5 rounded-2xl border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="satisfaction-title" className="text-lg font-bold">満足度</h2>
          <span className="text-[13px] text-ink-sub">目標は、モデルの見直しの提案と試験運用の自動中断に使います。</span>
        </div>
        <div className="flex items-center gap-3">
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
          <button
            type="button"
            disabled={!changed || pending}
            onClick={() =>
              startTransition(async () => {
                const r = await saveTargetsAction({ unansweredMax: Number(unanswered) / 100, aiTalkMax: Number(aiTalk) / 100 });
                setMessage(r.ok ? { kind: "ok", text: "目標を保存しました" } : { kind: "error", text: r.error });
              })
            }
            className="min-h-10 rounded-lg bg-primary px-4 text-sm font-bold text-white disabled:opacity-40"
          >
            目標を保存
          </button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {target("答えられなかった率", "AIが答えを保留・情報なしとした割合", unanswered, setUnanswered, s.unansweredRate, s.targets.unansweredMax)}
        {target("AIの応対が原因の「人と話したい」率", "会話ログの定期評価で理由を分類したもの", aiTalk, setAiTalk, s.aiTalkRate, s.targets.aiTalkMax)}
        <div className="flex flex-col gap-2 rounded-xl bg-canvas px-4 py-3.5">
          <span className="text-sm font-bold">「人と話したい」率（全体）</span>
          <span className="text-xs text-ink-sub">最初から人を希望した人も含む</span>
          <strong className="mt-auto text-2xl">{pct(s.wantsStaffRate)}</strong>
        </div>
        <div className="flex flex-col gap-2 rounded-xl bg-canvas px-4 py-3.5">
          <span className="text-sm font-bold">オーダー期限内対応率</span>
          <span className="text-xs text-ink-sub">スタッフの配達の結果</span>
          <strong className="mt-auto text-2xl">{pct(s.orderOnTimeRate)}</strong>
        </div>
      </div>
    </section>
  );
}

// AIの仕事の一覧（読むだけ）。モデルの見直しは /manage/models
function AiJobs({ data }: { data: DashboardData }) {
  const { reports, trials } = data.reviews;
  return (
    <section aria-labelledby="jobs-title" className="flex flex-col gap-3.5 rounded-2xl border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="jobs-title" className="text-lg font-bold">AIの仕事</h2>
          <span className="text-[13px] text-ink-sub">
            仕事ごとに NVIDIA Nemotron のモデルを使い分けています（Lightning＝速く安い、Super＝標準、Ultra＝高精度）。ゲストへの回答とAI相談は、毎日の定期評価で見直します。
          </span>
        </div>
        <Link href="/manage/models" className="flex min-h-11 items-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-bold text-white">
          モデルの見直し
          {(reports > 0 || trials > 0) && (
            <span className="rounded-md bg-white/20 px-1.5 py-0.5 text-xs">
              {[reports > 0 && `提案 ${reports}件`, trials > 0 && `試験運用中 ${trials}件`].filter(Boolean).join("・")}
            </span>
          )}
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {data.models.map((m) => (
          <span key={m.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
            <span className="text-ink-sub">{m.label.replace("ゲストへの回答：", "回答：")}</span>
            <strong>{TIER_NAME[m.tier]}</strong>
            <span className="text-xs text-ink-sub">{m.fixed ? "固定" : TIER_ROLE[m.tier]}</span>
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs text-ink-sub">
            <tr className="border-b border-line">
              <th className="py-2 font-normal">仕事</th>
              <th className="py-2 font-normal">モデル</th>
              <th className="py-2 pl-4 text-right font-normal whitespace-nowrap">回数／月</th>
              <th className="py-2 pl-4 text-right font-normal whitespace-nowrap">月額</th>
              <th className="py-2 pl-4 text-right font-normal whitespace-nowrap">平均の応答</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => (
              <tr key={job.key} className="border-b border-line align-top">
                <td className="py-2.5 pr-3">
                  <span className="block text-xs text-ink-sub">{job.group}</span>
                  {job.label}
                </td>
                <td className="py-2.5 pr-3">
                  <span className="block">{job.models.join("・") || "—"}</span>
                  <span className="text-xs text-ink-sub">{job.reviewed ? "定期評価で見直す（試験運用中は一部が別のモデル）" : `固定：${job.fixedReason}`}</span>
                </td>
                <td className="py-2.5 pl-4 text-right whitespace-nowrap">{yen(job.monthlyCalls)}</td>
                <td className="py-2.5 pl-4 text-right whitespace-nowrap">{yen(job.monthlyJpy)}円</td>
                <td className="py-2.5 pl-4 text-right whitespace-nowrap">{job.avgMs === null ? "—" : `${(job.avgMs / 1000).toFixed(1)}秒`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
