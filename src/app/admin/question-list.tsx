"use client";

import { useState, useTransition } from "react";
import type { OpenQuestion } from "@/server/questions";
import { answerQuestionAction, dismissQuestionAction } from "./actions";

export function QuestionList({ questions }: { questions: OpenQuestion[] }) {
  const [openId, setOpenId] = useState<string | null>(questions[0]?.id ?? null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (questions.length === 0) return <p className="text-sm text-ink-sub">未回答の質問はありません</p>;
  // 回答・案内しないで一覧から消えたら、次の質問を開く
  const currentId = questions.some((q) => q.id === openId) ? openId : questions[0].id;

  function submit(id: string, kind: "answer" | "dismiss") {
    setError(null);
    startTransition(async () => {
      const result = kind === "answer" ? await answerQuestionAction(id, answer) : await dismissQuestionAction(id);
      if (!result.ok) setError(result.error);
      else setAnswer("");
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {questions.map((q) =>
        q.id === currentId ? (
          <div key={q.id} className="flex flex-col gap-2 rounded-[10px] bg-caution-soft p-3.5">
            <div className="flex justify-between text-sm">
              <strong>{q.question}</strong>
              <span className="text-xs text-ink-sub">{q.ask_count}回</span>
            </div>
            <label htmlFor={`ans-${q.id}`} className="text-xs text-ink-sub">
              回答
            </label>
            <textarea
              id={`ans-${q.id}`}
              rows={3}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="例：ペット同伴は不可です。近隣のペットホテルは…"
              className="w-full rounded-lg border border-line-input bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => submit(q.id, "dismiss")} className="min-h-10 rounded-lg border border-line-input bg-surface px-3.5 text-sm">
                案内しない
              </button>
              <button type="button" disabled={pending || !answer.trim()} onClick={() => submit(q.id, "answer")} className="min-h-10 rounded-lg bg-dark px-4 text-sm font-bold text-white disabled:opacity-50">
                回答して登録
              </button>
            </div>
          </div>
        ) : (
          <button
            key={q.id}
            type="button"
            onClick={() => {
              setOpenId(q.id);
              setAnswer("");
              setError(null);
            }}
            className="flex min-h-11 items-center justify-between border-t border-line px-1 text-left text-sm"
          >
            {q.question}
            <span className="text-xs text-ink-sub">{q.ask_count}回</span>
          </button>
        ),
      )}
    </div>
  );
}
