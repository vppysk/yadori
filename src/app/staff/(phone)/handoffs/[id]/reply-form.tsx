"use client";

import { useState, useTransition } from "react";
import { ArrowIcon } from "@/components/icons";
import { replyToGuestAction } from "../../../actions";

export function ReplyForm({ handoffId }: { handoffId: string }) {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          await replyToGuestAction(handoffId, text);
          setText("");
        });
      }}
      className="flex items-center gap-2 border-t border-line bg-surface px-4 py-2.5"
    >
      <label htmlFor="reply" className="sr-only">
        ゲストへの返信
      </label>
      <input
        id="reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ゲストに返信する"
        className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
      />
      <button
        type="submit"
        aria-label="送信"
        disabled={pending || !text.trim()}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-dark text-white disabled:opacity-40"
      >
        <ArrowIcon />
      </button>
    </form>
  );
}
