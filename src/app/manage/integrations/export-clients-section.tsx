"use client";

import { useState, useTransition } from "react";
import type { ExportClient } from "@/server/export-clients";
import { deleteExportClientAction, saveExportClientAction } from "../actions";
import { tr } from "@/lib/i18n";

const EMPTY = { name: "", tokenEnv: "", active: true, canRead: true };

// 実績の出力口のMCP（/api/mcp/work-events）に接続してくる外部システム。接続元ごとのトークンで特定し、呼び出しは監査ログに残す
export function ExportClientsSection({ clients }: { clients: ExportClient[] }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (c?: ExportClient) => {
    setEditing(c?.id ?? "new");
    setForm(c ? { name: c.display_name, tokenEnv: c.token_env ?? "", active: c.active, canRead: c.can_read } : EMPTY);
    setMessage(null);
  };
  const save = () =>
    startTransition(async () => {
      const r = await saveExportClientAction(editing === "new" ? null : editing, form);
      if (!r.ok) return setMessage({ kind: "error", text: r.error });
      setEditing(null);
      setMessage({ kind: "ok", text: tr("保存しました", "Saved") });
    });

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">{tr("実績の出力口（MCPの接続元）", "Work data export (MCP clients)")}</h2>
        <p className="text-xs leading-relaxed text-ink-sub">
          {tr("既存の管理システムや別のAIエージェントが、実績を ", "Existing management systems or other AI agents read work data directly from ")}
          <code className="font-mono">/api/mcp/work-events</code>
          {tr(
            " から直接読み取ります。接続元ごとにトークンを分け（サーバーの環境変数に置き、DBには保存しません）、呼び出しは監査ログに残します。",
            ". Each client gets its own token (kept in a server environment variable, never in the DB), and every call is audit-logged.",
          )}
        </p>
      </div>
      {clients.map((c) =>
        editing === c.id ? (
          <ClientForm key={c.id} form={form} setForm={setForm} pending={pending} onSave={save} onCancel={() => setEditing(null)} />
        ) : (
          <div key={c.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-sm">
            <strong className="min-w-0 flex-1">{c.display_name}</strong>
            <span className="font-mono text-xs text-ink-sub">{c.token_env ?? tr("トークン未設定", "No token")}</span>
            {!c.token_set && <span className="rounded-md bg-danger-soft px-2 py-0.5 text-xs text-danger">{tr("環境変数が未設定", "Env var not set")}</span>}
            <span className={`rounded-md px-2 py-0.5 text-xs ${c.active && c.can_read ? "bg-primary-soft text-primary" : "bg-muted text-ink-sub"}`}>
              {!c.active ? tr("停止中", "Paused") : c.can_read ? tr("実績を読める", "Can read data") : tr("権限なし", "No permission")}
            </span>
            <span className="text-xs text-ink-sub">{tr("最終接続 ", "Last connected ")}{c.last_used ?? "—"}</span>
            <button type="button" onClick={() => open(c)} className="min-h-9 rounded-lg border border-line-input px-3 text-xs">
              {tr("変更", "Edit")}
            </button>
            <button
              type="button"
              aria-label={tr(`${c.display_name}を削除`, `Delete ${c.display_name}`)}
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteExportClientAction(c.id)))}
              className="min-h-9 w-9 text-ink-sub"
            >
              ×
            </button>
          </div>
        ),
      )}
      {clients.length === 0 && editing !== "new" && <p className="text-sm text-ink-sub">{tr("接続元はありません", "No clients")}</p>}
      {editing === "new" ? (
        <ClientForm form={form} setForm={setForm} pending={pending} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" onClick={() => open()} className="min-h-11 self-start rounded-[10px] border border-dashed border-[#BDB6AA] px-4 text-sm text-ink-sub">
          {tr("＋ 接続元を追加", "+ Add client")}
        </button>
      )}
      {message && <p className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
    </section>
  );
}

function ClientForm({
  form,
  setForm,
  pending,
  onSave,
  onCancel,
}: {
  form: typeof EMPTY;
  setForm: (f: typeof EMPTY) => void;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-canvas p-3.5">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-sub">
          {tr("接続元の名前", "Client name")}
          <input value={form.name} placeholder={tr("既存の管理システム", "Existing management system")} onChange={(e) => setForm({ ...form, name: e.target.value })} className="min-h-10 rounded-lg border border-line-input bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary" />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-sub">
          {tr("Bearerトークンの環境変数", "Bearer token env var")}
          <input value={form.tokenEnv} placeholder="EXPORT_MCP_TOKEN" onChange={(e) => setForm({ ...form, tokenEnv: e.target.value })} className="min-h-10 rounded-lg border border-line-input bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-primary" />
        </label>
      </div>
      <label className="flex min-h-10 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={form.canRead} onChange={(e) => setForm({ ...form, canRead: e.target.checked })} className="size-5 accent-primary" />
        {tr("実績・オーダー状況を読み取れる", "Can read work data and order status")}
      </label>
      <label className="flex min-h-10 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="size-5 accent-primary" />
        {tr("この接続元を使う（外すと接続できません）", "Enabled (uncheck to block connections)")}
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-line-input px-3 text-sm">
          {tr("やめる", "Cancel")}
        </button>
        <button type="button" disabled={pending} onClick={onSave} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-bold text-white disabled:opacity-40">
          {tr("保存", "Save")}
        </button>
      </div>
    </div>
  );
}
