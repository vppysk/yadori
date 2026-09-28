"use client";

import { useState, useTransition } from "react";
import type { UsageDetail } from "@/server/integrations-admin";
import { decideWriteAction, saveUsageRuleAction } from "../../../actions";

const ROLE_LABELS: Record<string, string> = {
  reservation: "会話の最初に予約を確かめる",
  search: "AI相談でゲストを探す",
  preload: "ゲストの情報として毎回読む",
};
const STATUS: Record<string, { label: string; className: string }> = {
  pending_confirm: { label: "確認待ち", className: "bg-caution-soft text-caution" },
  held: { label: "送れなかった", className: "bg-danger-soft text-danger" },
  written: { label: "書き込み済み", className: "bg-primary-soft text-primary" },
  rejected: { label: "取りやめ", className: "bg-muted text-ink-sub" },
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
          ? { kind: "ok", text: "保存しました。次の応答から使います。" }
          : { kind: "error", text: "保存しました。ただし、チェックする項目を更新できませんでした（前の項目のまま）。もう一度保存してください。" },
      );
    });

  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">AIが使えること</h2>
          <span className="text-xs text-ink-sub">システムの担当者が経営画面の外部連携で許可したものです。説明は相手のシステムが公開しているもの</span>
        </div>
        {usage.tools.map((t) => (
          <div key={t.name} className="flex flex-col gap-1 border-t border-line py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-md px-2 py-0.5 text-xs ${t.access === "read" ? "bg-muted" : "bg-caution-soft text-caution"}`}>{t.access === "read" ? "読む" : "書く"}</span>
              <strong>{t.description || t.name}</strong>
            </div>
            <span className="text-xs text-ink-sub">
              <code className="font-mono">{t.name}</code>
              {t.role ? ` ・ ${ROLE_LABELS[t.role]}` : " ・ AIが必要に応じて使う"}
              {t.access === "write" && t.require_staff_confirm ? " ・ スタッフの確認後に送る" : ""}
            </span>
          </div>
        ))}
        {usage.tools.length === 0 && <p className="text-sm text-ink-sub">AIが使えることはありません</p>}
        {usage.hiddenTools > 0 && <p className="text-xs text-ink-sub">ほかに、AIに使わせていない機能が{usage.hiddenTools}件あります</p>}
      </section>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="rule" className="text-base font-bold">
            利用ルール
          </label>
          {canEditRule && (
            <button type="button" disabled={!dirty || pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
              {pending ? "保存しています…" : "保存して適用"}
            </button>
          )}
        </div>
        <textarea
          id="rule"
          rows={9}
          value={rule}
          readOnly={!canEditRule}
          placeholder="例: お客様メモの「記念日」は案内に使ってよい。引き継いだ案件は、ご要望の要約と引き継ぎ先を1行で追記する"
          onChange={(e) => (setRule(e.target.value), setDirty(true), setMessage(null))}
          className="w-full rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none read-only:bg-canvas focus:border-primary"
        />
        <p className="text-xs leading-relaxed text-ink-sub">
          読むときの使い方と、書くときの書き方を、いまの運用ルールのまま書いてください。左の説明で足りないこと（どの欄を何に使うか、いつ書くか）を補ってください。
        </p>
        {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">AIが回答の後に重点チェックすること</h3>
          {usage.checks.map((c) => (
            <p key={c.id} className="rounded-lg bg-caution-soft px-3 py-2 text-sm">
              {c.body}
            </p>
          ))}
          {usage.checks.length === 0 && <p className="text-sm text-ink-sub">ありません</p>}
          <p className="text-[11px] text-ink-sub">保存のたびにAIが利用ルールから抜き出します</p>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5 2xl:col-span-2">
        <h2 className="text-base font-bold">最近の書き込み</h2>
        {usage.writes.map((w) => {
          const status = STATUS[w.status] ?? { label: w.status, className: "bg-muted" };
          return (
            <div key={w.id} className="flex flex-col gap-1.5 border-t border-line py-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">
                  {w.room_number ? `${w.room_number}号室 ・ ` : ""}
                  {usage.tools.find((t) => t.name === w.tool_name)?.description ?? w.tool_name ?? "書き込み"}
                </span>
                <span className={`rounded-md px-2 py-0.5 text-xs ${status.className}`}>{status.label}</span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-sub">{w.content}</p>
              {w.hold_reason && <p className="text-xs text-danger">{w.hold_reason}</p>}
              {canConfirm && (w.status === "pending_confirm" || w.status === "held") && (
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await decideWriteAction(w.id, false)))} className="min-h-9 rounded-lg border border-line-input px-3 text-xs">
                    取りやめる
                  </button>
                  <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await decideWriteAction(w.id, true)))} className="min-h-9 rounded-lg bg-dark px-3 text-xs font-bold text-white">
                    確認して書き込む
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {usage.writes.length === 0 && <p className="text-sm text-ink-sub">まだ書き込みはありません</p>}
      </section>
    </div>
  );
}
