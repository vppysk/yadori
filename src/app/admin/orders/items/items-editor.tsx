"use client";

import { useState, useTransition } from "react";
import type { ItemSettings } from "@/server/items";
import type { ItemStatus } from "@/server/orders";
import { saveItemSettingsAction } from "../../actions";
import { LIST_SEP, tr } from "@/lib/i18n";

const LEVELS = [
  { value: 1, label: tr("軽", "Light"), on: "bg-primary-soft text-primary border-primary" },
  { value: 2, label: tr("中", "Medium"), on: "bg-weight-mid text-weight-mid-ink border-weight-mid-ink" },
  { value: 3, label: tr("重", "Heavy"), on: "bg-weight-mid-ink text-white border-weight-mid-ink" },
] as const;

// 取り扱いの状態（docs/005_order.md 6章）。在庫数は持たない
const STATUSES: { value: ItemStatus; label: string }[] = [
  { value: "available", label: tr("取り扱い中", "Available") },
  { value: "paused", label: tr("一時品切れ", "Out of stock") },
  { value: "retired", label: tr("取り扱い終了", "Discontinued") },
];

type EditItem = {
  key: string;
  id: string | null;
  category: string;
  name: string;
  aliases: string;
  job_role_id: string;
  weight: number;
  due_minutes: string;
  status: ItemStatus;
  actual: number | null;
  samples: number;
};
let seq = 0;

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => void;

