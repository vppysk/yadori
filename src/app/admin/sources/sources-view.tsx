"use client";

import { useRef, useState, useTransition } from "react";
import type { SourceRow } from "@/server/external-sources";
import { addBoostAction, addSourceAction, deleteBoostAction, deleteSourceAction, fetchSourceNowAction, updateSourceAction } from "../actions";

// external-sources.ts の INTERVAL_OPTIONS / IMPACT_LABELS と同じ値（サーバーのモジュールはクライアントから読み込めないため）
const INTERVAL_OPTIONS = [10, 15, 30, 60, 180, 360, 720, 1440];
const IMPACT: Record<string, { label: string; className: string }> = {
  none: { label: "影響なし", className: "bg-muted text-ink-sub" },
  notice: { label: "お知らせ", className: "bg-primary-soft text-primary" },
  alert: { label: "要注意", className: "bg-danger-soft text-danger" },
};
// Tavily Extract は成功5件ごとに1クレジット。無料枠は月1,000クレジット
const URLS_PER_CREDIT = 5;
const MINUTES_PER_MONTH = 60 * 24 * 30;

function intervalLabel(minutes: number) {
  if (minutes === 1440) return "1日1回";
  if (minutes >= 60) return `${minutes / 60}時間ごと`;
  return `${minutes}分ごと`;
}

type Message = { kind: "ok" | "error"; text: string } | null;
const inputClass = "min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink";

export function SourcesView({ sources, nowLocal, apiKeyConfigured }: { sources: SourceRow[]; nowLocal: string; apiKeyConfigured: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "操作できませんでした");
    });
  const fetchesPerMonth = sources.filter((s) => s.active).reduce((sum, s) => sum + MINUTES_PER_MONTH / s.interval_minutes, 0);

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">外部の情報源</h1>
        <p className="text-sm text-ink-sub">
          運行情報・天気予報・イベントの公式サイトなど、登録したURLだけを定期的に取得します（検索はしません）。内容が変わるとAIが要約し、ゲストへの案内とAI相談に使います。影響が大きいときはスタッフに通知します。
        </p>
      </div>
      {!apiKeyConfigured && <p className="rounded-lg bg-danger-soft px-4 py-2.5 text-sm text-danger">TAVILY_API_KEY が設定されていないため、取得できません。</p>}
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-4 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <RegisterForm />
        <BoostForm sources={sources} nowLocal={nowLocal} />
      </div>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-2">
          <h2 className="text-base font-bold">登録済み（{sources.length}件）</h2>
          <span className="text-xs text-ink-sub">
            基本の頻度での取得: 月あたり約{Math.round(fetchesPerMonth).toLocaleString("ja-JP")}回（Tavily 約{Math.ceil(fetchesPerMonth / URLS_PER_CREDIT).toLocaleString("ja-JP")}クレジット、無料枠は月1,000）
          </span>
        </div>
        {sources.map((s) => (
          <SourceCard key={s.id} source={s} pending={pending} run={run} />
        ))}
        {sources.length === 0 && <p className="border-t border-line px-5 py-4 text-sm text-ink-sub">まだ登録されていません</p>}
      </section>
    </main>
  );
}

function RegisterForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setMessage(null);
        startTransition(async () => {
          const r = await addSourceAction({
            name: form.get("name"),
            url: form.get("url"),
            purpose: form.get("purpose"),
            interval_minutes: Number(form.get("interval")),
          });
          if (!r.ok) return setMessage({ kind: "error", text: r.error });
          formRef.current?.reset();
          setMessage({ kind: "ok", text: "登録して、1回目の取得をしました。" });
        });
      }}
    >
      <h2 className="text-base font-bold">登録</h2>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          名前
          <input name="name" required maxLength={60} placeholder="例: JR北海道 運行情報" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          取得の頻度（基本）
          <select name="interval" defaultValue={60} className={inputClass}>
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-ink-sub">
        URL
        <input name="url" type="url" required placeholder="https://" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-sub">
        このページで見る内容
        <input name="purpose" maxLength={300} placeholder="例: 千歳線・快速エアポートの運休や遅れ" className={inputClass} />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" required className="size-5 accent-primary" />
        公式サイトなど、信頼できる情報源であることを確認しました
      </label>
      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button type="submit" disabled={pending} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
          {pending ? "登録して取得しています…" : "登録"}
        </button>
      </div>
    </form>
  );
}

