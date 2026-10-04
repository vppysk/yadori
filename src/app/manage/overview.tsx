"use client";

import Link from "next/link";
import { TALK_CAUSES, TALK_GROUPS } from "@/lib/talk-causes";
import type { DashboardData } from "@/server/dashboard";
import { jpy, pct, yen } from "@/lib/manage-format";
import { isEn, LIST_SEP, tr } from "@/lib/i18n";

const MODEL_COLORS = ["bg-primary", "bg-[#7FB5AF]", "bg-weight-mid-ink", "bg-[#B3CBE2]", "bg-[#D9CFBF]"];

// 今月の成果・取りこぼし（docs/000_plan.md 4.3）
export function Overview({ data }: { data: DashboardData }) {
  const { results, misses } = data;
  const hours = results.savedMinutes / 60;
  const net = results.savedJpy - results.aiCostJpy;
  return (
    <>
      <section aria-labelledby="results-title" className="flex flex-col gap-3.5 rounded-2xl border border-line bg-surface px-6 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="results-title" className="text-lg font-bold">{tr("今月の成果", "This month's results")}</h2>
          <span className="text-xs text-ink-sub">{tr(`過去${data.days}日の実績を月あたりに換算`, `Last ${data.days} days, scaled to a month`)}</span>
        </div>
        <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
          <Tile
            label={tr("AIで完結した件数", "Resolved by AI")}
            value={yen(results.aiResolved)}
            unit={tr("件", "requests")}
            note={tr(
              `問い合わせ ${yen(results.volume)} 件のうち ${pct(results.volume ? results.aiResolved / results.volume : null)}`,
              `${pct(results.volume ? results.aiResolved / results.volume : null)} of ${yen(results.volume)} requests`,
            )}
          />
          <Tile label={tr("浮いた人の対応時間", "Staff hours saved")} value={hours.toFixed(0)} unit={tr("時間", "hours")} note={tr(`人件費にして ${yen(results.savedJpy)} 円`, `Worth ${jpy(results.savedJpy)} in labor`)} />
          <Tile
            label={tr("AIの実費（推論）", "AI cost (inference)")}
            value={isEn ? jpy(results.aiCostJpy) : yen(results.aiCostJpy)}
            unit={tr("円", "")}
            note={tr("ゲスト対応・AI相談・資料の読み取りなどの合計", "Guest chat, staff AI, document reading, etc.")}
          />
          <Tile label={tr("差し引きの効果", "Net benefit")} value={isEn ? jpy(net) : yen(net)} unit={tr("円", "")} note={tr("浮いた人件費 − AIの実費", "Labor saved − AI cost")} strong />
        </div>
        <CostByModel data={data} />
      </section>

      <section aria-labelledby="misses-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="misses-title" className="text-lg font-bold">{tr("取りこぼし", "What the AI missed")}</h2>
          <Link href="/admin/handoffs" className="text-sm text-primary underline underline-offset-2">{tr("対応アラートを開く", "Open alerts")}</Link>
        </div>
        <p className="text-[13px] text-ink-sub">{tr("AIで完結せず、人が対応した件数（月あたり）と、その対応にかかった時間です。", "Requests the AI couldn't finish and staff handled (per month), and the staff time they took.")}</p>
        <ul className="flex flex-col gap-2">
          {misses.reasons.map((r) => (
            <li key={r.key} className="flex flex-col gap-1">
              <div className="flex justify-between gap-3 text-sm">
                <span>{r.label}</span>
                <span className="whitespace-nowrap text-ink-sub">
                  <strong className="text-ink">{yen(r.n)}</strong> {tr(`件・約${(r.minutes / 60).toFixed(0)}時間`, `· about ${(r.minutes / 60).toFixed(0)} h`)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full rounded bg-caution" style={{ width: `${(r.n / Math.max(...misses.reasons.map((x) => x.n), 1)) * 100}%` }} />
              </div>
              {r.key === "talk" && misses.talkCauses.length > 0 && <TalkCauses data={data} />}
            </li>
          ))}
          {misses.reasons.length === 0 && <li className="text-sm text-ink-sub">{tr("まだ実績がありません", "No data yet")}</li>}
        </ul>
        <div className="mt-1 flex flex-col gap-2 rounded-xl bg-canvas px-4 py-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold">{tr("AIが答えられなかった質問（多い順）", "Questions the AI couldn't answer (most asked first)")}</h3>
            <Link href="/admin/knowledge/questions" className="text-sm text-primary underline underline-offset-2">
              {tr(`未回答の質問 ${misses.openGaps}件に答える`, `Answer ${misses.openGaps} open questions`)}
            </Link>
          </div>
          {misses.unansweredMinutes > 0 && (
            <p className="text-[13px]">
              {tr("答えを登録すると、月に", "Answering them should save about ")}
              <strong>{tr(`約${(misses.unansweredMinutes / 60).toFixed(0)}時間`, `${(misses.unansweredMinutes / 60).toFixed(0)} staff hours`)}</strong>
              {tr("の人の対応が減る見込みです。", " a month.")}
            </p>
          )}
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            {misses.gaps.map((g) => (
              <li key={g.question}>
                {g.question}
                <span className="ml-1.5 text-xs text-ink-sub">{tr(`${g.askCount}回`, `${g.askCount}×`)}</span>
              </li>
            ))}
          </ol>
          {misses.gaps.length === 0 && <p className="text-sm text-ink-sub">{tr("未回答の質問はありません", "No unanswered questions")}</p>}
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, unit, note, strong }: { label: string; value: string; unit: string; note: string; strong?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 rounded-[14px] px-5 py-4 ${strong ? "bg-primary text-white" : "bg-canvas"}`}>
      <span className={`text-[13px] ${strong ? "text-primary-soft" : "text-ink-sub"}`}>{label}</span>
      <span className="text-[28px] leading-tight font-bold">
        {value}
        <span className={`text-sm font-normal ${strong ? "text-primary-soft" : "text-ink-sub"}`}> {unit}</span>
      </span>
      <span className={`text-xs ${strong ? "text-primary-soft" : "text-ink-sub"}`}>{note}</span>
    </div>
  );
}

// AIの実費のモデル別の内訳（Nemotronの使い分け）
function CostByModel({ data }: { data: DashboardData }) {
  const total = data.results.aiCostJpy;
  if (total <= 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-ink-sub">{tr("AIの実費のモデル別の内訳", "AI cost by model")}</span>
      <div className="flex h-3 overflow-hidden rounded bg-muted">
        {data.results.costByModel.map((m, i) => (
          <div key={m.model} className={MODEL_COLORS[i % MODEL_COLORS.length]} style={{ width: `${(m.jpy / total) * 100}%` }} title={m.model} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {data.results.costByModel.map((m, i) => (
          <li key={m.model} className="flex items-center gap-1.5">
            <span className={`inline-block size-2.5 rounded-sm ${MODEL_COLORS[i % MODEL_COLORS.length]}`} />
            {m.model} {jpy(m.jpy)} ({pct(m.jpy / total, 0)})
          </li>
        ))}
      </ul>
    </div>
  );
}

// 「人と話したい」の理由（会話ログの定期評価で分類したもの）。AIの応対が原因のものは改善できる
function TalkCauses({ data }: { data: DashboardData }) {
  const causes = data.misses.talkCauses;
  return (
    <div className="mt-1 flex flex-col gap-2 border-l-2 border-line pl-3">
      {(Object.keys(TALK_GROUPS) as (keyof typeof TALK_GROUPS)[]).map((group) => {
        const items = causes.filter((c) => TALK_CAUSES[c.cause].group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-0.5 text-[13px]">
            <div className="flex justify-between gap-3">
              <span className={group === "ai" ? "font-bold text-caution" : ""}>{TALK_GROUPS[group].label}</span>
              <span className="whitespace-nowrap">{yen(items.reduce((a, c) => a + c.n, 0))} {tr("件", "")}</span>
            </div>
            <span className="text-xs text-ink-sub">
              {items.map((c) => `${TALK_CAUSES[c.cause].label} ${yen(c.n)}`).join(LIST_SEP)}
              {tr("。", ". ")}
              {TALK_GROUPS[group].hint}
            </span>
          </div>
        );
      })}
    </div>
  );
}
