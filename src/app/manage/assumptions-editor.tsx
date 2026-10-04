"use client";

import { useState, useTransition } from "react";
import type { Pattern } from "@/server/hotel";
import type { Assumptions, DashboardData } from "@/server/dashboard";
import { saveAssumptionsAction } from "./actions";
import { tr } from "@/lib/i18n";

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
      setMessage(result.ok ? { kind: "ok", text: tr("保存しました。成果と見積もりに反映しています。", "Saved. Results and estimates now use these values.") } : { kind: "error", text: result.error });
    });
  }

  return (
    <section aria-labelledby="assumptions-title" className="flex flex-col gap-6 rounded-2xl border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="assumptions-title" className="text-lg font-bold">{tr("前提の値", "Assumptions")}</h2>
          <span className="text-[13px] text-ink-sub">
            {tr(
              "人が対応した場合のコスト（時給 × 対応時間。22〜5時は深夜割増を上乗せ）の計算に使います。未入力の項目は仮の値（薄い文字）で計算します。",
              "Used to compute the cost of staff handling (hourly wage × handling time, plus a night premium from 22:00 to 5:00). Empty fields use placeholder values (shown in gray).",
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
          <button type="button" onClick={onClose} className="min-h-11 rounded-[10px] border border-line-input px-4 text-sm">
            {tr("閉じる", "Close")}
          </button>
          <button type="button" disabled={pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            {tr("保存", "Save")}
          </button>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line">
        <div className={column}>
          <h3 className="text-sm font-bold">{tr("時給と深夜割増", "Wage and night premium")}</h3>
          <label className="flex items-center justify-between gap-3 text-sm">
            {tr("時給（ホテル全体）", "Hourly wage (hotel-wide)")}
            <span className="flex items-center gap-1.5">
              <input inputMode="numeric" value={wage} placeholder={a.wageJpy === null ? tr(`仮 ${data.wageJpy}`, `e.g. ${data.wageJpy}`) : ""} onChange={(e) => setWage(e.target.value)} className={input} />
              {tr("円", "JPY")}
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            {tr("深夜割増（22〜5時）", "Night premium (22:00–5:00)")}
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={night} onChange={(e) => setNight(e.target.value)} className={input} />%
            </span>
          </label>
          <p className="text-xs text-ink-sub">{tr("法定の深夜割増は25%以上（労働基準法37条4項）。時間帯のうち22〜5時にかかる分だけ上乗せします。", "Japanese law requires a night premium of at least 25% (Labor Standards Act, Art. 37(4)). It applies only to hours between 22:00 and 5:00.")}</p>
        </div>
        <div className={column}>
          <h3 className="text-sm font-bold">{tr("人が対応した場合の1件の時間", "Staff time per case")}</h3>
          {data.patterns.map((p) => (
            <label key={p.key} className="flex items-center justify-between gap-3 text-sm">
              {p.label}
              <span className="flex items-center gap-1.5">
                <input inputMode="decimal" value={minutes[p.key]} placeholder={a.minutes[p.key] === null ? tr(`仮 ${p.minutes}`, `e.g. ${p.minutes}`) : ""} onChange={(e) => setMinutes((m) => ({ ...m, [p.key]: e.target.value }))} className={input} />
                {tr("分", "min")}
              </span>
            </label>
          ))}
        </div>
        <div className={column}>
          <h3 className="text-sm font-bold">{tr("AIの単価", "AI pricing")}</h3>
          <label className="flex items-center justify-between gap-3 text-sm">
            {tr("為替（1ドル）", "Exchange rate (1 USD)")}
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} className={input} />
              {tr("円", "JPY")}
            </span>
          </label>
          <p className="text-xs text-ink-sub">{tr("モデルの単価は Nebius Token Factory の料金表（ドル建て）を使います。", "Model prices come from the Nebius Token Factory price list (in USD).")}</p>
        </div>
      </div>
    </section>
  );
}
