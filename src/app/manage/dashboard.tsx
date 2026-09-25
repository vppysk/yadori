"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import type { DashboardData, Handler } from "@/server/dashboard";
import { applyAssignmentsAction } from "./actions";

const CYCLE: Handler[] = ["human", "small", "medium", "large"];
const HANDLER_LABEL: Record<Handler, { name: string; sub: string; className: string }> = {
  human: { name: "人", sub: "スタッフが直接対応", className: "bg-caution-soft text-[#7A4708] border-[#E6C99E]" },
  small: { name: "Lightning", sub: "軽量・高速", className: "bg-primary-soft text-primary border-[#BFD8D4]" },
  medium: { name: "Super", sub: "中型", className: "bg-weight-mid text-weight-mid-ink border-[#B3CBE2]" },
  large: { name: "Ultra", sub: "高度な推論", className: "bg-weight-mid-ink text-white border-weight-mid-ink" },
};

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}`);

// 簡易見積もり（plan 4.3）: 過去の件数 × 新しい担当の単価と引き継ぎ率。引き継いだ分と人が直接受けた分は、時給×対応時間で人のコストに入れる
function estimate(data: DashboardData, plan: Record<string, Handler>) {
  const month = 30 / data.days;
  let ai = 0;
  let human = 0;
  let handoffs = 0;
  let volume = 0;
  let allHuman = 0;
  for (const p of data.patterns) {
    data.bands.forEach((band, i) => {
      const v = p.volumes[i] * month;
      const humanCase = (data.wageJpy / 60) * p.minutes * band.wageMultiplier;
      volume += v;
      allHuman += v * humanCase;
      const handler = plan[`${p.key}:${band.id}`] ?? "human";
      if (handler === "human") {
        human += v * humanCase;
        handoffs += v;
        return;
      }
      const tier = data.tiers[handler];
      const aiCase = ((p.tokens.input * tier.inputUsdPerMtok + p.tokens.output * tier.outputUsdPerMtok) / 1_000_000) * data.fxUsdJpy;
      // クレームは一次対応のあと必ず人へ引き継ぐ
      const h = p.key === "complaint" ? 1 : tier.handoffRate;
      ai += v * aiCase;
      human += v * h * humanCase;
      handoffs += v * h;
    });
  }
  return { ai, human, total: ai + human, handoffs, volume, allHuman };
}

export function Dashboard({ data }: { data: DashboardData }) {
  const [plan, setPlan] = useState<Record<string, Handler>>(data.assignments);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const before = useMemo(() => estimate(data, data.assignments), [data]);
  const after = useMemo(() => estimate(data, plan), [data, plan]);
  const changed = Object.keys(plan).some((k) => plan[k] !== data.assignments[k]);
  const diff = after.total - before.total;
  const maxBar = Math.max(after.ai, after.human, 1);

  function cycle(key: string) {
    setMessage(null);
    setPlan((prev) => ({ ...prev, [key]: CYCLE[(CYCLE.indexOf(prev[key] ?? "human") + 1) % CYCLE.length] }));
  }

  return (
    <div className="flex flex-1 flex-col gap-4.5">
      <div className="flex flex-wrap items-center justify-end gap-2.5 text-[13px] whitespace-nowrap">
        {data.kpi.demoData && <span className="rounded-lg bg-muted px-3 py-1.5 text-ink-sub">デモ用の実績データを含む</span>}
        {data.sampleMasters && <span className="rounded-lg bg-caution-soft px-3 py-1.5 text-caution">時給・対応時間はサンプル値（マスタ未入力）</span>}
        <span className="text-ink-sub">集計期間 過去{data.days}日</span>
        <Link href="/manage/masters" className="flex min-h-10 items-center rounded-lg border border-line-input bg-surface px-3.5">
          マスタ設定
        </Link>
        <a href="/api/export/work-events?format=csv" className="flex min-h-10 items-center rounded-lg border border-line-input bg-surface px-3.5">
          実績を出力
        </a>
      </div>

      <section aria-label="主要指標" className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Kpi label="問い合わせ件数（30日）" value={yen(data.kpi.volume)} unit="件" />
        <Kpi label="AIで完結した割合" value={pct(data.kpi.aiResolvedRate)} unit="%" />
        <Kpi
          label="1件あたりの解決コスト（見積もり）"
          value={yen(before.volume ? before.total / before.volume : 0)}
          unit="円"
          note={`すべて人が対応した場合 ${yen(before.volume ? before.allHuman / before.volume : 0)} 円`}
        />
        <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <span className="text-[13px] text-ink-sub">満足度の代理指標</span>
          <div className="flex flex-col gap-1 text-[13px]">
            <div className="flex justify-between">
              <span>「人と話したい」率</span>
              <strong>{pct(data.kpi.wantsStaffRate)}%</strong>
            </div>
            <div className="flex justify-between">
              <span>オーダー期限内対応</span>
              <strong>{pct(data.kpi.orderOnTimeRate)}%</strong>
            </div>
          </div>
        </div>
      </section>

      <div className="flex min-h-0 flex-1 flex-col gap-5 xl:flex-row">
        <section aria-label="AIの担当範囲" className="flex flex-1 flex-col gap-3.5 rounded-2xl border border-line bg-surface px-6 py-5.5">
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-bold">AIの担当範囲</h2>
              <span className="text-[13px] text-ink-sub">セルを押すと担当が切り替わります（人 → Lightning → Super → Ultra）</span>
            </div>
            <button
              type="button"
              disabled={!changed}
              onClick={() => setPlan(data.assignments)}
              className="min-h-10 shrink-0 rounded-lg border border-line-input bg-surface px-3.5 text-sm whitespace-nowrap disabled:opacity-40"
            >
              現在の設定に戻す
            </button>
          </div>
          <div className="grid grid-cols-[170px_repeat(3,minmax(0,1fr))] gap-2.5 text-xs text-ink-sub">
            <span />
            {data.bands.map((b) => (
              <span key={b.id} className="text-center">
                {b.name} {b.range}
              </span>
            ))}
          </div>
          {data.patterns.map((p) => {
            const locked = p.key === "complaint";
            return (
              <div key={p.key} className="grid grid-cols-[170px_repeat(3,minmax(0,1fr))] gap-2.5">
                <div className="flex flex-col justify-center gap-0.5">
                  <span className="text-[15px] font-bold">{p.label}</span>
                  <span className="text-xs text-ink-sub">{yen(p.volumes.reduce((a, b) => a + b, 0) * (30 / data.days))} 件／月</span>
                </div>
                {data.bands.map((b) => {
                  const key = `${p.key}:${b.id}`;
                  const handler = plan[key] ?? "human";
                  const label = HANDLER_LABEL[handler];
                  const modified = handler !== data.assignments[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={locked}
                      onClick={() => cycle(key)}
                      aria-label={`${p.label} ${b.name} の担当: ${label.name}`}
                      className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[10px] border ${label.className} ${modified ? "ring-2 ring-[#D98A2B]" : ""} ${locked ? "cursor-default opacity-90" : ""}`}
                    >
                      <span className="text-[15px] font-bold">{locked ? `${label.name}＋人` : label.name}</span>
                      <span className="text-[11px] opacity-85">{locked ? "固定" : modified ? "変更あり" : label.sub}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div className="mt-auto flex flex-wrap gap-4 text-xs text-ink-sub">
            <span>
              引き継ぎ率 Lightning {pct(data.tiers.small.handoffRate)}% ・ Super {pct(data.tiers.medium.handoffRate)}% ・ Ultra {pct(data.tiers.large.handoffRate)}%
              {Object.values(data.tiers).some((t) => !t.measured) ? "（実績が少ないモデルは想定値）" : "（過去の実績）"}
            </span>
            <span>クレームは Ultra で一次対応し、必ず人へ引き継ぐ（固定）</span>
          </div>
        </section>

        <section aria-label="コスト見積もり" className="flex w-full shrink-0 flex-col gap-4.5 rounded-2xl bg-dark px-6 py-5.5 text-canvas xl:w-[420px]">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold">変更後の見積もり（月額）</h2>
            <span className="text-xs text-[#AEB6B9]">簡易見積もり：過去{data.days}日の件数 × 新しい単価と引き継ぎ率</span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-4xl font-bold">{yen(after.total)}</span>
            <span className="text-sm text-[#AEB6B9]">円</span>
          </div>
          <div className={`text-sm font-bold ${!changed ? "text-[#AEB6B9]" : diff > 0 ? "text-[#F2A99F]" : "text-[#9FD8C9]"}`}>
            {!changed ? "現在の設定" : `現在より ${diff > 0 ? "+" : "−"}${yen(Math.abs(diff))} 円／月`}
          </div>
          <div className="flex flex-col gap-3">
            <Bar label="AIの推論費" value={after.ai} max={maxBar} color="bg-[#7FB5AF]" />
            <Bar label="人の対応コスト（直接・引き継ぎ）" value={after.human} max={maxBar} color="bg-[#E6C99E]" />
            <div className="flex justify-between text-[13px] text-[#C9CFD1]">
              <span>人への引き継ぎ（予測）</span>
              <span>{yen(after.handoffs)} 件</span>
            </div>
            <div className="flex justify-between text-[13px] text-[#C9CFD1]">
              <span>現在の設定</span>
              <span>{yen(before.total)} 円</span>
            </div>
          </div>
          <div className="flex-1" />
          <p className="rounded-[10px] bg-dark-2 px-3.5 py-3 text-xs leading-relaxed text-[#C9CFD1]">
            精密見積もりでは、過去ログの一部を新しいモデルで再生し、回答品質と引き継ぎ率を実測してから総額を出します。
          </p>
          {message && <p className={`text-sm ${message.kind === "ok" ? "text-[#9FD8C9]" : "text-[#F2A99F]"}`}>{message.text}</p>}
          <button
            type="button"
            disabled={!changed || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await applyAssignmentsAction(plan);
                setMessage(result.ok ? { kind: "ok", text: "適用しました。変更履歴に記録しています。" } : { kind: "error", text: result.error });
              })
            }
            className="min-h-12 rounded-[10px] bg-canvas text-[15px] font-bold text-ink disabled:opacity-40"
          >
            この設定を適用
          </button>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, unit, note }: { label: string; value: string; unit: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <span className="text-[13px] text-ink-sub">{label}</span>
      <span className="text-[30px] font-bold">
        {value}
        <span className="text-sm font-normal text-ink-sub"> {unit}</span>
      </span>
      {note && <span className="text-xs text-ink-sub">{note}</span>}
    </div>
  );
}

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span>{yen(value)} 円</span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-dark-2">
        <div className={`h-full rounded ${color}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}
