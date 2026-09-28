"use client";

import { useState, useTransition } from "react";
import type { AreaSettings } from "@/server/items";
import { addAreaAction, deleteAreaAction, setFloorAreaAction } from "../../actions";

// エリア設定（docs/005_order.md 4章）。部屋は予約・客室管理システムのIDで持ち、棟・フロアごとにエリアへ入れる
export function AreasEditor({ data }: { data: AreaSettings }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "失敗しました"));
    });
  const floorLabel = (f: AreaSettings["floors"][number]) => `${f.building ? `${f.building} ` : ""}${f.floor}F`;
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-3 px-6 py-5.5">
      <h1 className="text-[22px] font-bold">エリア設定</h1>
      {error && <p className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{error}</p>}
      <p className="text-xs leading-relaxed text-ink-sub">
        オーダーは部屋のエリアの担当に割り当てます（エリアのない部屋は全館の担当だけが受けます）。部屋は予約・客室管理システムの部屋IDで区別するため、本館と別館で同じ部屋番号があっても分けられます。
      </p>
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex flex-col gap-1.5 md:w-60">
          <span className="text-xs text-ink-sub">エリア</span>
          {data.areas.map((a) => (
            <div key={a.id} className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-sm">
              <span>{a.name}</span>
              <span className="flex items-center gap-1 text-xs text-ink-sub">
                {a.rooms}室
                <button type="button" aria-label={`${a.name}を削除`} disabled={pending || a.duties > 0} title={a.duties > 0 ? "スタッフの担当で使っています" : undefined} onClick={() => run(() => deleteAreaAction(a.id))} className="min-h-9 w-7 disabled:opacity-30">
                  ×
                </button>
              </span>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => addAreaAction(name));
              setName("");
            }}
            className="flex gap-1.5"
          >
            <input aria-label="新しいエリア名" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 別館" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line-input px-2.5 text-sm" />
            <button type="submit" disabled={pending || !name.trim()} className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub disabled:opacity-50">
              追加
            </button>
          </form>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-xs text-ink-sub">棟・フロアごとのエリア</span>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {data.floors.map((f) => {
              const mixed = f.area_ids.length > 1;
              return (
                <label key={floorLabel(f)} className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-sm">
                  <span>
                    {floorLabel(f)} <span className="text-xs text-ink-sub">{f.rooms}室</span>
                  </span>
                  <select
                    aria-label={`${floorLabel(f)}のエリア`}
                    disabled={pending}
                    value={mixed ? "__mixed" : (f.area_ids[0] ?? "")}
                    onChange={(e) => run(() => setFloorAreaAction(f.building, f.floor, e.target.value || null))}
                    className="min-h-9 rounded-lg border border-line-input px-1.5 text-[13px]"
                  >
                    {mixed && (
                      <option value="__mixed" disabled>
                        部屋ごとに異なる
                      </option>
                    )}
                    <option value="">エリアなし</option>
                    {data.areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
