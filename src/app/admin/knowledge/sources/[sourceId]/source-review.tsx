"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { facilityRef, fieldKey, findConflicts, parseFacilityRef, periodText, toCandidates } from "@/server/facility-fields";
import type { DraftRow, SourceReview } from "@/server/info-sources";
import type { UrlSettings } from "@/server/source-fetch";
import { approveInfoSourceAction, dismissUpdateAction, setExternalAction } from "../../../actions";
import { UrlPanel } from "./url-panel";
import { tr } from "@/lib/i18n";

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

const input = "min-h-10 w-full rounded-lg border border-line-input bg-surface px-2.5 text-sm outline-none focus:border-primary";
const card = "overflow-hidden rounded-xl border border-line bg-surface";
const noticeCard = "overflow-hidden rounded-xl border border-[#E6C99E] bg-[#FFFBF4]";

// 資料の確認画面（docs/002_facility_master_design.md）:
// 1. 新しい施設・新しい項目を「新しく作る／既存と同じ」で確かめる 2. 読み取った内容を直す 3. 期間の重なりで優先する方を選ぶ → 承認
export function SourceReviewView({ review, urlSettings }: { review: SourceReview; urlSettings?: UrlSettings }) {
  const router = useRouter();
  const [rows, setRows] = useState<DraftRow[]>(review.rows);
  const [winner, setWinner] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { facilities, fields } = review;

  const facilityLabel = (ref: string) => {
    const parsed = parseFacilityRef(ref);
    return parsed.kind === "existing" ? (facilities.find((f) => f.id === parsed.id)?.name ?? "") : parsed.name;
  };
  const newFacilities = [...new Set(rows.map((r) => r.facility).filter((ref) => parseFacilityRef(ref).kind === "new"))];
  const newFields = [...new Set(rows.map((r) => r.field).filter((name) => name.trim() && fieldKey(fields, name).startsWith("new:")))];
  const conflicts = useMemo(() => findConflicts(toCandidates(rows, fields), review.existing), [rows, fields, review.existing]);
  const unresolved = conflicts.filter((c) => ![c.a, c.b].includes(winner[c.key]));

  const describe = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (row) return { who: tr("この資料", "This source"), key, facility: facilityLabel(row.facility), field: row.field, title: row.title, body: row.body, from: row.from, to: row.to };
    const e = review.existing.find((x) => x.key === key)!;
    return { who: e.sourceTitle, key, facility: facilityLabel(e.facilityId), field: fields.find((f) => f.id === e.fieldId)?.name ?? "", title: e.title, body: e.body, from: e.from, to: e.to };
  };

  const edit = (fn: (all: DraftRow[]) => DraftRow[]) => {
    setRows(fn);
    setMessage(null);
  };
  const update = (key: string, patch: Partial<DraftRow>) => edit((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // 施設・項目の指し方をまとめて置き換える（新しい施設を既存に合わせる、名前を直す など）
  const replaceFacility = (from: string, to: string) => edit((all) => all.map((r) => (r.facility === from ? { ...r, facility: to } : r)));
  const replaceField = (from: string, to: string) => edit((all) => all.map((r) => (r.field === from ? { ...r, field: to } : r)));

  // 施設 → 項目 → 期間の順に並べる
  const facilityOrder = (ref: string) => {
    const parsed = parseFacilityRef(ref);
    return parsed.kind === "existing" ? facilities.findIndex((f) => f.id === parsed.id) : 1000 + newFacilities.indexOf(ref);
  };
  const sorted = [...rows].sort((a, b) => facilityOrder(a.facility) - facilityOrder(b.facility) || a.field.localeCompare(b.field) || a.from.localeCompare(b.from));

  function onApprove() {
    setMessage(null);
    if (rows.some((r) => !r.body.trim() || !r.field.trim())) return setMessage({ kind: "error", text: tr("項目名か内容が空の行があります。入力するか削除してください", "Some rows have an empty item or content. Fill them in or delete them") });
    startTransition(async () => {
      const result = await approveInfoSourceAction(review.id, {
        rows: rows.map((r) => ({ ...r, field: r.field.trim(), title: r.title?.trim() || null, body: r.body.trim() })),
        winner,
      });
      if (!result.ok) return setMessage({ kind: "error", text: result.error });
      setMessage({ kind: "ok", text: tr("承認しました。ゲストへの案内に反映されます。", "Approved. Guests will now get answers based on this.") });
      router.refresh();
    });
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-sub">
            <Link href="/admin/knowledge/sources" className="hover:underline">
              {tr("資料", "Sources")}
            </Link>
            {" ／ "}
            {review.status === "pending" ? tr("確認待ち", "To review") : review.status === "update_pending" ? tr("更新の確認待ち", "Update to review") : tr("承認済み", "Approved")}
          </div>
          <h1 className="text-[22px] font-bold">{review.title}</h1>
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={review.isExternal}
              disabled={pending}
              onChange={(e) =>
                startTransition(async () => {
                  const r = await setExternalAction(review.id, e.target.checked);
                  if (!r.ok) setMessage({ kind: "error", text: r.error });
                })
              }
              className="size-4"
            />
            {tr("外部情報（ホテル以外が管理している資料）。案内では出どころを添えます", "External (managed by someone other than the hotel). Answers will cite the source")}
          </label>
        </div>
        <button type="button" disabled={pending || unresolved.length > 0} onClick={onApprove} className="min-h-11 rounded-[10px] bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40">
          {pending ? tr("承認中…", "Approving…") : review.status === "approved" ? tr("修正して承認", "Save and approve") : tr("この内容で承認", "Approve")}
        </button>
      </div>
      {review.status === "update_pending" && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-caution-soft px-3.5 py-2.5 text-sm">
          <span className="flex-1">{tr("Webページが更新されました。下は新しい版から読み取った内容です。承認するまでは、前の版の内容で案内します。", "The web page was updated. Below is what was read from the new version. Guests get the previous version until you approve.")}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await dismissUpdateAction(review.id);
                if (!r.ok) return setMessage({ kind: "error", text: r.error });
                router.refresh();
              })
            }
            className="min-h-10 rounded-lg border border-line-input bg-surface px-3"
          >
            {tr("この更新を見送る", "Skip this update")}
          </button>
        </div>
      )}
      {urlSettings && <UrlPanel sourceId={review.id} settings={urlSettings} />}

      <p className="text-sm text-ink-sub">
        {tr(
          "AIが資料から読み取った内容です。施設・項目・期間・内容が正しいかを確認してください。直すところは直し、不要な行は×で消してから承認します。",
          "This is what the AI read from the source. Check the facility, item, period and content. Fix anything wrong, remove unneeded rows with ×, then approve.",
        )}
      </p>
      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className={`rounded-lg px-3.5 py-2.5 text-sm ${message.kind === "error" ? "bg-danger-soft text-danger" : "bg-primary-soft text-primary"}`}>
          {message.text}
          {message.kind === "ok" && (
            <Link href="/admin/knowledge/sources" className="ml-2 font-bold underline">
              {tr("資料の一覧へ", "Back to sources")}
            </Link>
          )}
        </div>
      )}

      {newFacilities.length > 0 && (
        <section className={noticeCard}>
          <h2 className="px-4 pt-3.5 pb-1 text-[15px] font-bold">{tr(`新しい施設（${newFacilities.length}件）`, `New facilities (${newFacilities.length})`)}</h2>
          <p className="px-4 pb-2 text-xs text-ink-sub">{tr("登録済みの施設と名前が一致しませんでした。新しい施設として登録するか、登録済みの施設と同じかを選んでください。", "These names don't match any existing facility. Register them as new, or match them to an existing one.")}</p>
          {newFacilities.map((ref) => (
            <NewFacility key={ref} name={parseFacilityRef(ref).kind === "new" ? facilityLabel(ref) : ""} facilities={facilities} onRename={(name) => replaceFacility(ref, facilityRef.name(name))} onSame={(id) => replaceFacility(ref, facilityRef.id(id))} />
          ))}
        </section>
      )}

      {newFields.length > 0 && (
        <section className={noticeCard}>
          <h2 className="px-4 pt-3.5 pb-1 text-[15px] font-bold">{tr(`新しい項目（${newFields.length}件）`, `New items (${newFields.length})`)}</h2>
          <p className="px-4 pb-2 text-xs text-ink-sub">
            {tr(
              "これまでにない項目名です。同じ内容の項目がすでにあれば、そちらに合わせてください（「営業時間」と「営業時間帯」のように分かれると、期間の重なりを確認できません）。",
              "These item names are new. If an item with the same meaning exists, match it (if \"Hours\" and \"Opening hours\" are separate, overlapping periods can't be detected).",
            )}
          </p>
          {newFields.map((name) => (
            <div key={name} className="flex flex-wrap items-center gap-2.5 border-t border-[#E6C99E] px-4 py-2.5 text-sm">
              <span className="rounded bg-caution px-1.5 text-[11px] text-white">{tr("新しい項目", "New item")}</span>
              <strong>{name}</strong>
              <span className="flex-1" />
              {fields.length > 0 && (
                <select aria-label={tr(`${name}を既存の項目に合わせる`, `Match ${name} to an existing item`)} value="" onChange={(e) => e.target.value && replaceField(name, e.target.value)} className={`${input} max-w-60`}>
                  <option value="">{tr("このまま新しい項目にする", "Keep as a new item")}</option>
                  {fields.map((f) => (
                    <option key={f.id} value={f.name}>
                      {tr(`「${f.name}」と同じ`, `Same as "${f.name}"`)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </section>
      )}

      {conflicts.length > 0 && (
        <section className={noticeCard}>
          <h2 className="px-4 pt-3.5 pb-1 text-[15px] font-bold">
            {tr(`期間が重なっている内容（${conflicts.length}件）`, `Overlapping periods (${conflicts.length})`)}
            {unresolved.length > 0 && (
              <span className="ml-2 text-xs font-normal text-caution">
                {tr(`あと${unresolved.length}件、優先する方を選んでください`, `${unresolved.length} left: choose which one takes priority`)}
              </span>
            )}
          </h2>
          <p className="px-4 pb-2 text-xs text-ink-sub">{tr("重なる期間は、選んだ方だけで案内します。それ以外の期間はどちらもそのまま使います。", "For the overlapping period, only the one you choose is used. Outside it, both stay as they are.")}</p>
          {conflicts.map((c) => {
            const a = describe(c.a);
            const b = describe(c.b);
            const from = a.from > b.from ? a.from : b.from;
            const to = a.to === null ? b.to : b.to === null ? a.to : a.to < b.to ? a.to : b.to;
            return (
              <fieldset key={c.key} className="flex flex-col gap-1.5 border-t border-[#E6C99E] px-4 py-3 text-sm">
                <legend className="sr-only">{tr("重なりの選択", "Choose priority")}</legend>
                <span className="font-bold">
                  {a.facility} / {a.field}
                  {a.title ? tr(`「${a.title}」`, ` "${a.title}"`) : ""}
                  <span className="ml-2 font-normal text-ink-sub">{tr(`重なる期間 ${periodText({ from, to })}`, `Overlap: ${periodText({ from, to })}`)}</span>
                </span>
                {[a, b].map((side) => (
                  <label key={side.key} className="flex min-h-10 items-center gap-2.5">
                    <input type="radio" name={c.key} checked={winner[c.key] === side.key} onChange={() => setWinner((w) => ({ ...w, [c.key]: side.key }))} className="size-5 accent-primary" />
                    <span>
                      <span className="text-ink-sub">{side.who}:</span> {side.body}
                      <span className="ml-1.5 text-xs text-ink-sub">({periodText(side)})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </section>
      )}

      <section className={card}>
        <div className="grid grid-cols-[1.1fr_1.1fr_1fr_2.2fr_2fr_40px] gap-2.5 bg-canvas px-4 py-2.5 text-xs text-ink-sub">
          <span>{tr("施設", "Facility")}</span>
          <span>{tr("項目", "Item")}</span>
          <span>{tr("タイトル", "Title")}</span>
          <span>{tr("内容", "Content")}</span>
          <span>{tr("適用期間", "Valid period")}</span>
          <span />
        </div>
        <datalist id="field-names">
          {[...new Set([...fields.map((f) => f.name), ...newFields])].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {sorted.map((r) => (
          <div key={r.key} className="grid grid-cols-[1.1fr_1.1fr_1fr_2.2fr_2fr_40px] items-start gap-2.5 border-t border-line px-4 py-2">
            <select aria-label={tr("施設", "Facility")} value={r.facility} onChange={(e) => update(r.key, { facility: e.target.value })} className={input}>
              {facilities.map((f) => (
                <option key={f.id} value={facilityRef.id(f.id)}>
                  {f.name}
                </option>
              ))}
              {newFacilities.map((ref) => (
                <option key={ref} value={ref}>
                  {facilityLabel(ref)} {tr("（新しい施設）", "(new)")}
                </option>
              ))}
            </select>
            <input aria-label={tr("項目", "Item")} list="field-names" value={r.field} onChange={(e) => update(r.key, { field: e.target.value })} className={input} />
            <input aria-label={tr("タイトル", "Title")} value={r.title ?? ""} placeholder={tr("（なし）", "(none)")} onChange={(e) => update(r.key, { title: e.target.value || null })} className={input} />
            <textarea aria-label={tr("内容", "Content")} rows={1} value={r.body} onChange={(e) => update(r.key, { body: e.target.value })} className={`${input} py-2 leading-relaxed`} />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <input type="date" aria-label={tr("開始", "From")} value={r.from} onChange={(e) => update(r.key, { from: e.target.value })} className={input} />
                {tr("〜", "–")}
                <input type="date" aria-label={tr("終了", "To")} value={r.to ?? ""} disabled={r.to === null} onChange={(e) => update(r.key, { to: e.target.value || null })} className={`${input} disabled:bg-canvas`} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-ink-sub">
                <input type="checkbox" checked={r.to === null} onChange={(e) => update(r.key, { to: e.target.checked ? null : r.from })} className="accent-primary" />
                {tr("終了日なし", "No end date")}
              </label>
            </div>
            <button type="button" aria-label={tr("この行を削除", "Delete this row")} onClick={() => edit((all) => all.filter((x) => x.key !== r.key))} className="min-h-10 rounded-lg text-ink-sub hover:bg-canvas">
              ×
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">{tr("案内に使う内容は読み取れませんでした", "Nothing usable was found")}</p>}
        <button
          type="button"
          onClick={() =>
            edit((all) => [
              ...all,
              { key: newKey(), facility: all[0]?.facility ?? facilityRef.id(facilities[0].id), field: all[0]?.field ?? "", title: null, body: "", from: all[0]?.from ?? new Date().toISOString().slice(0, 10), to: null },
            ])
          }
          className="mx-4 mt-2.5 mb-3.5 min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
        >
          {tr("＋ 行を追加", "+ Add row")}
        </button>
      </section>

      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
        <summary className="cursor-pointer font-bold">{tr("資料の本文（読み取りの元）", "Source text (what the AI read)")}</summary>
        <pre className="mt-2 max-h-96 overflow-y-auto font-sans text-sm leading-relaxed break-all whitespace-pre-wrap text-ink-sub">{review.body}</pre>
      </details>
    </main>
  );
}

// 新しい施設の候補: 名前を直して新しく登録するか、登録済みの施設と同じにする
function NewFacility({ name, facilities, onRename, onSame }: { name: string; facilities: { id: string; name: string; kind: string }[]; onRename: (name: string) => void; onSame: (id: string) => void }) {
  const [draft, setDraft] = useState(name);
  const existing = facilities.filter((f) => f.kind === "facility");
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-[#E6C99E] px-4 py-2.5 text-sm">
      <span className="rounded bg-caution px-1.5 text-[11px] text-white">{tr("新しい施設", "New facility")}</span>
      <label className="flex items-center gap-1.5">
        {tr("登録する名前", "Name")}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && draft.trim() !== name && onRename(draft.trim())}
          className={`${input} max-w-56`}
        />
      </label>
      <span className="flex-1" />
      {existing.length > 0 && (
        <select aria-label={tr(`${name}を登録済みの施設に合わせる`, `Match ${name} to an existing facility`)} value="" onChange={(e) => e.target.value && onSame(e.target.value)} className={`${input} max-w-60`}>
          <option value="">{tr("新しい施設として登録する", "Register as a new facility")}</option>
          {existing.map((f) => (
            <option key={f.id} value={f.id}>
              {tr(`「${f.name}」と同じ`, `Same as "${f.name}"`)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
