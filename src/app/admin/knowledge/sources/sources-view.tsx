"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UploadIcon } from "@/components/icons";
import { INTERVAL_OPTIONS, intervalLabel } from "@/lib/fetch-intervals";
import type { SourceListItem, SourceStatus } from "@/server/info-sources";
import { createInfoSourceAction, deleteInfoSourceAction } from "../../actions";

const AUTO_STATUS = { label: "自動反映", className: "bg-primary-soft text-primary" };
const STATUS: Record<SourceStatus, { label: string; className: string }> = {
  pending: { label: "確認待ち", className: "bg-caution text-white" },
  update_pending: { label: "更新の確認待ち", className: "bg-caution text-white" },
  approved: { label: "承認済み", className: "bg-primary-soft text-primary" },
};

const input = "min-h-11 rounded-lg border border-line-input px-3 text-sm";

// 資料（docs/002_facility_master_design.md、docs/006_guide_info.md）: ファイル・文章・URLを登録すると、AIが施設ごとに読み取る。
// 確認して承認すると案内に使われる。URLは定期的に取得し、変わったら読み直して承認を依頼する
export function SourcesView({ sources }: { sources: SourceListItem[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<"file" | "url">("file");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">資料</h1>
        <p className="text-sm text-ink-sub">
          営業案内やお知らせのPDF・画像・文章、またはWebページのURLを登録してください。AIが施設ごとの営業時間やメニューなどを読み取ります。内容を確認して承認すると、ゲストへの案内に使われます。
        </p>
      </div>
      <form
        className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          if (kind === "file") form.delete("url");
          setError(null);
          startTransition(async () => {
            const r = await createInfoSourceAction(form);
            if (!r.ok || !r.data) return setError(r.ok ? "登録できませんでした" : r.error);
            router.push(`/admin/knowledge/sources/${r.data}`);
          });
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold">資料を追加</h2>
          <div role="tablist" aria-label="資料の種類" className="flex gap-1 rounded-lg bg-canvas p-1 text-sm">
            {(
              [
                ["file", "ファイル・文章"],
                ["url", "WebページのURL"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={kind === key}
                onClick={() => setKind(key)}
                className={`min-h-9 rounded-md px-3 ${kind === key ? "bg-surface font-bold shadow-sm" : "text-ink-sub"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <input
          name="title"
          aria-label="資料の名前"
          placeholder={kind === "url" ? "資料の名前 例: JR北海道 運行情報" : "資料の名前（省略するとファイル名）例: 冬季営業のお知らせ"}
          className={input}
        />
        {kind === "file" ? (
          <>
            <textarea name="text" rows={3} aria-label="文章" placeholder="ファイルがないときは、ここに文章を入力（例: 大浴場は6:00〜24:00。10/20は点検のため15時まで）" className="rounded-lg border border-line-input px-3 py-2.5 text-sm leading-relaxed" />
            <label className="flex items-center gap-2 text-sm">
              <UploadIcon />
              ファイル（PDF・画像・テキスト）
              <input name="file" type="file" accept="application/pdf,image/png,image/jpeg,text/plain,.md" className="text-sm" />
            </label>
          </>
        ) : (
          <>
            <input name="url" type="url" required aria-label="URL" placeholder="https://" className={input} />
            <input name="purpose" aria-label="このページで見る内容" placeholder="このページで見る内容（任意）例: 千歳線の運休・遅延" className={input} />
            <label className="flex items-center gap-2 text-sm">
              取得間隔
              <select name="interval_minutes" defaultValue={60} className={`${input} min-h-10`}>
                {INTERVAL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {intervalLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className="mb-1 text-sm">反映のしかた</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="reflect_mode" value="approval" defaultChecked className="mt-1 size-4" />
                <span>
                  承認して反映
                  <span className="block text-xs text-ink-sub">施設ごとの営業時間などに読み取り、確認・承認してから案内に使います。内容が変わったら読み直し、承認するまで前の内容で案内します（周辺施設・イベントのページなど）</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="reflect_mode" value="auto" className="mt-1 size-4" />
                <span>
                  自動反映
                  <span className="block text-xs text-ink-sub">取得のたびにAIが要約し、承認を待たずに時点付きで案内に使います。変わったら管理PCのバッジと、影響があるときは現場スマホの通知で知らせます（運行情報・天気など）</span>
                </span>
              </label>
            </fieldset>
          </>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input name="is_external" type="checkbox" className="size-4" />
            外部情報（ホテル以外が管理している資料。交通機関・自治体・周辺施設など）
          </label>
          <span className="flex-1" />
          {error && <span role="alert" className="text-sm text-danger">{error}</span>}
          <button type="submit" disabled={pending} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            {pending ? (kind === "url" ? "取得して読み取り中…" : "AIが読み取り中…") : kind === "url" ? "取得して読み取る" : "読み取る"}
          </button>
        </div>
      </form>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        <h2 className="px-5 pt-4 pb-2 text-base font-bold">登録済みの資料（{sources.length}件）</h2>
        {sources.map((s) => (
          <div key={s.id} className="flex items-center gap-3 border-t border-line px-5 py-3 text-sm">
            {(() => {
              const status = s.reflect_mode === "auto" ? AUTO_STATUS : STATUS[s.status];
              return <span className={`shrink-0 rounded px-1.5 text-[11px] ${status.className}`}>{status.label}</span>;
            })()}
            {s.is_external && <span className="shrink-0 rounded border border-line-input px-1.5 text-[11px]">外部</span>}
            {s.url && <span className="shrink-0 rounded border border-line-input px-1.5 text-[11px]">Web</span>}
            {s.unseen_update && <span className="shrink-0 rounded-full bg-caution px-1.5 text-[11px] font-bold text-white">更新あり</span>}
            <Link href={`/admin/knowledge/sources/${s.id}`} className="min-w-0 flex-1 truncate font-bold hover:underline">
              {s.title}
              {s.facilities.length > 0 && <span className="ml-2 font-normal text-ink-sub">{s.facilities.join("・")}</span>}
            </Link>
            {s.url && (
              <span className={`shrink-0 text-xs ${s.last_status === "error" ? "text-danger" : "text-ink-sub"}`}>
                {s.last_status === "error" ? "取得に失敗" : s.last_success_at ? `取得 ${s.last_success_at}` : "未取得"}
              </span>
            )}
            <span className="shrink-0 text-xs text-ink-sub">
              {s.created_by ?? "—"} ・ {s.created_at}
            </span>
            <button
              type="button"
              aria-label={`${s.title}を削除`}
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteInfoSourceAction(s.id)))}
              className="min-h-9 w-9 shrink-0 rounded-lg text-ink-sub hover:bg-canvas"
              title="削除すると、この資料から読み取った内容も案内から外れます"
            >
              ×
            </button>
          </div>
        ))}
        {sources.length === 0 && <p className="border-t border-line px-5 py-3 text-sm text-ink-sub">まだ資料はありません</p>}
      </section>
    </main>
  );
}
