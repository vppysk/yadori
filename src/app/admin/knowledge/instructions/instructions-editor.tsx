"use client";

import { useState, useTransition } from "react";
import { saveInstructionsAction } from "../../actions";
import { tr } from "@/lib/i18n";

// 必ず人に引き継ぐ条件（設定では変えられない。guest-chat.ts で常に判定する）
const HANDOFF_CONDITIONS = [
  tr("お客様が「スタッフと話したい」と言った", "The guest asks to talk to staff"),
  tr("強い不満や怒りを検知した", "Strong dissatisfaction or anger is detected"),
  tr("同じ会話で2回答えられなかった", "The AI couldn't answer twice in one conversation"),
  tr("急病・けが・安全に関わる内容", "Illness, injury or safety issues"),
];

export function InstructionsEditor({ initial, checks, fixedChecks }: { initial: string; checks: string[]; fixedChecks: string[] }) {
  const [body, setBody] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const r = await saveInstructionsAction(body);
      if (!r.ok) return setMessage({ kind: "error", text: r.error });
      setDirty(false);
      setMessage(
        r.data?.checksUpdated
          ? { kind: "ok", text: tr("保存しました。次の応答から使います。", "Saved. Applies from the next reply.") }
          : { kind: "error", text: tr("保存しました。ただし、チェックする項目を更新できませんでした（前の項目のまま）。もう一度保存してください。", "Saved, but the check items couldn't be updated (the previous ones remain). Please save again.") },
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 xl:flex-row">
      <section aria-label={tr("指示", "Instructions")} className="flex flex-1 flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="instructions" className="text-base font-bold">
            {tr("ゲスト対応AIへの指示", "Instructions for the guest AI")}
          </label>
          <div className="flex items-center gap-2">
            <button type="button" disabled={!dirty || pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
              {pending ? tr("保存しています…", "Saving…") : tr("保存して適用", "Save and apply")}
            </button>
          </div>
        </div>
        <textarea
          id="instructions"
          rows={16}
          value={body}
          placeholder={tr(
            "例: 丁寧だが堅すぎない言葉づかいで、結論から短く答える。苦情のときは、最初にお詫びし、補償には触れずに担当者から連絡すると伝える",
            "e.g. Be polite but not stiff, and lead with the answer. For complaints, apologize first, don't mention compensation, and say a staff member will follow up",
          )}
          onChange={(e) => (setBody(e.target.value), setDirty(true), setMessage(null))}
          className="w-full flex-1 rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary"
        />
        <p className="text-xs leading-relaxed text-ink-sub">
          {tr(
            "場面によって答え方を変えたいときは「苦情のときは〜」「周辺の案内のときは〜」のように書いてください。館内の営業時間などの情報は、ここではなく資料から登録します。",
            "To vary the style by situation, write things like \"For complaints, ...\" or \"For local recommendations, ...\". Facility hours and similar info go in Sources, not here.",
          )}
        </p>
        {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
      </section>

      <aside aria-label={tr("AIが守ること", "What the AI follows")} className="flex w-full shrink-0 flex-col gap-5 rounded-[14px] border border-line bg-surface px-5.5 py-5 xl:w-[400px]">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">{tr("AIが回答の後に重点チェックすること", "What a second AI checks before replies go out")}</h2>
          <span className="text-xs leading-relaxed text-ink-sub">{tr("回答をお客様に出す前に、別のAIが確かめます。反していれば出さずにスタッフへ引き継ぎます。", "Before a reply reaches the guest, a separate AI checks it. If it breaks a rule, it's held back and handed to staff.")}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{tr("指示から抜き出したこと", "Extracted from your instructions")}</h3>
          {checks.map((c) => (
            <p key={c} className="rounded-lg bg-caution-soft px-3 py-2 text-sm">
              {c}
            </p>
          ))}
          {checks.length === 0 && <p className="text-sm text-ink-sub">{tr("ありません", "None")}</p>}
          <p className="text-[11px] text-ink-sub">{tr("保存のたびにAIが指示から抜き出します。直したいときは指示の書き方を変えてください。", "Extracted by AI each time you save. To change them, reword the instructions.")}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{tr("いつも守ること", "Always enforced")}</h3>
          {fixedChecks.map((c) => (
            <p key={c} className="rounded-lg bg-danger-soft px-3 py-2 text-sm">
              {c}
            </p>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{tr("必ずスタッフに引き継ぐこと", "Always handed to staff")}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {HANDOFF_CONDITIONS.map((c) => (
              <li key={c}>{tr("・", "• ")}{c}</li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
