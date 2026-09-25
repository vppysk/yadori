"use client";

import { useState, useTransition } from "react";
import type { Masters } from "@/server/masters";
import { saveMastersAction } from "../actions";

const PHASE_LABELS: Record<string, string> = {
  "info:all": "案内",
  "order:intake": "オーダー（受付）",
  "order:delivery": "オーダー（配達）",
  "external:all": "外部連携",
  "reservation:all": "予約・客室",
  "complaint:all": "クレーム",
};

const toNum = (v: string) => (v.trim() === "" ? null : Number(v));

export function MastersEditor({ masters }: { masters: Masters }) {
  const [wages, setWages] = useState(Object.fromEntries(Object.entries(masters.wages).map(([k, v]) => [k, v?.toString() ?? ""])));
  const [newTitle, setNewTitle] = useState("");
  const [handling, setHandling] = useState(masters.handling.map((h) => ({ ...h, value: h.minutes?.toString() ?? "" })));
  const [bands, setBands] = useState(masters.bands.map((b) => ({ ...b, value: b.wageMultiplier.toString() })));
  const [fx, setFx] = useState(masters.fxUsdJpy.toString());
  const [infra, setInfra] = useState(masters.infraMonthlyJpy.toString());
  const [satisfaction, setSatisfaction] = useState(masters.targetSatisfactionMin === null ? "" : (masters.targetSatisfactionMin * 100).toString());
  const [handoff, setHandoff] = useState(masters.targetHandoffRateMax === null ? "" : (masters.targetHandoffRateMax * 100).toString());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const input = "min-h-10 w-28 rounded-lg border border-line-input px-2.5 text-right text-sm outline-none focus:border-primary";

  function save() {
    startTransition(async () => {
      const pct = (v: string) => (toNum(v) === null ? null : toNum(v)! / 100);
      const result = await saveMastersAction({
        wages: Object.fromEntries(Object.entries(wages).map(([k, v]) => [k, toNum(v)])),
        handling: handling.map(({ pattern, phase, value }) => ({ pattern, phase, minutes: toNum(value) })),
        bands: bands.map(({ id, name, value }) => ({ id, name, wageMultiplier: Number(value) })),
        fxUsdJpy: Number(fx),
        infraMonthlyJpy: Number(infra),
        targetSatisfactionMin: pct(satisfaction),
        targetHandoffRateMax: pct(handoff),
      });
      setMessage(result.ok ? { kind: "ok", text: "保存しました。見積もりに使われます。" } : { kind: "error", text: result.error });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button type="button" disabled={pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
          保存
        </button>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <h2 className="text-base font-bold">人件費（役職別の時給）</h2>
          {Object.keys(wages).map((title) => (
            <label key={title} className="flex items-center justify-between gap-3 text-sm">
              {title}
              <span className="flex items-center gap-1.5">
                <input inputMode="numeric" value={wages[title]} placeholder="未入力" onChange={(e) => setWages((p) => ({ ...p, [title]: e.target.value }))} className={input} />円
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="役職を追加" className="min-h-10 flex-1 rounded-lg border border-line-input px-2.5 text-sm" />
            <button type="button" disabled={!newTitle.trim() || newTitle.trim() in wages} onClick={() => (setWages((p) => ({ ...p, [newTitle.trim()]: "" })), setNewTitle(""))} className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub disabled:opacity-40">
              ＋ 追加
            </button>
          </div>
          <h3 className="pt-2 text-sm font-bold">時間帯別の割増</h3>
          {bands.map((b) => (
            <label key={b.id} className="flex items-center justify-between gap-3 text-sm">
              {b.name}
              <span className="flex items-center gap-1.5">
                ×<input inputMode="decimal" value={b.value} onChange={(e) => setBands((p) => p.map((x) => (x.id === b.id ? { ...x, value: e.target.value } : x)))} className={input} />
              </span>
            </label>
          ))}
        </section>
        <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <h2 className="text-base font-bold">対応時間（1件あたりの平均・分）</h2>
          <p className="text-xs text-ink-sub">人が対応した場合のコストの見積もりに使います。オーダーは受付と配達を分けます。</p>
          {handling.map((h) => {
            const key = `${h.pattern}:${h.phase}`;
            const actual = masters.actualMinutes[key];
            return (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {PHASE_LABELS[key]}
                  {actual !== undefined && <span className="block text-xs text-ink-sub">実測 {actual === null ? "—" : `${actual}分`}（チケットの着手〜完了）</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  <input inputMode="decimal" value={h.value} placeholder="未入力" onChange={(e) => setHandling((p) => p.map((x) => (x.pattern === h.pattern && x.phase === h.phase ? { ...x, value: e.target.value } : x)))} className={input} />分
                </span>
              </label>
            );
          })}
        </section>
        <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <h2 className="text-base font-bold">AI単価・目標値</h2>
          <label className="flex items-center justify-between gap-3 text-sm">
            為替（1ドル）
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} className={input} />円
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            インフラ月額
            <span className="flex items-center gap-1.5">
              <input inputMode="numeric" value={infra} onChange={(e) => setInfra(e.target.value)} className={input} />円
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            満足度の下限
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={satisfaction} placeholder="未設定" onChange={(e) => setSatisfaction(e.target.value)} className={input} />%
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            引き継ぎ率の上限
            <span className="flex items-center gap-1.5">
              <input inputMode="decimal" value={handoff} placeholder="未設定" onChange={(e) => setHandoff(e.target.value)} className={input} />%
            </span>
          </label>
          <p className="text-xs text-ink-sub">モデル単価は Nebius Token Factory の料金表（model_prices）を使います。目標値は将来の自動最適化の制約として保存します。</p>
        </section>
      </div>
    </div>
  );
}
