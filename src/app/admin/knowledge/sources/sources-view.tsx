"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UploadIcon } from "@/components/icons";
import type { SourceListItem } from "@/server/info-sources";
import { createInfoSourceAction, deleteInfoSourceAction } from "../../actions";

export function SourcesView({ sources }: { sources: SourceListItem[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">資料</h1>
        <p className="text-sm text-ink-sub">
          営業案内やお知らせのPDF・画像、または文章を登録してください。AIが施設ごとの営業時間やメニューなどを読み取ります。内容を確認して承認すると、ゲストへの案内に使われます。
        </p>
      </div>
      <form
        className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setError(null);
          startTransition(async () => {
            const r = await createInfoSourceAction(form);
            if (!r.ok || !r.data) return setError(r.ok ? "登録できませんでした" : r.error);
            router.push(`/admin/knowledge/sources/${r.data}`);
          });
        }}
      >
        <h2 className="text-base font-bold">資料を追加</h2>
        <input name="title" aria-label="資料の名前" placeholder="資料の名前（省略するとファイル名）例: 冬季営業のお知らせ" className="min-h-11 rounded-lg border border-line-input px-3 text-sm" />
        <textarea name="text" rows={3} aria-label="文章" placeholder="ファイルがないときは、ここに文章を入力（例: 大浴場は6:00〜24:00。10/20は点検のため15時まで）" className="rounded-lg border border-line-input px-3 py-2.5 text-sm leading-relaxed" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <UploadIcon />
            ファイル（PDF・画像・テキスト）
            <input name="file" type="file" accept="application/pdf,image/png,image/jpeg,text/plain,.md" className="text-sm" />
          </label>
          <span className="flex-1" />
          {error && <span role="alert" className="text-sm text-danger">{error}</span>}
          <button type="submit" disabled={pending} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            {pending ? "AIが読み取り中…" : "読み取る"}
          </button>
        </div>
      </form>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        <h2 className="px-5 pt-4 pb-2 text-base font-bold">登録済みの資料（{sources.length}件）</h2>
        {sources.map((s) => (
          <div key={s.id} className="flex items-center gap-3 border-t border-line px-5 py-3 text-sm">
            <span className={`shrink-0 rounded px-1.5 text-[11px] ${s.status === "pending" ? "bg-caution text-white" : "bg-primary-soft text-primary"}`}>
              {s.status === "pending" ? "確認待ち" : "承認済み"}
            </span>
            <Link href={`/admin/knowledge/sources/${s.id}`} className="min-w-0 flex-1 truncate font-bold hover:underline">
              {s.title}
              {s.facilities.length > 0 && <span className="ml-2 font-normal text-ink-sub">{s.facilities.join("・")}</span>}
            </Link>
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
