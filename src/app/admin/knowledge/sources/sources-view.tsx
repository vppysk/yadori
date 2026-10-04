"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UploadIcon } from "@/components/icons";
import { INTERVAL_OPTIONS, intervalLabel } from "@/lib/fetch-intervals";
import type { SourceListItem, SourceStatus } from "@/server/info-sources";
import { createInfoSourceAction, deleteInfoSourceAction } from "../../actions";
import { tr } from "@/lib/i18n";
import { FileField } from "@/components/file-field";

const AUTO_STATUS = { label: tr("自動反映", "Auto"), className: "bg-primary-soft text-primary" };
const STATUS: Record<SourceStatus, { label: string; className: string }> = {
  pending: { label: tr("確認待ち", "To review"), className: "bg-caution text-white" },
  update_pending: { label: tr("更新の確認待ち", "Update to review"), className: "bg-caution text-white" },
  approved: { label: tr("承認済み", "Approved"), className: "bg-primary-soft text-primary" },
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
        <h1 className="text-[22px] font-bold">{tr("資料", "Sources")}</h1>
        <p className="text-sm text-ink-sub">
          {tr(
            "営業案内やお知らせのPDF・画像・文章、またはWebページのURLを登録してください。AIが施設ごとの営業時間やメニューなどを読み取ります。内容を確認して承認すると、ゲストへの案内に使われます。",
            "Add a PDF, image, text or web page URL with opening hours or notices. The AI extracts hours, menus and more for each facility. Once you review and approve, guests get answers based on it.",
          )}
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
            if (!r.ok || !r.data) return setError(r.ok ? tr("登録できませんでした", "Couldn't add it") : r.error);
            router.push(`/admin/knowledge/sources/${r.data}`);
          });
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold">{tr("資料を追加", "Add a source")}</h2>
          <div role="tablist" aria-label={tr("資料の種類", "Source type")} className="flex gap-1 rounded-lg bg-canvas p-1 text-sm">
            {(
              [
                ["file", tr("ファイル・文章", "File or text")],
                ["url", tr("WebページのURL", "Web page URL")],
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
          aria-label={tr("資料の名前", "Source name")}
          placeholder={
            kind === "url"
              ? tr("資料の名前 例: JR北海道 運行情報", "Name, e.g. JR Hokkaido train status")
              : tr("資料の名前（省略するとファイル名）例: 冬季営業のお知らせ", "Name (defaults to file name), e.g. Winter hours notice")
          }
          className={input}
        />
        {kind === "file" ? (
          <>
            <textarea name="text" rows={3} aria-label={tr("文章", "Text")} placeholder={tr("ファイルがないときは、ここに文章を入力（例: 大浴場は6:00〜24:00。10/20は点検のため15時まで）", "No file? Type the text here (e.g. Onsen 6:00–24:00. Closes at 15:00 on 10/20 for maintenance)")} className="rounded-lg border border-line-input px-3 py-2.5 text-sm leading-relaxed" />
            <label className="flex items-center gap-2 text-sm">
              <UploadIcon />
              {tr("ファイル（PDF・画像・テキスト）", "File (PDF, image, text)")}
              <FileField name="file" accept="application/pdf,image/png,image/jpeg,text/plain,.md" />
            </label>
          </>
        ) : (
          <>
            <input name="url" type="url" required aria-label="URL" placeholder="https://" className={input} />
            <input name="purpose" aria-label={tr("このページで見る内容", "What to watch on this page")} placeholder={tr("このページで見る内容（任意）例: 千歳線の運休・遅延", "What to watch (optional), e.g. Chitose Line suspensions")} className={input} />
            <label className="flex items-center gap-2 text-sm">
              {tr("取得間隔", "Fetch interval")}
              <select name="interval_minutes" defaultValue={60} className={`${input} min-h-10`}>
                {INTERVAL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {intervalLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className="mb-1 text-sm">{tr("反映のしかた", "How to apply")}</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="reflect_mode" value="approval" defaultChecked className="mt-1 size-4" />
                <span>
                  {tr("承認して反映", "Apply after approval")}
                  <span className="block text-xs text-ink-sub">
                    {tr(
                      "施設ごとの営業時間などに読み取り、確認・承認してから案内に使います。内容が変わったら読み直し、承認するまで前の内容で案内します（周辺施設・イベントのページなど）",
                      "Extracts hours etc. per facility and uses them after you approve. When the page changes it is re-read, and the previous version is used until you approve (nearby venues, events, etc.)",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="reflect_mode" value="auto" className="mt-1 size-4" />
                <span>
                  {tr("自動反映", "Apply automatically")}
                  <span className="block text-xs text-ink-sub">
                    {tr(
                      "取得のたびにAIが要約し、承認を待たずに時点付きで案内に使います。変わったら管理PCのバッジと、影響があるときは現場スマホの通知で知らせます（運行情報・天気など）",
                      "The AI summarizes each fetch and uses it right away with a timestamp. Changes show a badge here, and staff phones get an alert when there is an impact (train status, weather, etc.)",
                    )}
                  </span>
                </span>
              </label>
            </fieldset>
          </>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input name="is_external" type="checkbox" className="size-4" />
            {tr("外部情報（ホテル以外が管理している資料。交通機関・自治体・周辺施設など）", "External (managed by someone other than the hotel: transport, city, nearby venues, etc.)")}
          </label>
          <span className="flex-1" />
          {error && <span role="alert" className="text-sm text-danger">{error}</span>}
          <button type="submit" disabled={pending} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            {pending
              ? kind === "url"
                ? tr("取得して読み取り中…", "Fetching and reading…")
                : tr("AIが読み取り中…", "AI is reading…")
              : kind === "url"
                ? tr("取得して読み取る", "Fetch and read")
                : tr("読み取る", "Read with AI")}
          </button>
        </div>
      </form>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        <h2 className="px-5 pt-4 pb-2 text-base font-bold">{tr(`登録済みの資料（${sources.length}件）`, `Sources (${sources.length})`)}</h2>
        {sources.map((s) => (
          <div key={s.id} className="flex items-center gap-3 border-t border-line px-5 py-3 text-sm">
            {(() => {
              const status = s.reflect_mode === "auto" ? AUTO_STATUS : STATUS[s.status];
              return <span className={`shrink-0 rounded px-1.5 text-[11px] ${status.className}`}>{status.label}</span>;
            })()}
            {s.is_external && <span className="shrink-0 rounded border border-line-input px-1.5 text-[11px]">{tr("外部", "External")}</span>}
            {s.url && <span className="shrink-0 rounded border border-line-input px-1.5 text-[11px]">Web</span>}
            {s.unseen_update && <span className="shrink-0 rounded-full bg-caution px-1.5 text-[11px] font-bold text-white">{tr("更新あり", "Updated")}</span>}
            <Link href={`/admin/knowledge/sources/${s.id}`} className="min-w-0 flex-1 truncate font-bold hover:underline">
              {s.title}
              {s.facilities.length > 0 && <span className="ml-2 font-normal text-ink-sub">{s.facilities.join(tr("・", ", "))}</span>}
            </Link>
            {s.url && (
              <span className={`shrink-0 text-xs ${s.last_status === "error" ? "text-danger" : "text-ink-sub"}`}>
                {s.last_status === "error" ? tr("取得に失敗", "Fetch failed") : s.last_success_at ? tr(`取得 ${s.last_success_at}`, `Fetched ${s.last_success_at}`) : tr("未取得", "Not fetched")}
              </span>
            )}
            <span className="shrink-0 text-xs text-ink-sub">
              {s.created_by ?? "—"} ・ {s.created_at}
            </span>
            <button
              type="button"
              aria-label={tr(`${s.title}を削除`, `Delete ${s.title}`)}
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteInfoSourceAction(s.id)))}
              className="min-h-9 w-9 shrink-0 rounded-lg text-ink-sub hover:bg-canvas"
              title={tr("削除すると、この資料から読み取った内容も案内から外れます", "Deleting also removes what was extracted from this source")}
            >
              ×
            </button>
          </div>
        ))}
        {sources.length === 0 && <p className="border-t border-line px-5 py-3 text-sm text-ink-sub">{tr("まだ資料はありません", "No sources yet")}</p>}
      </section>
    </main>
  );
}
