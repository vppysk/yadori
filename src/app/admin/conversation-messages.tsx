"use client";

import { useEffect, useRef } from "react";

const ROLE_LABELS = { user: "ゲスト", assistant: "AI", staff: "スタッフ" } as const;

export type PanelMessage = { id: string; role: "user" | "assistant" | "staff"; content: string; created_at: string };

// 会話の表示（対応アラートの会話パネル、未回答の質問の根拠）。対象のメッセージに枠を付け、パネルの中だけをそこまでスクロールする
// （scrollIntoView はページ全体も動かすため使わない）。開いた後に届いたメッセージは一番下まで送って見せる
export function ConversationMessages({ messages, targetId, targetLabel }: { messages: PanelMessage[]; targetId: string | null; targetLabel: string }) {
  const listRef = useRef<HTMLOListElement>(null);
  const targetRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const target = targetRef.current;
    if (!list) return;
    list.scrollTop = target ? target.offsetTop - (list.clientHeight - target.offsetHeight) / 2 : list.scrollHeight;
  }, [targetId]);

  const messageCount = messages.length;
  const shownCount = useRef(messageCount);
  useEffect(() => {
    const list = listRef.current;
    if (list && messageCount > shownCount.current) list.scrollTop = list.scrollHeight;
    shownCount.current = messageCount;
  }, [messageCount]);

  return (
    <ol ref={listRef} className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-canvas px-4 py-4">
      {messages.map((m) => {
        const target = m.id === targetId;
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
              {target ? ` ・ ${targetLabel}` : ""}
            </span>
            {m.content}
          </li>
        );
      })}
      {messages.length === 0 && <li className="text-sm text-ink-sub">会話はありません</li>}
    </ol>
  );
}
