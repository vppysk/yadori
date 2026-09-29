"use client";

import { useState, useTransition } from "react";
import type { ExportClient } from "@/server/export-clients";
import { deleteExportClientAction, saveExportClientAction } from "../actions";

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
      setMessage({ kind: "ok", text: "保存しました" });
    });

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">実績の出力口（MCPの接続元）</h2>
        <p className="text-xs leading-relaxed text-ink-sub">
          既存の管理システムや別のAIエージェントが、実績を <code className="font-mono">/api/mcp/work-events</code> から直接読み取ります。接続元ごとにトークンを分け（サーバーの環境変数に置き、DBには保存しません）、呼び出しは監査ログに残します。
        </p>
      </div>
      {clients.map((c) =>
        editing === c.id ? (
          <ClientForm key={c.id} form={form} setForm={setForm} pending={pending} onSave={save} onCancel={() => setEditing(null)} />
        ) : (
          <div key={c.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-sm">
            <strong className="min-w-0 flex-1">{c.display_name}</strong>
            <span className="font-mono text-xs text-ink-sub">{c.token_env ?? "トークン未設定"}</span>
            {!c.token_set && <span className="rounded-md bg-danger-soft px-2 py-0.5 text-xs text-danger">環境変数が未設定</span>}
            <span className={`rounded-md px-2 py-0.5 text-xs ${c.active && c.can_read ? "bg-primary-soft text-primary" : "bg-muted text-ink-sub"}`}>
              {!c.active ? "停止中" : c.can_read ? "実績を読める" : "権限なし"}
            </span>
            <span className="text-xs text-ink-sub">最終接続 {c.last_used ?? "—"}</span>
            <button type="button" onClick={() => open(c)} className="min-h-9 rounded-lg border border-line-input px-3 text-xs">
              変更
            </button>
            <button
              type="button"
              aria-label={`${c.display_name}を削除`}
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteExportClientAction(c.id)))}
              className="min-h-9 w-9 text-ink-sub"
            >
              ×
            </button>
          </div>
        ),
      )}
      {clients.length === 0 && editing !== "new" && <p className="text-sm text-ink-sub">接続元はありません</p>}
      {editing === "new" ? (
        <ClientForm form={form} setForm={setForm} pending={pending} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" onClick={() => open()} className="min-h-11 self-start rounded-[10px] border border-dashed border-[#BDB6AA] px-4 text-sm text-ink-sub">
          ＋ 接続元を追加
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
          接続元の名前
          <input value={form.name} placeholder="既存の管理システム" onChange={(e) => setForm({ ...form, name: e.target.value })} className="min-h-10 rounded-lg border border-line-input bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary" />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-sub">
          Bearerトークンの環境変数
          <input value={form.tokenEnv} placeholder="EXPORT_MCP_TOKEN" onChange={(e) => setForm({ ...form, tokenEnv: e.target.value })} className="min-h-10 rounded-lg border border-line-input bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-primary" />
        </label>
      </div>
      <label className="flex min-h-10 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={form.canRead} onChange={(e) => setForm({ ...form, canRead: e.target.checked })} className="size-5 accent-primary" />
        実績・オーダー状況を読み取れる
      </label>
      <label className="flex min-h-10 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="size-5 accent-primary" />
        この接続元を使う（外すと接続できません）
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-line-input px-3 text-sm">
          やめる
        </button>
        <button type="button" disabled={pending} onClick={onSave} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-bold text-white disabled:opacity-40">
          保存
        </button>
      </div>
    </div>
  );
}
