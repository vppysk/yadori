"use client";

import { useState, useTransition } from "react";
import type { WebhookRow } from "@/server/webhooks";
import { addWebhookAction, deleteWebhookAction, testWebhookAction } from "../actions";
import { tr } from "@/lib/i18n";

// 実績の出力口（plan 4.5）: Webhook の登録。CSV/JSON は経営ダッシュボードの「実績を出力」、MCP は /api/mcp/work-events
export function WebhookSection({ webhooks }: { webhooks: WebhookRow[] }) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">{tr("実績の出力口（Webhook）", "Work data export (webhook)")}</h2>
        <p className="text-xs text-ink-sub">
          {tr(
            "業務1件ごとの実績（パターン・時間帯・担当・トークン・所要時間・コスト・結果）を記録のたびに送ります。本文のHMAC-SHA256を X-Hotel-Agent-Signature に付けます。",
            "Sends each work record (pattern, time band, handler, tokens, duration, cost, outcome) as it is recorded, with an HMAC-SHA256 of the body in X-Hotel-Agent-Signature.",
          )}
        </p>
      </div>
      {webhooks.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{w.url}</span>
          <span className="text-xs text-ink-sub">{tr("シークレット ", "Secret ")}{w.secret_preview}</span>
          <button type="button" disabled={pending} onClick={() => startTransition(async () => {
            const r = await testWebhookAction(w.id);
            setMessage(r.ok ? { kind: "ok", text: tr("テスト送信に成功しました", "Test sent successfully") } : { kind: "error", text: r.error });
          })} className="min-h-9 rounded-lg border border-line-input px-3 text-xs">
            {tr("テスト送信", "Send test")}
          </button>
          <button type="button" aria-label={tr("このWebhookを削除", "Delete this webhook")} disabled={pending} onClick={() => startTransition(async () => void (await deleteWebhookAction(w.id)))} className="min-h-9 w-9 text-ink-sub">
            ×
          </button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          startTransition(async () => {
            const r = await addWebhookAction(url);
            if (!r.ok) return setMessage({ kind: "error", text: r.error });
            setSecret(r.secret);
            setUrl("");
          });
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://example.com/hooks/hotel-agent" className="min-h-10 flex-1 rounded-lg border border-line-input px-3 text-sm" />
        <button type="submit" disabled={pending || !url.trim()} className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub disabled:opacity-40">
          {tr("＋ 登録", "+ Add")}
        </button>
      </form>
      {secret && (
        <p className="rounded-lg bg-caution-soft px-3 py-2 text-xs text-caution">
          {tr("署名の検証用シークレット（この画面を離れると再表示できません）: ", "Signing secret (shown only once): ")}
          <code className="font-mono">{secret}</code>
        </p>
      )}
      {message && <p className={`text-xs ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
    </section>
  );
}
