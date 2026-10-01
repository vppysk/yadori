"use client";

import { useState, useTransition } from "react";
import type { Pattern } from "@/server/hotel";
import type { Assumptions, DashboardData } from "@/server/dashboard";
import { saveAssumptionsAction } from "./actions";

const toNum = (v: string) => (v.trim() === "" ? null : Number(v));

// 前提の値（人が対応した場合のコストの計算に使う）。デモの数値は本人が入力する
export function AssumptionsEditor({ data, onClose }: { data: DashboardData; onClose: () => void }) {
  const a = data.assumptions;
  const [wage, setWage] = useState(a.wageJpy?.toString() ?? "");
  const [night, setNight] = useState((a.nightPremiumRate * 100).toString());
  const [minutes, setMinutes] = useState<Record<Pattern, string>>(
    Object.fromEntries(data.patterns.map((p) => [p.key, a.minutes[p.key]?.toString() ?? ""])) as Record<Pattern, string>,
  );
  const [fx, setFx] = useState(a.fxUsdJpy.toString());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // 3つの区分の境界を線と余白で分ける（狭い画面では上下に並べて上の線で分ける）
  const column = "flex flex-col gap-2.5 border-t border-line pt-6 first:border-t-0 first:pt-0 md:border-t-0 md:px-8 md:pt-0 md:first:pl-0 md:last:pr-0";
  const input = "min-h-10 w-24 rounded-lg border border-line-input px-2.5 text-right text-sm outline-none focus:border-primary";

  function save() {
    startTransition(async () => {
      const next: Assumptions = {
        wageJpy: toNum(wage),
        nightPremiumRate: Number(night) / 100,
        minutes: Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, toNum(v)])) as Record<Pattern, number | null>,
        fxUsdJpy: Number(fx),
      };
      const result = await saveAssumptionsAction(next);
      setMessage(result.ok ? { kind: "ok", text: "保存しました。成果と見積もりに反映しています。" } : { kind: "error", text: result.error });
    });
  }

  return (
    <section aria-labelledby="assumptions-title" className="flex flex-col gap-6 rounded-2xl border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="assumptions-title" className="text-lg font-bold">前提の値</h2>
          <span className="text-[13px] text-ink-sub">人が対応した場合のコスト（時給 × 対応時間。22〜5時は深夜割増を上乗せ）の計算に使います。未入力の項目は仮の値（薄い文字）で計算します。</span>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
          <button type="button" onClick={onClose} className="min-h-11 rounded-[10px] border border-line-input px-4 text-sm">
            閉じる
          </button>
          <button type="button" disabled={pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            保存
          </button>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line">
        <div className={column}>
          <h3 className="text-sm font-bold">時給と深夜割増</h3>
          <label className="flex items-center justify-between gap-3 text-sm">
            時給（ホテル全体）
            <span className="flex items-center gap-1.5">
              <input inputMode="numeric" value={wage} placeholder={a.wageJpy === null ? `仮 ${data.wageJpy}` : ""} onChange={(e) => setWage(e.target.value)} className={input} />円
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            深夜割増（22〜5時）
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={night} onChange={(e) => setNight(e.target.value)} className={input} />%
            </span>
          </label>
          <p className="text-xs text-ink-sub">法定の深夜割増は25%以上（労働基準法37条4項）。時間帯のうち22〜5時にかかる分だけ上乗せします。</p>
        </div>
        <div className={column}>
          <h3 className="text-sm font-bold">人が対応した場合の1件の時間</h3>
          {data.patterns.map((p) => (
            <label key={p.key} className="flex items-center justify-between gap-3 text-sm">
              {p.label}
              <span className="flex items-center gap-1.5">
                <input inputMode="decimal" value={minutes[p.key]} placeholder={a.minutes[p.key] === null ? `仮 ${p.minutes}` : ""} onChange={(e) => setMinutes((m) => ({ ...m, [p.key]: e.target.value }))} className={input} />分
              </span>
            </label>
          ))}
        </div>
        <div className={column}>
          <h3 className="text-sm font-bold">AIの単価</h3>
          <label className="flex items-center justify-between gap-3 text-sm">
            為替（1ドル）
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} className={input} />円
            </span>
          </label>
          <p className="text-xs text-ink-sub">モデルの単価は Nebius Token Factory の料金表（ドル建て）を使います。</p>
        </div>
      </div>
    </section>
  );
}
