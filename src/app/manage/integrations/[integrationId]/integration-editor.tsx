"use client";

import { useState, useTransition } from "react";
import type { FieldRuleRow, IntegrationDetail } from "@/server/integrations-admin";
import Link from "next/link";
import type { FetchLogRow } from "@/server/integrations/web-fetch";
import { decideWriteAction, saveIntegrationAction } from "../../actions";

const FIELD_LABELS: Record<string, string> = { reservation: "予約内容", request_history: "依頼履歴", guest_notes: "お客様メモ", billing: "料金・支払い", external_updates: "外部の最新情報" };
const WRITE_LABELS: Record<FieldRuleRow["write_mode"], string> = { none: "不可", append: "追記のみ", write: "可" };
const STATUS: Record<string, { label: string; className: string }> = {
  pending_confirm: { label: "確認待ち", className: "bg-caution-soft text-caution" },
  held: { label: "保留（形式不一致）", className: "bg-danger-soft text-danger" },
  written: { label: "書き込み済み", className: "bg-primary-soft text-primary" },
  rejected: { label: "取りやめ", className: "bg-muted text-ink-sub" },
};

export function IntegrationEditor({ detail }: { detail: IntegrationDetail }) {
  const [readRule, setReadRule] = useState(detail.readRule);
  const [writeRule, setWriteRule] = useState(detail.writeRule);
  const [fields, setFields] = useState(detail.fields);
  const readOnly = detail.webFetch !== undefined;
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const touch = () => (setDirty(true), setMessage(null));
  const setField = (field: string, patch: Partial<FieldRuleRow>) => (setFields((prev) => prev.map((f) => (f.field === field ? { ...f, ...patch } : f))), touch());

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button
          type="button"
          disabled={!dirty || pending}
          onClick={() =>
            startTransition(async () => {
              const r = await saveIntegrationAction(detail.id, { readRule, writeRule, fields });
              if (r.ok) {
                setDirty(false);
                setMessage({ kind: "ok", text: "保存しました。変更履歴に記録しています。" });
              } else setMessage({ kind: "error", text: r.error });
            })
          }
          className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40"
        >
          保存して適用
        </button>
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
        <section className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <div className="flex items-center justify-between">
            <label htmlFor="read-rule" className="text-base font-bold">
              {readOnly ? "外部の最新情報の使い方" : "読み取りルール"}
            </label>
            <span className="text-xs text-ink-sub">{readOnly ? "ゲストへの案内・AI相談で参照" : "会話の開始時と、必要に応じて参照"}</span>
          </div>
          <textarea id="read-rule" rows={6} value={readRule} onChange={(e) => (setReadRule(e.target.value), touch())} className="w-full rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary" />
        </section>
        {detail.webFetch ? (
          <WebFetchStatus apiKeyConfigured={detail.webFetch.apiKeyConfigured} sourceCount={detail.webFetch.sourceCount} />
        ) : (
          <section className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
            <div className="flex items-center justify-between">
              <label htmlFor="write-rule" className="text-base font-bold">
                書き込みルール
              </label>
              <span className="text-xs text-ink-sub">既存の運用ルールをそのまま書いてください</span>
            </div>
            <textarea id="write-rule" rows={6} value={writeRule} onChange={(e) => (setWriteRule(e.target.value), touch())} className="w-full rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary" />
          </section>
        )}
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-bold">ガードレール</h2>
            <span className="text-xs text-ink-sub">プロンプトより優先される固定の制限です（AIは書き方次第で越えられません）</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-sub">
                <th className="py-2 font-normal">項目</th>
                <th className="py-2 font-normal">読み取り</th>
                <th className="py-2 font-normal">書き込み</th>
                <th className="py-2 font-normal">スタッフの確認</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.field} className="border-t border-line">
                  <td className="py-2 font-bold">{FIELD_LABELS[f.field] ?? f.field}</td>
                  <td className="py-2">
                    <select value={f.can_read ? "yes" : "no"} onChange={(e) => setField(f.field, { can_read: e.target.value === "yes" })} className="min-h-9 rounded-lg border border-line-input px-2">
                      <option value="yes">可</option>
                      <option value="no">不可</option>
                    </select>
                  </td>
                  <td className="py-2">
                    <select value={f.write_mode} disabled={readOnly} onChange={(e) => setField(f.field, { write_mode: e.target.value as FieldRuleRow["write_mode"] })} className="min-h-9 rounded-lg border border-line-input px-2 disabled:opacity-50">
                      {Object.entries(WRITE_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2">
                    <input type="checkbox" disabled={readOnly} aria-label={`${FIELD_LABELS[f.field]}の書き込みを常にスタッフが確認`} checked={f.require_staff_confirm} onChange={(e) => setField(f.field, { require_staff_confirm: e.target.checked })} className="size-5 accent-primary" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {readOnly ? (
            <ul className="flex flex-col gap-1 text-xs text-ink-sub">
              <li>・読み取りのみの連携先です（書き込みはできません）</li>
              <li>・管理者が登録したURLだけを取得します（検索はしません）</li>
              <li>・AIエージェントに「外部の情報源の取得」の権限がないときは取得しません（メンバーと権限で変更）</li>
              <li>・案内には取得した時点と情報源を添えます。取得できない状態が続いた情報は使いません</li>
            </ul>
          ) : (
            <ul className="flex flex-col gap-1 text-xs text-ink-sub">
              <li>・クレーム関連の書き込みはスタッフの確認後</li>
              <li>・書き込み前に形式をチェックし、合わなければ保留</li>
            </ul>
          )}
        </section>
        {detail.webFetch ? (
          <RecentFetches fetches={detail.webFetch.fetches} />
        ) : (
          <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5">
            <h2 className="text-base font-bold">最近の書き込み</h2>
            {detail.writes.map((w) => {
              const status = STATUS[w.status] ?? { label: w.status, className: "bg-muted" };
              return (
                <div key={w.id} className="flex flex-col gap-1.5 border-t border-line py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">
                      {w.room_number ? `${w.room_number}号室 ・ ` : ""}
                      {FIELD_LABELS[w.field] ?? w.field}
                    </span>
                    <span className={`rounded-md px-2 py-0.5 text-xs ${status.className}`}>{status.label}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-sub">{w.content}</p>
                  {w.hold_reason && <p className="text-xs text-danger">保留の理由: {w.hold_reason}</p>}
                  {(w.status === "pending_confirm" || w.status === "held") && (
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
            {detail.writes.length === 0 && <p className="text-sm text-ink-sub">まだ書き込みはありません</p>}
          </section>
        )}
      </div>
    </div>
  );
}

// 外部の情報源の取得（Tavily）の状態。監視するURLは管理PCの「外部の情報源」で登録する
function WebFetchStatus({ apiKeyConfigured, sourceCount }: { apiKeyConfigured: boolean; sourceCount: number }) {
  return (
    <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">取得の状態</h2>
        <span className={`rounded-md px-2 py-0.5 text-xs ${apiKeyConfigured ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger"}`}>
          {apiKeyConfigured ? "Tavily 接続済み" : "APIキー未設定（TAVILY_API_KEY）"}
        </span>
      </div>
      <p className="text-sm">
        有効な情報源 <strong>{sourceCount}件</strong>
      </p>
      <p className="text-xs leading-relaxed text-ink-sub">
        運行情報・天気予報・イベントの公式サイトなど、監視するURLと取得の頻度は管理PCで登録します。情報源の信頼性は登録する方が確認してください。
      </p>
      <Link href="/admin/sources" className="flex min-h-11 items-center self-start rounded-[10px] border border-line-input px-4 text-sm font-bold">
        外部の情報源を開く
      </Link>
    </section>
  );
}

function RecentFetches({ fetches }: { fetches: FetchLogRow[] }) {
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-5 py-4.5">
      <h2 className="text-base font-bold">最近の取得</h2>
      {fetches.map((f, i) => (
        <div key={i} className="flex flex-col gap-1 border-t border-line py-2.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold">
              {f.succeeded}/{f.urls.length}件を取得
            </span>
            <span className="shrink-0 text-xs text-ink-sub">
              {f.created_at} ・ {f.credits}クレジット
            </span>
          </div>
          <ul className="flex flex-col gap-0.5 text-[13px] text-ink-sub">
            {f.urls.map((url) => (
              <li key={url} className="truncate">
                {url}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {fetches.length === 0 && <p className="text-sm text-ink-sub">まだ取得はありません</p>}
    </section>
  );
}
