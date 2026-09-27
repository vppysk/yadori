"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { findConflicts, periodText } from "@/server/facility-fields";
import type { ReviewRow, SourceReview } from "@/server/info-sources";
import { approveInfoSourceAction } from "../../../actions";

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

const input = "min-h-10 w-full rounded-lg border border-line-input bg-surface px-2.5 text-sm outline-none focus:border-primary";

// 資料の確認画面: 読み取った内容を施設・項目ごとに直し、承認済みの内容と期間が重なるものは優先する方を選んで承認する
export function SourceReviewView({ review }: { review: SourceReview }) {
  const router = useRouter();
  const [rows, setRows] = useState<ReviewRow[]>(review.rows);
  const [winner, setWinner] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { facilities } = review.structure;

  const facilityName = (id: string) => facilities.find((f) => f.id === id)?.name ?? "";
  const fieldName = (facilityId: string, fieldId: string) => facilities.find((f) => f.id === facilityId)?.fields.find((x) => x.id === fieldId)?.name ?? "";
  const conflicts = useMemo(() => findConflicts(rows, review.existing), [rows, review.existing]);
  const unresolved = conflicts.filter((c) => ![c.a, c.b].includes(winner[c.key]));
  const describe = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (row) return { who: "この資料", ...row };
    const e = review.existing.find((x) => x.key === key)!;
    return { who: e.sourceTitle, ...e };
  };

  const update = (key: string, patch: Partial<ReviewRow>) => {
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setMessage(null);
  };

  // 施設 → 項目の順に並べる（施設・項目は導入時の設定順）
  const order = (r: ReviewRow) => {
    const fi = facilities.findIndex((f) => f.id === r.facilityId);
    const xi = facilities[fi]?.fields.findIndex((x) => x.id === r.fieldId) ?? 0;
    return fi * 100 + xi;
  };
  const sorted = [...rows].sort((a, b) => order(a) - order(b) || a.from.localeCompare(b.from));

  function onApprove() {
    setMessage(null);
    if (rows.some((r) => !r.body.trim())) return setMessage({ kind: "error", text: "内容が空の行があります。入力するか削除してください" });
    startTransition(async () => {
      const result = await approveInfoSourceAction(review.id, {
        rows: rows.map((r) => ({ ...r, title: r.title?.trim() || null, body: r.body.trim() })),
        winner,
      });
      if (!result.ok) return setMessage({ kind: "error", text: result.error });
      setMessage({ kind: "ok", text: "承認しました。ゲストへの案内に反映されます。" });
      router.refresh();
    });
  }

  const facilityIds = [...new Set(rows.map((r) => r.facilityId))];

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-sub">
            <Link href="/admin/knowledge/sources" className="hover:underline">
              資料
            </Link>
            {" ／ "}
            {review.status === "pending" ? "確認待ち" : "承認済み"}
          </div>
          <h1 className="text-[22px] font-bold">{review.title}</h1>
        </div>
        <button
          type="button"
          disabled={pending || unresolved.length > 0}
          onClick={onApprove}
          className="min-h-11 rounded-[10px] bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {pending ? "承認中…" : review.status === "pending" ? "この内容で承認" : "修正して承認"}
        </button>
      </div>

      <p className="text-sm text-ink-sub">
        AIが資料から読み取った内容です。施設・項目・期間・内容が正しいかを確認してください。直すところは直し、不要な行は×で消してから承認します。
      </p>
      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className={`rounded-lg px-3.5 py-2.5 text-sm ${message.kind === "error" ? "bg-danger-soft text-danger" : "bg-primary-soft text-primary"}`}>
          {message.text}
          {message.kind === "ok" && (
            <span className="ml-2">
              {facilityIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && "・"}
                  <Link href={`/admin/knowledge/${id}`} className="font-bold underline">
                    {facilityName(id)}
                  </Link>
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {conflicts.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-[#E6C99E] bg-[#FFFBF4]">
          <h2 className="px-4 pt-3.5 pb-1 text-[15px] font-bold">
            期間が重なっている内容（{conflicts.length}件）
            {unresolved.length > 0 && <span className="ml-2 text-xs font-normal text-caution">あと{unresolved.length}件、優先する方を選んでください</span>}
          </h2>
          <p className="px-4 pb-2 text-xs text-ink-sub">重なる期間は、選んだ方だけで案内します。それ以外の期間はどちらもそのまま使います。</p>
          {conflicts.map((c) => {
            const a = describe(c.a);
            const b = describe(c.b);
            const from = a.from > b.from ? a.from : b.from;
            const to = a.to === null ? b.to : b.to === null ? a.to : a.to < b.to ? a.to : b.to;
            return (
              <fieldset key={c.key} className="flex flex-col gap-1.5 border-t border-[#E6C99E] px-4 py-3 text-sm">
                <legend className="sr-only">重なりの選択</legend>
                <span className="font-bold">
                  {facilityName(a.facilityId)}／{fieldName(a.facilityId, a.fieldId)}
                  {a.title ? `「${a.title}」` : ""}
                  <span className="ml-2 font-normal text-ink-sub">重なる期間 {periodText({ from, to })}</span>
                </span>
                {[a, b].map((side) => (
                  <label key={side.key} className="flex min-h-10 items-center gap-2.5">
                    <input type="radio" name={c.key} checked={winner[c.key] === side.key} onChange={() => setWinner((w) => ({ ...w, [c.key]: side.key }))} className="size-5 accent-primary" />
                    <span>
                      <span className="text-ink-sub">{side.who}:</span> {side.body}
                      <span className="ml-1.5 text-xs text-ink-sub">（{periodText(side)}）</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="grid grid-cols-[1.1fr_1.1fr_1fr_2.2fr_2fr_40px] gap-2.5 bg-canvas px-4 py-2.5 text-xs text-ink-sub">
          <span>施設</span>
          <span>項目</span>
          <span>タイトル</span>
          <span>内容</span>
          <span>適用期間</span>
          <span />
        </div>
        {sorted.map((r) => {
          const fields = facilities.find((f) => f.id === r.facilityId)?.fields ?? [];
          return (
            <div key={r.key} className="grid grid-cols-[1.1fr_1.1fr_1fr_2.2fr_2fr_40px] items-start gap-2.5 border-t border-line px-4 py-2">
              <select
                aria-label="施設"
                value={r.facilityId}
                onChange={(e) => {
                  const next = facilities.find((f) => f.id === e.target.value);
                  // 施設を変えたら、同じ名前の項目があればそれに合わせる
                  const same = next?.fields.find((x) => x.name === fieldName(r.facilityId, r.fieldId));
                  update(r.key, { facilityId: e.target.value, fieldId: same?.id ?? next?.fields[0]?.id ?? "" });
                }}
                className={input}
              >
                {facilities.filter((f) => f.fields.length > 0).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <select aria-label="項目" value={r.fieldId} onChange={(e) => update(r.key, { fieldId: e.target.value })} className={input}>
                {fields.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <input aria-label="タイトル" value={r.title ?? ""} placeholder="（なし）" onChange={(e) => update(r.key, { title: e.target.value || null })} className={input} />
              <textarea aria-label="内容" rows={1} value={r.body} onChange={(e) => update(r.key, { body: e.target.value })} className={`${input} py-2 leading-relaxed`} />
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <input type="date" aria-label="開始" value={r.from} onChange={(e) => update(r.key, { from: e.target.value })} className={input} />〜
                  <input type="date" aria-label="終了" value={r.to ?? ""} disabled={r.to === null} onChange={(e) => update(r.key, { to: e.target.value || null })} className={`${input} disabled:bg-canvas`} />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink-sub">
                  <input type="checkbox" checked={r.to === null} onChange={(e) => update(r.key, { to: e.target.checked ? null : r.from })} className="accent-primary" />
                  終了日なし
                </label>
              </div>
              <button type="button" aria-label="この行を削除" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))} className="min-h-10 rounded-lg text-ink-sub hover:bg-canvas">
                ×
              </button>
            </div>
          );
        })}
        {rows.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">案内に使う内容は読み取れませんでした</p>}
        <button
          type="button"
          onClick={() => {
            const f = facilities.find((x) => x.fields.length > 0);
            if (f) setRows((all) => [...all, { key: newKey(), facilityId: f.id, fieldId: f.fields[0].id, title: null, body: "", from: all[0]?.from ?? new Date().toISOString().slice(0, 10), to: null }]);
          }}
          className="mx-4 mt-2.5 mb-3.5 min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
        >
          ＋ 行を追加
        </button>
      </section>

      {review.unplaced.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-line bg-surface">
          <h2 className="px-4 pt-3.5 pb-1 text-[15px] font-bold">どの項目にも入らなかった内容</h2>
          <p className="px-4 pb-2 text-xs text-ink-sub">
            このままでは案内に使われません。案内したい場合は、上の表に行を追加して近い項目に入れるか、一時的なお知らせなら施設の画面で特記事項にしてください。
          </p>
          {review.unplaced.map((u, i) => (
            <p key={i} className="border-t border-line px-4 py-2.5 text-sm">
              {u.facility && <span className="mr-2 text-ink-sub">{u.facility}</span>}
              {u.text}
            </p>
          ))}
        </section>
      )}

      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
        <summary className="cursor-pointer font-bold">資料の本文（読み取りの元）</summary>
        <pre className="mt-2 font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink-sub">{review.body}</pre>
      </details>
    </main>
  );
}
