"use client";

import { useState, useTransition } from "react";
import type { ItemSettings } from "@/server/items";
import { addSlotAction, deleteSlotAction, saveItemSettingsAction } from "../actions";

const LEVELS = [
  { value: 1, label: "軽", on: "bg-primary-soft text-primary border-primary" },
  { value: 2, label: "中", on: "bg-weight-mid text-weight-mid-ink border-weight-mid-ink" },
  { value: 3, label: "重", on: "bg-weight-mid-ink text-white border-weight-mid-ink" },
] as const;

type EditItem = { key: string; id: string | null; name: string; aliases: string; job_role_id: string; weight: number; due_minutes: string; active: boolean; actual: number | null; samples: number };
let seq = 0;

export function ItemsEditor({ data }: { data: ItemSettings }) {
  const [items, setItems] = useState<EditItem[]>(
    data.items.map((i) => ({ key: i.id ?? `n${++seq}`, id: i.id, name: i.name, aliases: i.aliases.join("、"), job_role_id: i.job_role_id, weight: i.weight, due_minutes: String(i.due_minutes), active: i.active, actual: i.actual_minutes, samples: i.samples })),
  );
  const [settings, setSettings] = useState(data.settings);
  const [newSlot, setNewSlot] = useState({ role: data.roles[0]?.id ?? "", area: "" });
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const touch = () => (setDirty(true), setMessage(null));
  const update = (key: string, patch: Partial<EditItem>) => (setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i))), touch());
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) =>
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? (ok ? { kind: "ok", text: ok } : null) : { kind: "error", text: r.error ?? "失敗しました" });
      if (r.ok && ok) setDirty(false);
    });

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-5.5 xl:flex-row">
      <section className="flex min-w-0 flex-1 flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[22px] font-bold">品目</h1>
          <div className="flex items-center gap-2">
            {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
            <button
              type="button"
              onClick={() => (setItems((prev) => [...prev, { key: `n${++seq}`, id: null, name: "", aliases: "", job_role_id: data.roles[0]?.id ?? "", weight: 1, due_minutes: "30", active: true, actual: null, samples: 0 }]), touch())}
              className="min-h-11 rounded-[10px] border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
            >
              ＋ 品目を追加
            </button>
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() =>
                run(
                  () =>
                    saveItemSettingsAction({
                      items: items.map((i) => ({
                        id: i.id, name: i.name, aliases: i.aliases.split(/[、,]/), job_role_id: i.job_role_id, weight: i.weight, due_minutes: Number(i.due_minutes), active: i.active,
                      })),
                      settings,
                    }),
                  "保存しました",
                )
              }
              className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-canvas text-left text-xs text-ink-sub">
              <tr>
                <th className="px-3.5 py-2.5 font-normal">品目</th>
                <th className="px-2 py-2.5 font-normal">別名（ゲストの言い方）</th>
                <th className="px-2 py-2.5 font-normal">担当の役割</th>
                <th className="px-2 py-2.5 font-normal">重み</th>
                <th className="px-2 py-2.5 font-normal">期限</th>
                <th className="px-2 py-2.5 font-normal">実測の平均</th>
                <th className="px-2 py-2.5 font-normal">有効</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.key} className="border-t border-line">
                  <td className="px-3.5 py-2">
                    <input aria-label="品目名" value={i.name} onChange={(e) => update(i.key, { name: e.target.value })} className="min-h-9 w-full rounded-lg border border-line-input px-2" />
                  </td>
                  <td className="px-2 py-2">
                    <input aria-label="別名" value={i.aliases} onChange={(e) => update(i.key, { aliases: e.target.value })} placeholder="「、」区切り" className="min-h-9 w-full rounded-lg border border-line-input px-2" />
                  </td>
                  <td className="px-2 py-2">
                    <select aria-label="担当の役割" value={i.job_role_id} onChange={(e) => update(i.key, { job_role_id: e.target.value })} className="min-h-9 rounded-lg border border-line-input px-1.5">
                      {data.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div role="radiogroup" aria-label={`${i.name}の重み`} className="grid grid-cols-3 gap-1">
                      {LEVELS.map((l) => (
                        <button
                          key={l.value}
                          type="button"
                          role="radio"
                          aria-checked={i.weight === l.value}
                          onClick={() => update(i.key, { weight: l.value })}
                          className={`min-h-9 w-10 rounded-md border text-[13px] font-bold ${i.weight === l.value ? l.on : "border-line-input bg-surface text-ink-sub"}`}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-1">
                      <input aria-label="期限（分）" inputMode="numeric" value={i.due_minutes} onChange={(e) => update(i.key, { due_minutes: e.target.value })} className="min-h-9 w-14 rounded-lg border border-line-input px-2 text-right" />分
                    </span>
                  </td>
                  <td className="px-2 py-2 text-ink-sub">{i.actual === null ? "—" : `${i.actual}分（${i.samples}件）`}</td>
                  <td className="px-2 py-2">
                    <input type="checkbox" aria-label="有効" checked={i.active} onChange={(e) => update(i.key, { active: e.target.checked })} className="size-5 accent-primary" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.suggestions.map((s) => (
          <div key={s} className="rounded-[10px] border border-[#E6C99E] bg-caution-soft px-3.5 py-3 text-sm">
            <strong className="text-caution">見直しの提案：</strong>
            {s}
          </div>
        ))}
        {data.suggestions.length === 0 && <p className="text-xs text-ink-sub">見直しの提案は、実測が各品目{3}件以上たまると表示されます。</p>}
      </section>

      <aside aria-label="割り当ての設定" className="flex w-full shrink-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4.5 xl:w-[300px]">
        <h2 className="text-base font-bold">割り当ての設定</h2>
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-sub">重みのポイント</span>
          {LEVELS.map((l) => (
            <div key={l.value} className="flex justify-between">
              <span>{l.label}</span>
              <strong>{l.value}pt</strong>
            </div>
          ))}
        </div>
        <div className="h-px bg-line" />
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-sub">
          未着手のまま次の人へ回すまで
          <select
            value={settings.reassignMinutes}
            onChange={(e) => (setSettings((s) => ({ ...s, reassignMinutes: Number(e.target.value) })), touch())}
            className="min-h-11 rounded-lg border border-line-input px-2.5 text-sm text-ink"
          >
            {[5, 10, 15, 20, 30].map((m) => (
              <option key={m} value={m}>
                {m}分
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input type="checkbox" checked={settings.bundleEnabled} onChange={(e) => (setSettings((s) => ({ ...s, bundleEnabled: e.target.checked })), touch())} className="size-5 accent-primary" />
          同じフロアの近い時間の依頼はまとめる
        </label>
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input type="checkbox" checked={settings.declineReasonRequired} onChange={(e) => (setSettings((s) => ({ ...s, declineReasonRequired: e.target.checked })), touch())} className="size-5 accent-primary" />
          「対応できない」は理由の入力を必須にする
        </label>
        <div className="h-px bg-line" />
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-sub">担当の枠（役割 × エリア）・本日の出勤</span>
          {data.slots.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2">
              <span>{s.label}</span>
              <span className="flex items-center gap-1 text-ink-sub">
                {s.members}名
                <button type="button" aria-label={`${s.label}を削除`} disabled={pending} onClick={() => run(() => deleteSlotAction(s.id))} className="min-h-9 w-8">
                  ×
                </button>
              </span>
            </div>
          ))}
          <div className="mt-1 flex flex-col gap-1.5 rounded-lg bg-canvas p-2">
            <select aria-label="役割" value={newSlot.role} onChange={(e) => setNewSlot((p) => ({ ...p, role: e.target.value }))} className="min-h-9 rounded-lg border border-line-input px-1.5">
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select aria-label="エリア" value={newSlot.area} onChange={(e) => setNewSlot((p) => ({ ...p, area: e.target.value }))} className="min-h-9 rounded-lg border border-line-input px-1.5">
              <option value="">全館</option>
              {data.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={pending || !newSlot.role} onClick={() => run(() => addSlotAction(newSlot.role, newSlot.area || null))} className="min-h-9 rounded-lg border border-dashed border-[#BDB6AA] text-ink-sub">
              ＋ 枠を追加
            </button>
          </div>
        </div>
      </aside>
    </main>
  );
}
