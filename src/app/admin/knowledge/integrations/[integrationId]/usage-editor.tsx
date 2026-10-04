"use client";

import { useState, useTransition } from "react";
import type { UsageDetail } from "@/server/integrations-admin";
import { decideWriteAction, saveUsageRuleAction } from "../../../actions";
import { roomLabel, tr } from "@/lib/i18n";

const ROLE_LABELS: Record<string, string> = {
  reservation: tr("会話の最初に予約を確かめる", "Checks the reservation at the start of a chat"),
  search: tr("AI相談でゲストを探す", "Finds guests in staff AI"),
  preload: tr("ゲストの情報として毎回読む", "Always read as guest info"),
};
const PURPOSE_LABELS: Record<string, string> = {
  guest_context: tr("ゲストの情報の取得", "Guest info"),
  search: tr("予約の検索", "Reservation search"),
  agent: tr("AIの判断", "AI decision"),
  confirmed: tr("確認して送った", "Sent after confirmation"),
};
const STATUS: Record<string, { label: string; className: string }> = {
  pending_confirm: { label: tr("確認待ち", "To confirm"), className: "bg-caution-soft text-caution" },
  held: { label: tr("送れなかった", "Failed to send"), className: "bg-danger-soft text-danger" },
  written: { label: tr("書き込み済み", "Written"), className: "bg-primary-soft text-primary" },
  rejected: { label: tr("取りやめ", "Cancelled"), className: "bg-muted text-ink-sub" },
};

