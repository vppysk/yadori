"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { GAP_REASON_LABELS, type GapReason } from "@/lib/gap-reasons";
import type { GapEvidence, OpenGap } from "@/server/questions";
import { answerQuestionAction, dismissQuestionAction, getConversationAction } from "../../actions";
import { ConversationMessages, type PanelMessage } from "../../conversation-messages";
import { roomLabel, tr } from "@/lib/i18n";

const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 未回答の質問（会話ログの定期評価で見つけた、AIが答えられなかった質問）。根拠の会話を開いて確かめ、回答すると知識に入る
export function QuestionList({ questions }: { questions: OpenGap[] }) {
  const [openId, setOpenId] = useState<string | null>(questions[0]?.id ?? null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ sourceId: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [conversation, setConversation] = useState<{ evidence: GapEvidence; messages: PanelMessage[] } | null>(null);

  // 回答・案内しないで一覧から消えたら、次の質問を開く
  const currentId = questions.some((q) => q.id === openId) ? openId : (questions[0]?.id ?? null);
  const answerOf = (q: OpenGap) => answers[q.id] ?? q.draft_answer ?? "";

  function submit(q: OpenGap, kind: "answer" | "dismiss") {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      if (kind === "dismiss") {
        const result = await dismissQuestionAction(q.id);
        if (!result.ok) setError(result.error);
        return;
      }
      const result = await answerQuestionAction(q.id, answerOf(q));
      if (!result.ok) return setError(result.error);
      if (result.data?.destination === "source") setNotice({ sourceId: result.data.sourceId });
    });
  }

  function openConversation(evidence: GapEvidence) {
    if (!evidence.conversation_id) return;
    setError(null);
    startTransition(async () => {
      const result = await getConversationAction(evidence.conversation_id!);
      if (!result.ok) return setError(result.error);
      setConversation({ evidence, messages: result.data ?? [] });
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {notice && (
        <p role="status" className="rounded-lg bg-primary-soft px-3 py-2 text-xs leading-relaxed text-primary">
          {tr("期間のある内容のため、資料として登録しました。案内情報で確認してから案内に使います。", "This has a date range, so it was added as a source. Review it before it's used for answers.")}
          <Link href="/admin/knowledge/sources" className="ml-1 font-bold underline underline-offset-2">{tr("資料を確認する", "Review source")}</Link>
        </p>
      )}
      {questions.length === 0 && <p className="text-sm text-ink-sub">{tr("未回答の質問はありません", "No unanswered questions")}</p>}
      {questions.map((q) => {
        const reasons = [...new Set(q.evidences.map((e) => e.reason))];
        if (q.id !== currentId) {
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => {
                setOpenId(q.id);
                setError(null);
              }}
              className="flex min-h-11 items-center justify-between gap-3 border-t border-line px-1 text-left text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{q.question}</span>
              <ReasonLabels reasons={reasons} />
              <span className="shrink-0 text-xs text-ink-sub">{tr(`${q.ask_count}回`, `${q.ask_count}×`)}</span>
            </button>
          );
        }
        return (
          <div key={q.id} className="flex flex-col gap-2 rounded-[10px] bg-caution-soft p-3.5">
            <div className="flex justify-between gap-3 text-sm">
              <strong>{q.question}</strong>
              <span className="shrink-0 text-xs text-ink-sub">{tr(`${q.ask_count}回 ・ 最後 ${fmt(q.last_asked_at)}`, `${q.ask_count}× · last ${fmt(q.last_asked_at)}`)}</span>
            </div>
            {q.evidences.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs">
                {q.evidences.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => openConversation(e)}
                      disabled={!e.conversation_id || pending}
                      className="flex min-h-9 w-full items-center gap-2 rounded-md bg-surface px-2.5 text-left hover:bg-canvas disabled:opacity-60"
                    >
                      <span className="shrink-0 text-ink-sub">{e.room_number ? roomLabel(e.room_number) : "—"} ・ {fmt(e.asked_at)}</span>
                      <span className="shrink-0 rounded border border-line-input px-1.5 py-0.5">{GAP_REASON_LABELS[e.reason]}</span>
                      <span className="min-w-0 flex-1 truncate">{e.question}</span>
                      <span className="shrink-0 font-bold text-primary">{tr("会話を見る", "View chat")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label htmlFor={`ans-${q.id}`} className="flex justify-between text-xs text-ink-sub">
              {tr("回答", "Answer")}
              {q.draft_answer && <span>{tr("スタッフの返信から作った下書き。確認して直してください", "Draft from a staff reply. Please review and edit")}</span>}
            </label>
            <textarea
              id={`ans-${q.id}`}
              rows={3}
              value={answerOf(q)}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              placeholder={tr("例：ペット同伴は不可です。近隣のペットホテルは…", "e.g. Pets aren't allowed. A nearby pet hotel is…")}
              className="w-full rounded-lg border border-line-input bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => submit(q, "dismiss")} className="min-h-10 rounded-lg border border-line-input bg-surface px-3.5 text-sm">
                {tr("案内しない", "Don't answer")}
              </button>
              <button type="button" disabled={pending || !answerOf(q).trim()} onClick={() => submit(q, "answer")} className="min-h-10 rounded-lg bg-dark px-4 text-sm font-bold text-white disabled:opacity-50">
                {tr("回答して登録", "Save answer")}
              </button>
            </div>
          </div>
        );
      })}

      {conversation && (
        <aside aria-label={tr("根拠の会話", "Source conversation")} className="fixed inset-y-0 right-0 z-20 flex w-[420px] max-w-full flex-col border-l border-line bg-surface shadow-xl">
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 pt-5 pb-4">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg font-bold">{conversation.evidence.room_number ? roomLabel(conversation.evidence.room_number) : tr("会話", "Conversation")}</h2>
              <p className="text-[13px] text-ink-sub">{GAP_REASON_LABELS[conversation.evidence.reason]} ・ {tr("読むだけ", "Read only")}</p>
            </div>
            <button type="button" onClick={() => setConversation(null)} aria-label={tr("会話を閉じる", "Close conversation")} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-ink-sub hover:bg-canvas">
              ×
            </button>
          </header>
          <ConversationMessages key={conversation.evidence.id} messages={conversation.messages} targetId={conversation.evidence.message_id} targetLabel={tr("この質問", "This question")} />
        </aside>
      )}
    </div>
  );
}

function ReasonLabels({ reasons }: { reasons: GapReason[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {reasons.slice(0, 2).map((r) => (
        <span key={r} className="rounded border border-line-input px-1.5 py-0.5 text-[11px] text-ink-sub">{GAP_REASON_LABELS[r]}</span>
      ))}
    </span>
  );
}
