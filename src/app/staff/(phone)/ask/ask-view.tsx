"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { ArrowIcon } from "@/components/icons";
import type { AskMessage } from "@/server/staff-ask";
import { askAiAction } from "../../actions";

export function AskView({ messages }: { messages: AskMessage[] }) {
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const listRef = useRef<HTMLElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pendingText]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pendingText !== null) return;
    setDraft("");
    setError(null);
    setPendingText(text);
    startTransition(async () => {
      const result = await askAiAction(text);
      if (!result.ok) setError(result.error ?? "送信できませんでした");
      setPendingText(null);
    });
  }

  return (
    <>
      <header className="flex items-center justify-between bg-dark px-5 pt-5 pb-4 text-canvas">
        <h1 className="text-xl font-bold">AIに相談</h1>
        <span className="text-xs text-[#C9CFD1]">館内ルール・マニュアル・特記事項</span>
      </header>
      <main ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4.5">
        {messages.length === 0 && pendingText === null && (
          <p className="mt-6 text-center text-sm leading-relaxed text-ink-sub">わからないことを気軽に聞いてください。</p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <Question key={m.id} text={m.content} />
          ) : (
            <div key={m.id} className="flex max-w-[90%] flex-col gap-2 self-start">
              <div className="whitespace-pre-wrap rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-[15px] leading-[1.7]">{m.content}</div>
              {m.citations?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {m.citations.map((c) => (
                    <span key={c.label} className={`rounded-xl px-2.5 py-1 text-[11px] ${c.kind === "notice" ? "bg-caution-soft text-caution" : "bg-primary-soft text-primary"}`}>
                      {c.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}
        {pendingText !== null && (
          <>
            <Question text={pendingText} />
            <div className="self-start rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-sm text-ink-sub">確認しています…</div>
          </>
        )}
        {error && <p role="alert" className="self-center rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </main>
      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-line bg-surface px-4 py-2.5">
        <label htmlFor="s-msg" className="sr-only">
          質問
        </label>
        <input
          id="s-msg"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="わからないことを聞く"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
        />
        <button type="submit" aria-label="送信" disabled={pendingText !== null || !draft.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-dark text-white disabled:opacity-40">
          <ArrowIcon />
        </button>
      </form>
    </>
  );
}

function Question({ text }: { text: string }) {
  return <div className="max-w-[80%] self-end whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-dark px-3.5 py-3 text-[15px] leading-[1.6] text-white">{text}</div>;
}