export function UsageEditor({ usage, canEditRule, canConfirm }: { usage: UsageDetail; canEditRule: boolean; canConfirm: boolean }) {
  const [rule, setRule] = useState(usage.rule);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const r = await saveUsageRuleAction(usage.id, rule);
      if (!r.ok) return setMessage({ kind: "error", text: r.error });
      setDirty(false);
      setMessage(
        r.data?.checksUpdated
          ? { kind: "ok", text: tr("保存しました。次の応答から使います。", "Saved. Applies from the next reply.") }
          : { kind: "error", text: tr("保存しました。ただし、チェックする項目を更新できませんでした（前の項目のまま）。もう一度保存してください。", "Saved, but the check items couldn't be updated (the previous ones remain). Please save again.") },
      );
    });

  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">{tr("AIが使えること", "What the AI can do")}</h2>
          <span className="text-xs text-ink-sub">{tr("システムの担当者が経営画面の外部連携で許可したものです。説明は相手のシステムが公開しているもの", "Allowed by the system owner under Integrations. Descriptions come from the connected system")}</span>
        </div>
        {usage.tools.map((t) => (
          <div key={t.name} className="flex flex-col gap-1 border-t border-line py-2.5 text-sm">
            <strong>{t.description || t.name}</strong>
            <span className="text-xs text-ink-sub">
              <code className="font-mono">{t.name}</code>
              {t.role ? ` ・ ${ROLE_LABELS[t.role]}` : tr(" ・ AIが必要に応じて使う", " · AI uses as needed")}
              {t.require_staff_confirm ? tr(" ・ スタッフの確認後に送る", " · sent after staff confirm") : ""}
            </span>
          </div>
        ))}
        {usage.tools.length === 0 && <p className="text-sm text-ink-sub">{tr("AIが使えることはありません", "Nothing allowed")}</p>}
        {usage.hiddenTools > 0 && <p className="text-xs text-ink-sub">{tr(`ほかに、AIに使わせていない機能が${usage.hiddenTools}件あります`, `${usage.hiddenTools} more tools are not available to the AI`)}</p>}
      </section>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="rule" className="text-base font-bold">
            {tr("利用ルール", "Usage rules")}
          </label>
          {canEditRule && (
            <button type="button" disabled={!dirty || pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
              {pending ? tr("保存しています…", "Saving…") : tr("保存して適用", "Save and apply")}
            </button>
          )}
        </div>
        <textarea
          id="rule"
          rows={9}
          value={rule}
          readOnly={!canEditRule}
          placeholder={tr("例: お客様メモの「記念日」は案内に使ってよい。引き継いだ案件は、ご要望の要約と引き継ぎ先を1行で追記する", "e.g. The \"anniversary\" field in guest notes may be used in replies. For handed-off cases, append a one-line summary and who it went to")}
          onChange={(e) => (setRule(e.target.value), setDirty(true), setMessage(null))}
          className="w-full rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none read-only:bg-canvas focus:border-primary"
        />
        <p className="text-xs leading-relaxed text-ink-sub">
          {tr(
            "読むときの使い方と、書くときの書き方を、いまの運用ルールのまま書いてください。左の説明で足りないこと（どの欄を何に使うか、いつ書くか）を補ってください。",
            "Write how to use what is read and how to write, as you operate today. Fill in what the descriptions on the left don't cover (which field is for what, when to write).",
          )}
        </p>
        {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{tr("AIが回答の後に重点チェックすること", "What a second AI checks before replies go out")}</h3>
          {usage.checks.map((c) => (
            <p key={c.id} className="rounded-lg bg-caution-soft px-3 py-2 text-sm">
              {c.body}
            </p>
          ))}
          {usage.checks.length === 0 && <p className="text-sm text-ink-sub">{tr("ありません", "None")}</p>}
          <p className="text-[11px] text-ink-sub">{tr("保存のたびにAIが利用ルールから抜き出します", "Extracted from the rules by AI each time you save")}</p>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">{tr("スタッフの確認後に送るもの", "Waiting for staff confirmation")}</h2>
          <span className="text-xs text-ink-sub">{tr("確認して送るまで、相手のシステムには届きません", "Nothing reaches the other system until confirmed")}</span>
        </div>
        {usage.writes.map((w) => {
          const status = STATUS[w.status] ?? { label: w.status, className: "bg-muted" };
          return (
            <div key={w.id} className="flex flex-col gap-1.5 border-t border-line py-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">
                  {w.room_number ? `${roomLabel(w.room_number)} ・ ` : ""}
                  {usage.tools.find((t) => t.name === w.tool_name)?.description ?? w.tool_name ?? tr("書き込み", "Write")}
                </span>
                <span className={`rounded-md px-2 py-0.5 text-xs ${status.className}`}>{status.label}</span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-sub">{w.content}</p>
              {w.hold_reason && <p className="text-xs text-danger">{w.hold_reason}</p>}
              {canConfirm && (w.status === "pending_confirm" || w.status === "held") && (
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await decideWriteAction(w.id, false)))} className="min-h-9 rounded-lg border border-line-input px-3 text-xs">
                    {tr("取りやめる", "Cancel")}
                  </button>
                  <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await decideWriteAction(w.id, true)))} className="min-h-9 rounded-lg bg-dark px-3 text-xs font-bold text-white">
                    {tr("確認して書き込む", "Confirm and write")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {usage.writes.length === 0 && <p className="text-sm text-ink-sub">{tr("ありません", "None")}</p>}
      </section>

      <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">{tr("最近の呼び出し", "Recent calls")}</h2>
          <span className="text-xs text-ink-sub">{tr("AIがこのシステムを使った記録です（すべて監査ログに残ります）", "The AI's calls to this system (all audit-logged)")}</span>
        </div>
        {usage.calls.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm">
            <span>
              {usage.tools.find((t) => t.name === c.tool)?.description ?? c.tool}
              <span className="ml-2 text-xs text-ink-sub">
                {PURPOSE_LABELS[c.purpose] ?? c.purpose}
                {c.staff ? `（${c.staff}）` : ""}
              </span>
            </span>
            <span className={`text-xs ${c.ok ? "text-ink-sub" : "text-danger"}`}>
              {c.ok ? "" : tr("失敗 ・ ", "Failed · ")}
              {c.created_at}
            </span>
          </div>
        ))}
        {usage.calls.length === 0 && <p className="text-sm text-ink-sub">{tr("まだありません", "None yet")}</p>}
      </section>
    </div>
  );
}
