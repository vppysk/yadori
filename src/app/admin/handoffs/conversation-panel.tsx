"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowIcon } from "@/components/icons";
import { AI_REASONS, ALERT_CATEGORIES, FAILURE_CAUSES, FAILURE_STAGES, HANDOFF_LABELS, alertCategoryOf } from "@/lib/handoff-kinds";
import type { HandoffDetail } from "@/server/staff-work";
import { acceptHandoffAdminAction, closeHandoffAdminAction, replyHandoffAdminAction } from "../actions";

// ゲストの新しい発言を拾うための再取得間隔（ゲスト画面と同じ）
const POLL_MS = 15_000;
const ROLE_LABELS = { user: "ゲスト", assistant: "AI", staff: "スタッフ" } as const;
const WRITES: Record<string, string> = { pending_confirm: "お客様メモ: 確認待ち", held: "お客様メモ: 保留", written: "お客様メモに記録済み", rejected: "お客様メモ: 取りやめ" };

// 対応アラートの右側: そのゲストとの会話を開き、引き継いだ時点のメッセージまでスクロールする。ここから返信すると引き受けたことになる
export function ConversationPanel({ handoff, canReply, closeHref }: { handoff: HandoffDetail; canReply: boolean; closeHref: string }) {
  const router = useRouter();
  const listRef = useRef<HTMLOListElement>(null);
  const targetRef = useRef<HTMLLIElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = handoff.status === "open" || handoff.status === "accepted";
  const category = alertCategoryOf(handoff.kind);

  // パネルの中だけをスクロールする（scrollIntoView はページ全体も動かすため使わない）
  useEffect(() => {
    const list = listRef.current;
    const target = targetRef.current;
    if (!list) return;
    list.scrollTop = target ? target.offsetTop - (list.clientHeight - target.offsetHeight) / 2 : list.scrollHeight;
  }, [handoff.id]);

  // 開いた後に届いたメッセージ（自分の返信・ゲストの新しい発言）は一番下まで送って見せる
  const messageCount = handoff.messages.length;
  const shownCount = useRef(messageCount);
  useEffect(() => {
    const list = listRef.current;
    if (list && messageCount > shownCount.current) list.scrollTop = list.scrollHeight;
    shownCount.current = messageCount;
  }, [messageCount]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "操作できませんでした");
      else onDone?.();
    });
  }

  return (
    <>
      <header className="flex flex-col gap-2 border-b border-line px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-bold">{handoff.room_number ? `${handoff.room_number}号室` : "引き継ぎ"}</h2>
            <p className="text-[13px] text-ink-sub">
              {category ? ALERT_CATEGORIES[category].label : HANDOFF_LABELS[handoff.kind]}
              {category === "ai" ? `（${AI_REASONS[handoff.kind]}）` : ""}
              {handoff.accepted_by_name ? ` ・ ${handoff.accepted_by_name}が引き受け` : ""}
            </p>
          </div>
          <Link href={closeHref} scroll={false} aria-label="会話を閉じる" className="flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-ink-sub hover:bg-canvas">
            ×
          </Link>
        </div>
        {(handoff.kind === "system_error" || handoff.kind === "guardrail_blocked") && <FailureBox handoff={handoff} />}
        {handoff.write_status && <p className="text-xs text-ink-sub">{WRITES[handoff.write_status] ?? handoff.write_status}</p>}
        {canReply && active && (
          <div className="flex gap-2">
            {handoff.status === "open" && (
              <button type="button" disabled={pending} onClick={() => run(() => acceptHandoffAdminAction(handoff.id))} className="min-h-11 flex-1 rounded-lg bg-dark text-sm font-bold text-white disabled:opacity-50">
                引き受ける
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => run(() => closeHandoffAdminAction(handoff.id))} className="min-h-11 flex-1 rounded-lg border border-line-input text-sm disabled:opacity-50">
              対応完了にする
            </button>
          </div>
        )}
        {handoff.status === "cancelled" && <p className="text-[13px] text-ink-sub">ゲストがスタッフへの依頼を取り消しました。対応は不要です。</p>}
      </header>

      <ol ref={listRef} className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-canvas px-4 py-4">
        {handoff.messages.map((m) => {
          const target = m.id === handoff.target_message_id;
          return (
            <li
              key={m.id}
              ref={target ? targetRef : undefined}
              className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
                m.role === "user" ? "self-start border border-line bg-surface" : "self-end bg-muted"
              } ${target ? "ring-2 ring-primary" : ""}`}
            >
              <span className="block text-[11px] text-ink-sub">
                {ROLE_LABELS[m.role]} ・ {new Date(m.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {target ? " ・ ここで引き継ぎ" : ""}
              </span>
              {m.content}
            </li>
          );
        })}
        {handoff.messages.length === 0 && <li className="text-sm text-ink-sub">会話はありません</li>}
      </ol>

      {error && <p role="alert" className="bg-danger-soft px-4 py-2 text-xs text-danger">{error}</p>}
      {canReply && active && handoff.conversation_id && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => replyHandoffAdminAction(handoff.id, text), () => setText(""));
          }}
          className="flex items-center gap-2 border-t border-line bg-surface px-4 py-3"
        >
          <label htmlFor="handoff-reply" className="sr-only">ゲストへの返信</label>
          <input
            id="handoff-reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={handoff.status === "open" ? "返信すると引き受けたことになります" : "ゲストに返信する"}
            className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
          />
          <button type="submit" aria-label="送信" disabled={pending || !text.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-dark text-white disabled:opacity-40">
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
          <strong>システムの不具合: </strong>
          {FAILURE_CAUSES[handoff.failure_cause ?? "unknown"]}
          {handoff.failure_stage ? `（${FAILURE_STAGES[handoff.failure_stage]}）` : ""}
          {handoff.model_id ? ` ・ ${handoff.model_id}` : ""}
        </p>
      ) : (
        <p><strong>禁止事項に反したため、AIの回答をゲストに出していません</strong></p>
      )}
      {handoff.failure_detail && (
        <details>
          <summary className="cursor-pointer">{isError ? "エラーの詳細" : "理由と止めた回答"}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-ink">{handoff.failure_detail}</pre>
        </details>
      )}
    </div>
  );
}
