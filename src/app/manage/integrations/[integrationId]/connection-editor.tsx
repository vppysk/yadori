"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ToolRole } from "@/server/integrations/mcp";
import type { ConnectionDetail, ToolSetting } from "@/server/integrations-admin";
import { saveConnectionAction, syncIntegrationAction } from "../../actions";

const ROLE_OPTIONS: { value: ToolRole | ""; label: string }[] = [
  { value: "", label: "AIが必要に応じて選ぶ" },
  { value: "reservation", label: "ゲストの予約の取得" },
  { value: "search", label: "予約の検索（AI相談）" },
  { value: "preload", label: "ゲストの情報として毎回読む" },
];

// 連携先の接続と、AIに使わせるツール（ツール1つ＝権限1つ。plan 4.8）。プロンプトでは越えられない制限なので、知見のある人が設定する
export function ConnectionEditor({ detail }: { detail: ConnectionDetail }) {
  const [name, setName] = useState(detail.name);
  const [endpointEnv, setEndpointEnv] = useState(detail.endpoint_env ?? "");
  const [tokenEnv, setTokenEnv] = useState(detail.token_env ?? "");
  const [active, setActive] = useState(detail.active);
  const [tools, setTools] = useState(detail.tools);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const touch = () => (setDirty(true), setMessage(null));
  const setTool = (toolName: string, patch: Partial<ToolSetting>) => (setTools((prev) => prev.map((t) => (t.name === toolName ? { ...t, ...patch } : t))), touch());

  const save = () =>
    startTransition(async () => {
      const r = await saveConnectionAction(detail.id, {
        name, endpointEnv, tokenEnv, active,
        tools: tools.map((t) => ({ name: t.name, aiEnabled: t.ai_enabled, access: t.access, role: t.role, requireStaffConfirm: t.require_staff_confirm })),
      });
      if (r.ok) {
        setDirty(false);
        setMessage({ kind: "ok", text: "保存しました。変更履歴に記録しています。" });
      } else setMessage({ kind: "error", text: r.error });
    });
  const sync = () =>
    startTransition(async () => {
      const r = await syncIntegrationAction(detail.id);
      setMessage(r.ok ? { kind: "ok", text: "ツールの一覧を取得し直しました。" } : { kind: "error", text: r.error });
    });

  const text = (label: string, value: string, set: (v: string) => void, placeholder = "") => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-sub">
      {label}
      <input value={value} placeholder={placeholder} onChange={(e) => (set(e.target.value), touch())} className="min-h-10 rounded-lg border border-line-input px-2.5 text-sm text-ink outline-none focus:border-primary" />
    </label>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button type="button" disabled={pending} onClick={sync} className="min-h-11 rounded-[10px] border border-line-input bg-surface px-4 text-sm font-bold disabled:opacity-40">
          ツールを取得し直す
        </button>
        <button type="button" disabled={!dirty || pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
          保存して適用
        </button>
      </div>

      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">接続</h2>
          <span className={`rounded-md px-2 py-0.5 text-xs ${detail.status.ok ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger"}`}>
            {detail.status.ok ? "つながっています" : "つながりません"}
          </span>
        </div>
        {!detail.status.ok && <p className="text-xs break-all text-danger">{detail.status.error}</p>}
        <div className="flex flex-wrap gap-3">
          {text("名前", name, setName)}
          {text("接続先のURLの環境変数", endpointEnv, setEndpointEnv, "PMS_MCP_URL")}
          {text("Bearerトークンの環境変数", tokenEnv, setTokenEnv, "PMS_MCP_TOKEN")}
        </div>
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => (setActive(e.target.checked), touch())} className="size-5 accent-primary" />
          この連携先を使う（外すと、AIはこの連携先のツールを使いません）
        </label>
        <p className="text-xs text-ink-sub">
          記号 <code className="font-mono">{detail.slug}</code> ・ 権限のキーは <code className="font-mono">integration.{detail.slug}.ツール名</code>
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">AIに使わせるツール</h2>
          <p className="text-xs leading-relaxed text-ink-sub">
            チェックしたツールだけをAIエージェントに許可します（プロンプトでは越えられない制限）。予約番号・ホテルIDはシステムがゲスト本人の値で固定し、書き込みは記録してから送ります。
            クレーム・オーダーの遅延の書き込みは、常にスタッフの確認後に送ります。使い方（利用ルール）は現場が
            <Link href={`/admin/knowledge/integrations/${detail.id}`} className="mx-0.5 font-bold text-primary underline">
              管理PCのAIの設定
            </Link>
            で書きます。
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-sub">
                <th className="py-2 font-normal">AIに使わせる</th>
                <th className="py-2 font-normal">ツール（MCPの説明）</th>
                <th className="py-2 font-normal">種類</th>
                <th className="py-2 font-normal">使い方</th>
                <th className="py-2 font-normal">書き込みはスタッフの確認後</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name} className="border-t border-line align-top">
                  <td className="py-2.5">
                    <input type="checkbox" aria-label={`${t.name}をAIに使わせる`} checked={t.ai_enabled} onChange={(e) => setTool(t.name, { ai_enabled: e.target.checked })} className="size-5 accent-primary" />
                  </td>
                  <td className="py-2.5 pr-3">
                    <code className="font-mono text-[13px] font-bold">{t.name}</code>
                    <p className="text-xs leading-relaxed text-ink-sub">{t.description || "（説明なし）"}</p>
                  </td>
                  <td className="py-2.5">
                    <select value={t.access} onChange={(e) => setTool(t.name, { access: e.target.value as ToolSetting["access"] })} className="min-h-9 rounded-lg border border-line-input px-2">
                      <option value="read">読み取り</option>
                      <option value="write">書き込み</option>
                    </select>
                  </td>
                  <td className="py-2.5">
                    <select value={t.role ?? ""} onChange={(e) => setTool(t.name, { role: (e.target.value || null) as ToolRole | null })} className="min-h-9 rounded-lg border border-line-input px-2">
                      {ROLE_OPTIONS.filter((o) => t.access === "read" || o.value === "").map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`${t.name}の書き込みを常にスタッフが確認`}
                      disabled={t.access !== "write"}
                      checked={t.require_staff_confirm}
                      onChange={(e) => setTool(t.name, { require_staff_confirm: e.target.checked })}
                      className="size-5 accent-primary disabled:opacity-30"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tools.length === 0 && <p className="text-sm text-ink-sub">ツールがありません。「ツールを取得し直す」で相手のMCPサーバーから一覧を取得します。</p>}
        <ul className="flex flex-col gap-1 text-xs text-ink-sub">
          <li>・ゲストの予約の取得: 会話の最初にシステムが呼ぶ（本人確認に当たるため、AIには選ばせない）。料金などの使わない項目はここで落とします</li>
          <li>・ゲストの情報として毎回読む: お客様メモなど。ゲスト対応とAI相談で、予約番号だけで読めるもの</li>
          <li>・スタッフのAI相談では、相談する人にも同じツールの権限が要ります（メンバーと権限で、グループか個人に付けます）。AI相談からは読み取りだけで、書き込みはしません</li>
          <li>・AIが必要に応じて選ぶ: 連携係が発言に応じて選びます。返ってきた内容はそのままAIに渡るため、料金など渡したくない項目を返すツールは許可しないでください</li>
        </ul>
      </section>
    </div>
  );
}
