"use client";

import { useState, useTransition } from "react";
import type { GroupRow, MemberRow, MembersData } from "@/server/members";
import { grantPermissionAction, revokeGrantAction, saveGroupAction, setMemberGroupAction } from "../actions";

const KIND_LABEL: Record<MemberRow["kind"], string> = { human: "スタッフ", ai_agent: "AIエージェント", external_system: "外部システム" };
const CATEGORY_LABEL: Record<string, string> = { order: "オーダー", knowledge: "情報", handling: "対応", settings: "設定", integration: "外部連携" };

// 期限の既定は今日の21時（応援の例）
function tonight(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return `${local}T21:00`;
}

export function MembersEditor({ data }: { data: MembersData }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) =>
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? (ok ? { kind: "ok", text: ok } : null) : { kind: "error", text: r.error ?? "失敗しました" });
    });
  const permLabel = (key: string) => data.permissions.find((p) => p.key === key)?.label ?? key;
  const scopeLabel = (ids: string[] | null) => (ids?.length ? ids.map((id) => data.scopes.find((s) => s.id === id)?.label ?? "?").join("、") : "全体");

  return (
    <div className="flex flex-col gap-5">
      {message && <p className={`rounded-lg px-3.5 py-2.5 text-sm ${message.kind === "ok" ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger"}`}>{message.text}</p>}
      <section className="flex flex-col rounded-[14px] border border-line bg-surface">
        <div className="flex flex-col gap-1 px-5 pt-4.5 pb-2">
          <h2 className="text-base font-bold">メンバー</h2>
          <p className="text-xs text-ink-sub">スタッフの権限を管理します（AIに任せる業務は担当範囲とコスト、AIに使わせるツールと実績の出力口の接続元は外部連携で設定します）。実効権限は、所属グループと個別付与の合計です（範囲は広い方が有効、拒否はありません）。</p>
        </div>
        {data.members.map((m) => (
          <MemberCard key={m.id} member={m} data={data} pending={pending} run={run} permLabel={permLabel} scopeLabel={scopeLabel} />
        ))}
      </section>
      <GroupMatrix data={data} pending={pending} run={run} />
    </div>
  );
}

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => void;

function MemberCard({ member: m, data, pending, run, permLabel, scopeLabel }: { member: MemberRow; data: MembersData; pending: boolean; run: Run; permLabel: (k: string) => string; scopeLabel: (ids: string[] | null) => string }) {
  const [adding, setAdding] = useState(false);
  const [perm, setPerm] = useState(data.permissions[0]?.key ?? "");
  const [scope, setScope] = useState<string>("");
  const [expires, setExpires] = useState(tonight());
  const def = data.permissions.find((p) => p.key === perm);
  const scopeOptions = data.scopes.filter((s) => s.kind === def?.scope_kind);

  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="w-24 text-[15px]">{m.display_name}</strong>
        <span className="w-32 text-xs text-ink-sub">
          {KIND_LABEL[m.kind]}
          {m.job_title ? ` ・ ${m.job_title}` : ""}
        </span>
        <div className="flex flex-1 flex-wrap gap-1.5">
          {data.groups.map((g) => {
            const on = m.group_ids.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                disabled={pending}
                onClick={() => run(() => setMemberGroupAction(m.id, g.id, !on))}
                className={`min-h-9 rounded-full border px-3 text-xs ${on ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input text-ink-sub"}`}
              >
                {g.name}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-ink-sub">実効 {m.effective.length}件</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[calc(6rem+2rem+0.75rem)] text-xs">
        {m.grants.map((g) => (
          <span key={g.id} className="flex items-center gap-1.5 rounded-lg bg-caution-soft px-2.5 py-1 text-caution">
            個別: {permLabel(g.permission_key)}（{scopeLabel(g.scope_ids)}）
            {g.expires_at ? ` ・ ${new Date(g.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}まで` : " ・ 無期限"}
            <button type="button" aria-label="個別付与を取り消す" disabled={pending} onClick={() => run(() => revokeGrantAction(g.id))} className="min-h-7 px-1">
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <span className="flex flex-wrap items-center gap-1.5 rounded-lg bg-canvas p-1.5">
            <select aria-label="権限" value={perm} onChange={(e) => (setPerm(e.target.value), setScope(""))} className="min-h-9 rounded-lg border border-line-input px-1.5">
              {data.permissions.map((p) => (
                <option key={p.key} value={p.key}>
                  {CATEGORY_LABEL[p.category]}: {p.label}
                </option>
              ))}
            </select>
            {def?.scope_kind && (
              <select aria-label="範囲" value={scope} onChange={(e) => setScope(e.target.value)} className="min-h-9 rounded-lg border border-line-input px-1.5">
                <option value="">全体</option>
                {scopeOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}のみ
                  </option>
                ))}
              </select>
            )}
            <input aria-label="期限" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="min-h-9 rounded-lg border border-line-input px-1.5" />
            <button
              type="button"
              disabled={pending}
              onClick={() => run(async () => {
                const r = await grantPermissionAction({ memberId: m.id, permissionKey: perm, scopeIds: scope ? [scope] : null, expiresAt: expires || null });
                if (r.ok) setAdding(false);
                return r;
              }, "個別に付与しました")}
              className="min-h-9 rounded-lg bg-dark px-3 font-bold text-white"
            >
              付与
            </button>
            <button type="button" onClick={() => setAdding(false)} className="min-h-9 px-2 text-ink-sub">
              やめる
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="min-h-8 rounded-lg border border-dashed border-[#BDB6AA] px-2.5 text-ink-sub">
            ＋ 期限付きで個別に付与
          </button>
        )}
      </div>
    </div>
  );
}

