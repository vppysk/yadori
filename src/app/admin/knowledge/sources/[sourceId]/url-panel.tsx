"use client";

import { useState, useTransition } from "react";
import { INTERVAL_OPTIONS, intervalLabel } from "@/lib/fetch-intervals";
import type { ReflectMode, UrlSettings } from "@/server/source-fetch";
import { addBoostAction, deleteBoostAction, fetchUrlSourceNowAction, setReflectModeAction, updateUrlSettingsAction } from "../../../actions";
import { tr } from "@/lib/i18n";

const input = "min-h-10 rounded-lg border border-line-input bg-surface px-2.5 text-sm";

// URLの資料の取得の設定（docs/006_guide_info.md）: 取得間隔・取得を止める・今すぐ取得・期間を限定して頻度を上げる
export function UrlPanel({ sourceId, settings }: { sourceId: string; settings: UrlSettings }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [boost, setBoost] = useState({ interval_minutes: 15, starts_at: "", ends_at: "", reason: "" });
  const [nextMode, setNextMode] = useState<ReflectMode | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? tr("操作できませんでした", "Couldn't complete that"));
      else onDone?.();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-bold">{tr("Webページの取得", "Web page fetching")}</h2>
        <a href={settings.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-primary underline underline-offset-2">
          {settings.url}
        </a>
        <button type="button" disabled={pending} onClick={() => run(() => fetchUrlSourceNowAction(sourceId))} className="min-h-10 rounded-lg border border-line-input px-3 disabled:opacity-50">
          {pending ? tr("取得中…", "Fetching…") : tr("今すぐ取得", "Fetch now")}
        </button>
      </div>
      {settings.purpose && <p className="text-xs text-ink-sub">{tr("見る内容: ", "Watching: ")}{settings.purpose}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          {tr("反映のしかた", "How to apply")}
          <select value={nextMode ?? settings.reflect_mode} disabled={pending} onChange={(e) => setNextMode(e.target.value as ReflectMode)} className={input}>
            <option value="approval">{tr("承認して反映", "Apply after approval")}</option>
            <option value="auto">{tr("自動反映（運行情報・天気など）", "Apply automatically (train status, weather, etc.)")}</option>
          </select>
        </label>
        {nextMode && nextMode !== settings.reflect_mode && (
          <span className="flex flex-wrap items-center gap-2 rounded-lg bg-caution-soft px-2.5 py-1.5 text-xs">
            {nextMode === "auto"
              ? tr("承認して案内に使っていた内容はこの資料から外れ、取得のたびの要約で案内します。", "Approved content from this source will be dropped, and each fetch's summary will be used instead.")
              : tr("自動反映の要約は使わなくなり、読み取った内容を承認するまでこの資料は案内に使われません。", "The auto summary will stop being used, and this source won't be used until you approve what's extracted.")}
            <button type="button" disabled={pending} onClick={() => run(() => setReflectModeAction(sourceId, nextMode), () => setNextMode(null))} className="min-h-9 rounded-md bg-dark px-3 font-bold text-white">
              {tr("変更する", "Change")}
            </button>
            <button type="button" onClick={() => setNextMode(null)} className="min-h-9 rounded-md border border-line-input bg-surface px-3">
              {tr("やめる", "Cancel")}
            </button>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          {tr("取得間隔", "Fetch interval")}
          <select
            value={settings.interval_minutes}
            disabled={pending}
            onChange={(e) => run(() => updateUrlSettingsAction(sourceId, { interval_minutes: Number(e.target.value) }))}
            className={input}
          >
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        </label>
        {settings.effective_interval !== settings.interval_minutes && <span className="text-xs text-caution">{tr(`今は ${intervalLabel(settings.effective_interval)}（期間限定）`, `Now ${intervalLabel(settings.effective_interval)} (temporary)`)}</span>}
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" checked={!settings.active} disabled={pending} onChange={(e) => run(() => updateUrlSettingsAction(sourceId, { active: !e.target.checked }))} className="size-4" />
          {tr("取得を止める", "Stop fetching")}
        </label>
        <span className="flex-1" />
        <span className={`text-xs ${settings.last_status === "error" ? "text-danger" : "text-ink-sub"}`}>
          {settings.last_status === "error"
            ? tr(`取得に失敗（${settings.last_error ?? "原因不明"}）`, `Fetch failed (${settings.last_error ?? "unknown"})`)
            : settings.last_success_at
              ? tr(`最終取得 ${settings.last_success_at}`, `Last fetched ${settings.last_success_at}`)
              : tr("未取得", "Not fetched")}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <h3 className="text-xs font-bold text-ink-sub">{tr("期間を限定して頻度を上げる（台風の接近など）", "Fetch more often for a limited time (e.g. a storm is coming)")}</h3>
        {settings.boosts.map((b) => (
          <div key={b.id} className="flex items-center gap-2 text-xs">
            <span className={b.active ? "font-bold text-caution" : "text-ink-sub"}>{b.active ? tr("実施中", "Active") : tr("予定", "Scheduled")}</span>
            <span>
              {b.starts_at}{tr("〜", " – ")}{b.ends_at} ・ {intervalLabel(b.interval_minutes)} ・ {b.reason}
            </span>
            <button type="button" aria-label={tr("この期間を削除", "Delete this period")} disabled={pending} onClick={() => run(() => deleteBoostAction(b.id))} className="size-8 rounded text-ink-sub hover:bg-canvas">
              ×
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={tr("期間中の取得間隔", "Interval during the period")} value={boost.interval_minutes} onChange={(e) => setBoost({ ...boost, interval_minutes: Number(e.target.value) })} className={input}>
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
          <input type="datetime-local" aria-label={tr("開始", "Start")} value={boost.starts_at} onChange={(e) => setBoost({ ...boost, starts_at: e.target.value })} className={input} />
          {tr("〜", "–")}
          <input type="datetime-local" aria-label={tr("終了", "End")} value={boost.ends_at} onChange={(e) => setBoost({ ...boost, ends_at: e.target.value })} className={input} />
          <input aria-label={tr("理由", "Reason")} placeholder={tr("理由（例: 台風の接近）", "Reason (e.g. storm approaching)")} value={boost.reason} onChange={(e) => setBoost({ ...boost, reason: e.target.value })} className={`${input} min-w-40 flex-1`} />
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => addBoostAction(sourceId, boost), () => setBoost({ interval_minutes: 15, starts_at: "", ends_at: "", reason: "" }))}
            className="min-h-10 rounded-lg border border-line-input px-3 disabled:opacity-50"
          >
            {tr("追加", "Add")}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </section>
  );
}
