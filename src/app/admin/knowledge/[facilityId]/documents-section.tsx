"use client";

import { useRef, useState, useTransition } from "react";
import type { DocumentRow } from "@/server/documents";
import { deleteDocumentAction, registerDocumentAction } from "../actions";

export function DocumentsView({ documents }: { documents: DocumentRow[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">館内案内・マニュアル</h1>
        <p className="text-sm text-ink-sub">日付で変わらない説明文（アクセス、館内ルール、設備の使い方、スタッフ向けマニュアル）を登録します。営業時間など期間で変わる情報は「施設・営業情報」へ。</p>
      </div>
      <form
        ref={formRef}
        className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setMessage(null);
          startTransition(async () => {
            const r = await registerDocumentAction(form);
            if (!r.ok) return setMessage({ kind: "error", text: r.error });
            formRef.current?.reset();
            setMessage({ kind: "ok", text: "登録しました。AIの回答とAI相談で参照されます。" });
          });
        }}
      >
        <h2 className="text-base font-bold">登録</h2>
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          タイトル
          <input name="title" required placeholder="例: 清掃マニュアル「連泊対応」" className="min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-sub">
          本文
          <textarea name="text" rows={5} placeholder="本文を貼り付けるか、下でファイルを選んでください" className="rounded-lg border border-line-input px-3 py-2.5 text-sm leading-relaxed text-ink" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            ファイル（PDF・画像・テキスト）
            <input name="file" type="file" accept="application/pdf,image/png,image/jpeg,text/plain,.md" className="text-sm" />
          </label>
          <span className="flex-1" />
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
          <button type="submit" disabled={pending} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
            {pending ? "登録中…" : "登録"}
          </button>
        </div>
      </form>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        <h2 className="px-5 pt-4 pb-2 text-base font-bold">登録済み（{documents.length}件）</h2>
        {documents.map((d) => (
          <div key={d.id} className="flex items-start gap-3 border-t border-line px-5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <strong className="text-sm">{d.title}</strong>
                {d.source === "answered_question" && <span className="rounded bg-primary-soft px-1.5 text-[11px] text-primary">未回答の質問から</span>}
              </div>
              <p className="truncate text-xs text-ink-sub">{d.preview}</p>
            </div>
            <span className="shrink-0 text-xs text-ink-sub">
              {d.chunks}件に分割 ・ {d.created_by ?? "—"} ・ {new Date(d.created_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}
            </span>
            <button
              type="button"
              aria-label={`${d.title}を削除`}
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteDocumentAction(d.id)))}
              className="min-h-9 w-9 shrink-0 rounded-lg text-ink-sub hover:bg-canvas"
            >
              ×
            </button>
          </div>
        ))}
      </section>
    </main>
  );
}
