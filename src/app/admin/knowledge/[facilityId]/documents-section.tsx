"use client";

import { useRef, useState, useTransition } from "react";
import type { DocumentRow } from "@/server/documents";
import { deleteDocumentAction, registerDocumentAction } from "../../actions";
import { tr } from "@/lib/i18n";
import { FileField } from "@/components/file-field";

// 「全体」欄の案内・マニュアル（RAG）。日付で変わらない説明文だけを入れる（期間で変わる情報は各施設の営業情報・特記事項へ。plan 4.1）
export function DocumentsSection({ documents }: { documents: DocumentRow[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <h2 className="px-4 pt-3.5 pb-2.5 text-[15px] font-bold">
        {tr("案内・マニュアル", "Guides & manuals")}
        <span className="ml-2.5 text-xs font-normal text-ink-sub">
          {tr(
            "日付で変わらない説明（アクセス、館内ルール、設備の使い方、スタッフ向けマニュアル）。営業時間など期間で変わる情報は各施設へ",
            "Content that doesn't change by date (access, house rules, how-tos, staff manuals). Hours and other seasonal info go to each facility",
          )}
        </span>
      </h2>
      <form
        ref={formRef}
        className="flex flex-col gap-2.5 border-t border-line bg-canvas px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setMessage(null);
          startTransition(async () => {
            const r = await registerDocumentAction(form);
            if (!r.ok) return setMessage({ kind: "error", text: r.error });
            formRef.current?.reset();
            setMessage({ kind: "ok", text: tr("登録しました。AIの回答とAI相談で参照されます。", "Added. Guest answers and staff AI will use it.") });
          });
        }}
      >
        <input name="title" required aria-label={tr("タイトル", "Title")} placeholder={tr("タイトル（例: 清掃マニュアル「連泊対応」）", "Title (e.g. Housekeeping manual: multi-night stays)")} className="min-h-10 rounded-lg border border-line-input bg-surface px-3 text-sm outline-none focus:border-primary" />
        <textarea name="text" rows={4} aria-label={tr("本文", "Text")} placeholder={tr("本文を貼り付けるか、下でファイルを選んでください", "Paste the text, or choose a file below")} className="rounded-lg border border-line-input bg-surface px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-primary" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            {tr("ファイル（PDF・画像・テキスト）", "File (PDF, image, text)")}
            <FileField name="file" accept="application/pdf,image/png,image/jpeg,text/plain,.md" />
          </label>
          <span className="flex-1" />
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
          <button type="submit" disabled={pending} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-bold text-white disabled:opacity-40">
            {pending ? tr("登録中…", "Adding…") : tr("登録して反映", "Add")}
          </button>
        </div>
      </form>
      {documents.map((d) => (
        <div key={d.id} className="flex items-start gap-3 border-t border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <strong className="text-sm">{d.title}</strong>
              {d.source === "answered_question" && <span className="rounded bg-primary-soft px-1.5 text-[11px] text-primary">{tr("未回答の質問から", "From unanswered questions")}</span>}
            </div>
            <p className="truncate text-xs text-ink-sub">{d.preview}</p>
          </div>
          <span className="shrink-0 text-xs text-ink-sub">
            {tr(`${d.chunks}件に分割`, `${d.chunks} chunks`)} ・ {d.created_by ?? "—"} ・ {new Date(d.created_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </span>
          <button
            type="button"
            aria-label={tr(`${d.title}を削除`, `Delete ${d.title}`)}
            disabled={pending}
            onClick={() => startTransition(async () => void (await deleteDocumentAction(d.id)))}
            className="min-h-9 w-9 shrink-0 rounded-lg text-ink-sub hover:bg-canvas"
          >
            ×
          </button>
        </div>
      ))}
      {documents.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">{tr("登録された案内・マニュアルはありません", "No guides or manuals yet")}</p>}
    </section>
  );
}
