"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { IntegrationSummary } from "@/server/integrations-admin";
import { addIntegrationAction } from "../actions";

// 連携先の一覧と追加（MCPサーバー）。Webページの取得はサービスの一部として出さない
export function IntegrationsAside({ integrations }: { integrations: IntegrationSummary[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(integrations.length === 0);
  const [form, setForm] = useState({ name: "", slug: "", endpointEnv: "", tokenEnv: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const input = (key: keyof typeof form, label: string, placeholder: string) => (
    <label className="flex flex-col gap-1 text-xs text-ink-sub">
      {label}
      <input value={form[key]} placeholder={placeholder} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="min-h-10 rounded-lg border border-line-input px-2.5 text-sm text-ink outline-none focus:border-primary" />
    </label>
  );

  return (
    <aside aria-label="連携先" className="flex w-full shrink-0 flex-col gap-1.5 xl:w-[260px]">
      <h2 className="px-1 pb-1 text-sm font-bold text-ink-sub">連携先</h2>
      {integrations.map((i) => {
        const href = `/manage/integrations/${i.id}`;
        const active = pathname === href;
        return (
          <Link key={i.id} href={href} aria-current={active ? "page" : undefined} className={`flex min-h-14 flex-col justify-center rounded-xl border px-3.5 ${active ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}>
            <strong className="text-sm">{i.name}</strong>
            <span className="text-xs text-ink-sub">
              MCP ・ AIが使うツール {i.ai_tools}/{i.tools}
              {i.active ? "" : " ・ 停止中"}
            </span>
          </Link>
        );
      })}
      {open ? (
        <form
          className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const r = await addIntegrationAction(form);
              if (!r.ok) return setError(r.error);
              setForm({ name: "", slug: "", endpointEnv: "", tokenEnv: "" });
              setError(null);
              setOpen(false);
              router.push(`/manage/integrations/${r.id}`);
            });
          }}
        >
          <strong className="text-sm">MCPの連携先を追加</strong>
          {input("name", "名前", "アクティビティ予約システム")}
          {input("slug", "記号（権限のキーに使う英小文字）", "activity")}
          {input("endpointEnv", "接続先のURLの環境変数", "ACTIVITY_MCP_URL")}
          {input("tokenEnv", "Bearerトークンの環境変数（任意）", "ACTIVITY_MCP_TOKEN")}
          <p className="text-[11px] leading-relaxed text-ink-sub">URLとトークンはDBに保存せず、サーバーの環境変数から読みます。追加するとツールの一覧を取得します。</p>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            {integrations.length > 0 && (
              <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-lg border border-line-input px-3 text-sm">
                やめる
              </button>
            )}
            <button type="submit" disabled={pending} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-bold text-white disabled:opacity-40">
              追加する
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="min-h-11 rounded-xl border border-dashed border-[#BDB6AA] text-sm text-ink-sub">
          ＋ 連携先を追加
        </button>
      )}
    </aside>
  );
}