// グループ × 権限の表。プリセットも編集できる。範囲付きの付与は個別付与で行う
function GroupMatrix({ data, pending, run }: { data: MembersData; pending: boolean; run: Run }) {
  const initial = (g: GroupRow) => new Set(g.permissions.map((p) => p.key));
  const [edits, setEdits] = useState<Record<string, Set<string>>>(() => Object.fromEntries(data.groups.map((g) => [g.id, initial(g)])));
  const [newName, setNewName] = useState("");
  const toggle = (groupId: string, key: string) =>
    setEdits((prev) => {
      const next = new Set(prev[groupId]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [groupId]: next };
    });
  const changed = (g: GroupRow) => {
    const a = initial(g);
    const b = edits[g.id];
    return a.size !== b.size || [...a].some((k) => !b.has(k));
  };
  const scopesOf = (g: GroupRow, key: string) => g.permissions.find((p) => p.key === key)?.scope_ids ?? null;

  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-bold">グループ（プリセット）と権限</h2>
          <p className="text-xs text-ink-sub">MCPのツール1つ＝権限1つ。範囲付き（施設・エリア）の権限は、ここでは既存の範囲を保ったまま付け外しします。</p>
        </div>
        <span className="flex gap-1.5">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新しいグループ名" className="min-h-9 rounded-lg border border-line-input px-2.5 text-sm" />
          <button type="button" disabled={pending || !newName.trim()} onClick={() => run(async () => {
            const r = await saveGroupAction(null, { name: newName, permissions: [] });
            if (r.ok) setNewName("");
            return r;
          }, "グループを作りました")} className="min-h-9 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub disabled:opacity-40">
            ＋ 作成
          </button>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[13px]">
          <thead>
            <tr className="text-left text-xs text-ink-sub">
              <th className="py-2 font-normal">権限</th>
              {data.groups.map((g) => (
                <th key={g.id} className="px-1 py-2 text-center font-normal">
                  {g.name}
                  {changed(g) && (
                    <button type="button" disabled={pending} onClick={() => run(() => saveGroupAction(g.id, {
                      name: g.name,
                      permissions: [...edits[g.id]].map((key) => ({ key, scope_ids: scopesOf(g, key) })),
                    }), `「${g.name}」を保存しました`)} className="mt-1 block w-full rounded bg-primary py-1 text-[11px] font-bold text-white">
                      保存
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.permissions.map((p) => (
              <tr key={p.key} className="border-t border-line">
                <td className="py-1.5">
                  <span className="mr-1.5 text-[11px] text-ink-sub">{CATEGORY_LABEL[p.category]}</span>
                  {p.label}
                </td>
                {data.groups.map((g) => (
                  <td key={g.id} className="px-1 py-1.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${g.name}: ${p.label}`}
                      checked={edits[g.id]?.has(p.key) ?? false}
                      onChange={() => toggle(g.id, p.key)}
                      className="size-4.5 accent-primary"
                    />
                    {scopesOf(g, p.key) && <span className="block text-[10px] text-caution">範囲付き</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
