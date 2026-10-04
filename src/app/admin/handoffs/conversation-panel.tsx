"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowIcon } from "@/components/icons";
import { AI_REASONS, ALERT_CATEGORIES, FAILURE_CAUSES, FAILURE_STAGES, HANDOFF_LABELS, alertCategoryOf } from "@/lib/handoff-kinds";
import type { HandoffDetail } from "@/server/staff-work";
import { acceptHandoffAdminAction, closeHandoffAdminAction, replyHandoffAdminAction } from "../actions";
import { ConversationMessages } from "../conversation-messages";
import { roomLabel, tr } from "@/lib/i18n";

// ゲストの新しい発言を拾うための再取得間隔（ゲスト画面と同じ）
const POLL_MS = 15_000;
const WRITES: Record<string, string> = {
  pending_confirm: tr("お客様メモ: 確認待ち", "Guest note: awaiting confirmation"),
  held: tr("お客様メモ: 保留", "Guest note: on hold"),
  written: tr("お客様メモに記録済み", "Saved to guest note"),
  rejected: tr("お客様メモ: 取りやめ", "Guest note: cancelled"),
};

// 対応アラートの右側: そのゲストとの会話を開き、引き継いだ時点のメッセージまでスクロールする。ここから返信すると引き受けたことになる
export function ConversationPanel({ handoff, canReply, closeHref }: { handoff: HandoffDetail; canReply: boolean; closeHref: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = handoff.status === "open" || handoff.status === "accepted";
  const category = alertCategoryOf(handoff.kind);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? tr("操作できませんでした", "Couldn't complete that"));
      else onDone?.();
    });
  }

  return (
    <>
      <header className="flex flex-col gap-2 border-b border-line px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-bold">{handoff.room_number ? roomLabel(handoff.room_number) : tr("引き継ぎ", "Handoff")}</h2>
            <p className="text-[13px] text-ink-sub">
              {category ? ALERT_CATEGORIES[category].label : HANDOFF_LABELS[handoff.kind]}
              {category === "ai" ? tr(`（${AI_REASONS[handoff.kind]}）`, ` (${AI_REASONS[handoff.kind]})`) : ""}
              {handoff.accepted_by_name ? tr(` ・ ${handoff.accepted_by_name}が引き受け`, ` · taken by ${handoff.accepted_by_name}`) : ""}
            </p>
          </div>
          <Link href={closeHref} scroll={false} aria-label={tr("会話を閉じる", "Close conversation")} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-ink-sub hover:bg-canvas">
            ×
          </Link>
        </div>
        {(handoff.kind === "system_error" || handoff.kind === "guardrail_blocked") && <FailureBox handoff={handoff} />}
        {handoff.write_status && <p className="text-xs text-ink-sub">{WRITES[handoff.write_status] ?? handoff.write_status}</p>}
        {canReply && active && (
          <div className="flex gap-2">
            {handoff.status === "open" && (
              <button type="button" disabled={pending} onClick={() => run(() => acceptHandoffAdminAction(handoff.id))} className="min-h-11 flex-1 rounded-lg bg-dark text-sm font-bold text-white disabled:opacity-50">
                {tr("引き受ける", "Take it")}
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => run(() => closeHandoffAdminAction(handoff.id))} className="min-h-11 flex-1 rounded-lg border border-line-input text-sm disabled:opacity-50">
              {tr("対応完了にする", "Mark as done")}
            </button>
          </div>
        )}
        {handoff.status === "cancelled" && <p className="text-[13px] text-ink-sub">{tr("ゲストがスタッフへの依頼を取り消しました。対応は不要です。", "The guest cancelled the request for staff. No action needed.")}</p>}
      </header>

      <ConversationMessages messages={handoff.messages} targetId={handoff.target_message_id} targetLabel={tr("ここで引き継ぎ", "Handed off here")} />

      {error && <p role="alert" className="bg-danger-soft px-4 py-2 text-xs text-danger">{error}</p>}
      {canReply && active && handoff.conversation_id && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => replyHandoffAdminAction(handoff.id, text), () => setText(""));
          }}
          className="flex items-center gap-2 border-t border-line bg-surface px-4 py-3"
        >
          <label htmlFor="handoff-reply" className="sr-only">{tr("ゲストへの返信", "Reply to guest")}</label>
          <input
            id="handoff-reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={handoff.status === "open" ? tr("返信すると引き受けたことになります", "Replying means you take this on") : tr("ゲストに返信する", "Reply to the guest")}
            className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
          />
          <button type="submit" aria-label={tr("送信", "Send")} disabled={pending || !text.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-dark text-white disabled:opacity-40">
            <ArrowIcon />
          </button>
        </form>
      )}
    </>
  );
}

// システムの不具合の原因と、禁止事項で止めた回答
function FailureBox({ handoff }: { handoff: HandoffDetail }) {
  const isError = handoff.kind === "system_error";
  return (
    <div className={`flex flex-col gap-1 rounded-lg px-3 py-2 text-xs leading-relaxed ${isError ? "bg-danger-soft text-danger" : "bg-muted"}`}>
      {isError ? (
        <p>
          <strong>{tr("システムの不具合: ", "System error: ")}</strong>
          {FAILURE_CAUSES[handoff.failure_cause ?? "unknown"]}
          {handoff.failure_stage ? ` (${FAILURE_STAGES[handoff.failure_stage]})` : ""}
          {handoff.model_id ? ` ・ ${handoff.model_id}` : ""}
        </p>
      ) : (
        <p>
          <strong>{tr("禁止事項に反したため、AIの回答をゲストに出していません", "The AI reply broke a rule, so it was not sent to the guest")}</strong>
        </p>
      )}
      {handoff.failure_detail && (
        <details>
          <summary className="cursor-pointer">{isError ? tr("エラーの詳細", "Error details") : tr("理由と止めた回答", "Reason and blocked reply")}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-ink">{handoff.failure_detail}</pre>
        </details>
      )}
    </div>
  );
}