export function ItemsEditor({ data }: { data: ItemSettings }) {
  const [items, setItems] = useState<EditItem[]>(
    data.items.map((i) => ({
      key: i.id ?? `n${++seq}`, id: i.id, category: i.category, name: i.name, aliases: i.aliases.join(LIST_SEP), job_role_id: i.job_role_id,
      weight: i.weight, due_minutes: String(i.due_minutes), status: i.status, actual: i.actual_minutes, samples: i.samples,
    })),
  );
  const [settings, setSettings] = useState(data.settings);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const touch = () => (setDirty(true), setMessage(null));
  const update = (key: string, patch: Partial<EditItem>) => (setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i))), touch());
  const run: Run = (fn, ok) =>
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? (ok ? { kind: "ok", text: ok } : null) : { kind: "error", text: r.error ?? tr("失敗しました", "Failed") });
      if (r.ok && ok) setDirty(false);
    });
  const categories = [...new Set(items.map((i) => i.category.trim()).filter(Boolean))];

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-5.5 2xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <section className="flex min-w-0 flex-col gap-3.5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-[22px] font-bold">{tr("品目", "Items")}</h1>
            <div className="flex items-center gap-2">
              {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
              <button
                type="button"
                onClick={() => (
                  setItems((prev) => [
                    ...prev,
                    { key: `n${++seq}`, id: null, category: prev.at(-1)?.category ?? "", name: "", aliases: "", job_role_id: data.roles[0]?.id ?? "", weight: 1, due_minutes: "30", status: "available", actual: null, samples: 0 },
                  ]),
                  touch()
                )}
                className="min-h-11 rounded-[10px] border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
              >
                {tr("＋ 品目を追加", "+ Add item")}
              </button>
              <button
                type="button"
                disabled={!dirty || pending}
                onClick={() =>
                  run(
                    () =>
                      saveItemSettingsAction({
                        items: items.map((i) => ({
                          id: i.id, category: i.category, name: i.name, aliases: i.aliases.split(/[、,]/), job_role_id: i.job_role_id, weight: i.weight,
                          due_minutes: Number(i.due_minutes), status: i.status,
                        })),
                        settings,
                      }),
                    tr("保存しました", "Saved"),
                  )
                }
                className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40"
              >
                {tr("保存", "Save")}
              </button>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-ink-sub">
            {tr(
              "分類はゲスト画面・フロントの選択欄のまとまりです。ゲストが「タオル」のように分類で頼むと、その分類の品目から選んでいただきます。別名は任意です（ゲストの言い方の照合を補います）。",
              "Categories group items in the guest and front-desk forms. If a guest asks by category (e.g. \"towels\"), they choose from that category. Aliases are optional and help match how guests say things.",
            )}
          </p>
          <datalist id="item-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-canvas text-left text-xs text-ink-sub">
                <tr>
                  <th className="px-3.5 py-2.5 font-normal">{tr("分類", "Category")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("品目", "Item")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("別名（任意）", "Aliases (optional)")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("担当の役割", "Role")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("重み", "Weight")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("期限", "Due")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("実測の平均", "Actual avg")}</th>
                  <th className="px-2 py-2.5 font-normal">{tr("状態", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.key} className={`border-t border-line ${i.status === "retired" ? "text-ink-sub" : ""}`}>
                    <td className="px-3.5 py-2">
                      <input aria-label={tr("分類", "Category")} list="item-categories" value={i.category} onChange={(e) => update(i.key, { category: e.target.value })} className="min-h-9 w-28 rounded-lg border border-line-input px-2" />
                    </td>
                    <td className="px-2 py-2">
                      <input aria-label={tr("品目名", "Item name")} value={i.name} onChange={(e) => update(i.key, { name: e.target.value })} className="min-h-9 w-full rounded-lg border border-line-input px-2" />
                    </td>
                    <td className="px-2 py-2">
                      <input aria-label={tr("別名", "Aliases")} value={i.aliases} onChange={(e) => update(i.key, { aliases: e.target.value })} placeholder={tr("「、」区切り", "comma-separated")} className="min-h-9 w-full rounded-lg border border-line-input px-2" />
                    </td>
                    <td className="px-2 py-2">
                      <select aria-label={tr("担当の役割", "Role")} value={i.job_role_id} onChange={(e) => update(i.key, { job_role_id: e.target.value })} className="min-h-9 rounded-lg border border-line-input px-1.5">
                        {data.roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <div role="radiogroup" aria-label={tr(`${i.name}の重み`, `${i.name} weight`)} className="grid grid-cols-3 gap-1">
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
                        <input aria-label={tr("期限（分）", "Due (min)")} inputMode="numeric" value={i.due_minutes} onChange={(e) => update(i.key, { due_minutes: e.target.value })} className="min-h-9 w-14 rounded-lg border border-line-input px-2 text-right" />
                        {tr("分", "min")}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-ink-sub">{i.actual === null ? "—" : tr(`${i.actual}分（${i.samples}件）`, `${i.actual} min (${i.samples})`)}</td>
                    <td className="px-2 py-2">
                      <select
                        aria-label={tr("取り扱いの状態", "Availability")}
                        value={i.status}
                        onChange={(e) => update(i.key, { status: e.target.value as ItemStatus })}
                        className={`min-h-9 rounded-lg border px-1.5 ${i.status === "paused" ? "border-caution text-caution" : "border-line-input"}`}
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-ink-sub">
            {tr(
              "一時品切れ：ゲストの選択欄に「品切れ中」と出し、頼まれたらスタッフが確認して連絡します。取り扱い終了：ゲスト・フロントには出しません。",
              "Out of stock: shown as \"out of stock\" to guests; staff follow up if requested. Discontinued: hidden from guests and front desk.",
            )}
          </p>
          {data.suggestions.map((s) => (
            <div key={s} className="rounded-[10px] border border-[#E6C99E] bg-caution-soft px-3.5 py-3 text-sm">
              <strong className="text-caution">{tr("見直しの提案：", "Suggestion: ")}</strong>
              {s}
            </div>
          ))}
          {data.suggestions.length === 0 && <p className="text-xs text-ink-sub">{tr("見直しの提案は、実測が各品目3件以上たまると表示されます。", "Suggestions appear once each item has 3+ measured deliveries.")}</p>}
        </section>
      </div>

      <aside aria-label={tr("割り当ての設定", "Assignment settings")} className="flex w-full shrink-0 flex-col gap-4 self-start rounded-[14px] border border-line bg-surface p-4.5 2xl:w-[320px]">
        <h2 className="text-base font-bold">{tr("割り当ての設定", "Assignment settings")}</h2>
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-sub">{tr("重みのポイント", "Weight points")}</span>
          {LEVELS.map((l) => (
            <div key={l.value} className="flex justify-between">
              <span>{l.label}</span>
              <strong>{l.value}pt</strong>
            </div>
          ))}
        </div>
        <div className="h-px bg-line" />
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-sub">
          {tr("未着手のまま次の人へ回すまで", "Pass to the next person if not started within")}
          <select
            value={settings.reassignMinutes}
            onChange={(e) => (setSettings((s) => ({ ...s, reassignMinutes: Number(e.target.value) })), touch())}
            className="min-h-11 rounded-lg border border-line-input px-2.5 text-sm text-ink"
          >
            {[5, 10, 15, 20, 30].map((m) => (
              <option key={m} value={m}>
                {tr(`${m}分`, `${m} min`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-sub">
          {tr("時間指定のオーダーを割り当てるタイミング", "When to assign scheduled orders")}
          <select
            value={settings.scheduleLeadMinutes}
            onChange={(e) => (setSettings((s) => ({ ...s, scheduleLeadMinutes: Number(e.target.value) })), touch())}
            className="min-h-11 rounded-lg border border-line-input px-2.5 text-sm text-ink"
          >
            {[10, 15, 20, 30, 45, 60, 90].map((m) => (
              <option key={m} value={m}>
                {tr(`お届けの${m}分前`, `${m} min before delivery`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input type="checkbox" checked={settings.bundleEnabled} onChange={(e) => (setSettings((s) => ({ ...s, bundleEnabled: e.target.checked })), touch())} className="size-5 accent-primary" />
          {tr("同じフロアの近い時間の依頼はまとめる", "Bundle nearby requests on the same floor")}
        </label>
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input type="checkbox" checked={settings.declineReasonRequired} onChange={(e) => (setSettings((s) => ({ ...s, declineReasonRequired: e.target.checked })), touch())} className="size-5 accent-primary" />
          {tr("「対応できない」は理由の入力を必須にする", "Require a reason for \"Can't handle\"")}
        </label>
        <p className="text-xs text-ink-sub">{tr("割り当ての設定は「保存」で反映されます。スタッフごとの担当（役割×エリア）は「担当設定」で設定します。", "Assignment settings apply when you Save. Each staff member's duties (role × area) are set under Duties.")}</p>
      </aside>
    </main>
  );
}