// 期間を限定して頻度を上げる（台風の接近など）
function BoostForm({ sources, nowLocal }: { sources: SourceRow[]; nowLocal: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setMessage(null);
        startTransition(async () => {
          const r = await addBoostAction({
            sourceIds: form.getAll("sourceIds"),
            interval_minutes: Number(form.get("interval")),
            starts_at: form.get("starts_at"),
            ends_at: form.get("ends_at"),
            reason: form.get("reason"),
          });
          if (!r.ok) return setMessage({ kind: "error", text: r.error });
          formRef.current?.reset();
          setMessage({ kind: "ok", text: "設定しました。期間中はこの頻度で取得します。" });
        });
      }}
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-bold">期間を限定して頻度を上げる</h2>
        <span className="text-xs text-ink-sub">台風の接近や大雪の予報など、状況が変わりやすい期間だけ取得を増やします。期間が終わると基本の頻度に戻ります。</span>
      </div>
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="pb-1 text-xs text-ink-sub">対象</legend>
        {sources.map((s) => (
          <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="sourceIds" value={s.id} className="size-5 accent-primary" />
            {s.name}
          </label>
        ))}
        {sources.length === 0 && <span className="text-sm text-ink-sub">先に情報源を登録してください</span>}
      </fieldset>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          開始
          <input name="starts_at" type="datetime-local" required defaultValue={nowLocal} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          終了
          <input name="ends_at" type="datetime-local" required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          頻度
          <select name="interval" defaultValue={15} className={inputClass}>
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-ink-sub">
        理由
        <input name="reason" required maxLength={100} placeholder="例: 台風の接近" className={inputClass} />
      </label>
      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button type="submit" disabled={pending || sources.length === 0} className="min-h-11 rounded-[10px] bg-dark px-5 text-sm font-bold text-white disabled:opacity-40">
          設定
        </button>
      </div>
    </form>
  );
}

function SourceCard({ source: s, pending, run }: { source: SourceRow; pending: boolean; run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void }) {
  const impact = s.latest?.impact ? IMPACT[s.latest.impact] : undefined;
  const boosted = s.effective_interval < s.interval_minutes;
  return (
    <article className={`flex flex-col gap-2 border-t border-line px-5 py-4 ${s.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[15px]">{s.name}</strong>
        {impact && <span className={`rounded-md px-2 py-0.5 text-xs ${impact.className}`}>{impact.label}</span>}
        {s.last_status === "error" && <span className="rounded-md bg-danger-soft px-2 py-0.5 text-xs text-danger">取得エラー</span>}
        {!s.active && <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-ink-sub">停止中</span>}
        <span className="flex-1" />
        <span className="text-xs text-ink-sub">
          {boosted ? `${intervalLabel(s.effective_interval)}（期間限定）・基本は${intervalLabel(s.interval_minutes)}` : intervalLabel(s.interval_minutes)}
          {s.last_success_at ? ` ・ 最終確認 ${s.last_success_at}` : ""}
        </span>
      </div>
      <a href={s.url} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-ink-sub underline underline-offset-2">
        {s.url}
      </a>
      {s.purpose && <p className="text-xs text-ink-sub">見る内容: {s.purpose}</p>}
      {s.latest?.summary && (
        <div className="flex flex-col gap-1 rounded-lg bg-canvas px-3.5 py-2.5 text-sm leading-relaxed">
          <p>{s.latest.summary}</p>
          {s.latest.staff_message && <p className="text-xs text-ink-sub">スタッフへの配信: {s.latest.staff_message}</p>}
          <span className="text-[11px] text-ink-sub">{s.latest.fetched_at} に内容の変化を取得</span>
        </div>
      )}
      {s.last_status === "error" && s.last_error && <p className="text-xs text-danger">エラー: {s.last_error}</p>}
      {s.boosts.map((b) => (
        <div key={b.id} className="flex items-center gap-2 text-xs">
          <span className={`rounded-md px-2 py-0.5 ${b.active ? "bg-caution-soft text-caution" : "bg-muted text-ink-sub"}`}>{b.active ? "実施中" : "予定"}</span>
          <span>
            {b.starts_at}〜{b.ends_at} {intervalLabel(b.interval_minutes)}（{b.reason}）
          </span>
          <button
            type="button"
            aria-label={`${b.reason}の頻度の設定を削除`}
            disabled={pending}
            onClick={() => run(() => deleteBoostAction(b.id))}
            className="min-h-9 w-9 rounded-lg text-ink-sub hover:bg-canvas"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-sub">
          基本の頻度
          <select
            value={s.interval_minutes}
            disabled={pending}
            onChange={(e) => run(() => updateSourceAction(s.id, { interval_minutes: Number(e.target.value) }))}
            className="min-h-9 rounded-lg border border-line-input px-2 text-sm text-ink"
          >
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={pending || !s.active} onClick={() => run(() => fetchSourceNowAction(s.id))} className="min-h-11 rounded-lg border border-line-input px-3 text-sm disabled:opacity-40">
          今すぐ取得
        </button>
        <button type="button" disabled={pending} onClick={() => run(() => updateSourceAction(s.id, { active: !s.active }))} className="min-h-11 rounded-lg border border-line-input px-3 text-sm">
          {s.active ? "停止" : "再開"}
        </button>
        <button type="button" disabled={pending} onClick={() => run(() => deleteSourceAction(s.id))} className="min-h-11 rounded-lg px-3 text-sm text-danger hover:bg-danger-soft">
          削除
        </button>
      </div>
    </article>
  );
}
