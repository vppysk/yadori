"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { UploadIcon } from "@/components/icons";
import type { FacilityEditorData, HourRow, OfferingRow } from "@/server/knowledge-admin";
import { addNoticeAction, deleteNoticeAction, importDraftAction, saveFacilityAction } from "../../actions";

// 営業時間は「適用期間 × 時間帯（ランチ・ディナーなど）」の表で編集する。セルは「11:30〜14:00」「休業」「17:30〜21:00（L.O. 20:30）」
type Period = { key: string; from: string; to: string; cells: Record<string, string>; draft: boolean };
type Offering = { key: string; name: string; from: string; to: string; price: string; description: string; draft: boolean };

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function toPeriods(hours: HourRow[]): { periods: Period[]; labels: string[] } {
  // 列は開始時刻の早い時間帯から（ランチ→ディナー）。休業しかない時間帯は後ろ
  const earliest = (label: string) =>
    hours.filter((h) => h.label === label && h.opens).map((h) => h.opens!.padStart(5, "0")).sort()[0] ?? "99:99";
  const labels = [...new Set(hours.map((h) => h.label))].sort((a, b) => earliest(a).localeCompare(earliest(b)));
  const byRange = new Map<string, Period>();
  for (const h of hours) {
    const id = `${h.from}|${h.to}|${h.draft}`;
    const period = byRange.get(id) ?? { key: nextKey(), from: h.from, to: h.to, cells: {}, draft: h.draft };
    period.cells[h.label] = h.closed ? "休業" : `${h.opens}〜${h.closes}${h.note ? `（${h.note}）` : ""}`;
    byRange.set(id, period);
  }
  return { periods: [...byRange.values()].sort((a, b) => a.from.localeCompare(b.from)), labels: labels.length ? labels : ["営業"] };
}

function toOfferings(rows: OfferingRow[]): Offering[] {
  return rows.map((o) => ({
    key: nextKey(), name: o.name, from: o.from, to: o.to, price: o.price_jpy?.toString() ?? "", description: o.description ?? "", draft: o.draft,
  }));
}

type ParsedCell = { closed: true } | { closed: false; opens: string; closes: string; note: string | null } | null;

function parseCell(text: string): ParsedCell | "invalid" {
  const value = text.normalize("NFKC").trim();
  if (!value) return null;
  if (/^(休業|休み|定休|休館)/.test(value)) return { closed: true };
  const match = value.match(/^(\d{1,2}:\d{2})\s*[〜~\-ー－–]\s*(\d{1,2}:\d{2})\s*(.*)$/);
  if (!match) return "invalid";
  const note = match[3].replace(/^[（(]|[）)]$/g, "").trim();
  return { closed: false, opens: match[1], closes: match[2], note: note || null };
}

const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from <= b.to && b.from <= a.to;

const fmtDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export function KnowledgeEditor({ data, canEdit, canNotice }: { data: FacilityEditorData; canEdit: boolean; canNotice: boolean }) {
  const initial = useMemo(() => toPeriods(data.hours), [data.hours]);
  const [periods, setPeriods] = useState<Period[]>(initial.periods);
  const [labels, setLabels] = useState<string[]>(initial.labels);
  const [offerings, setOfferings] = useState<Offering[]>(() => toOfferings(data.offerings));
  const [newLabel, setNewLabel] = useState("");
  const [importedFile, setImportedFile] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const isGlobal = data.kind === "global";

  const edit = <T,>(setter: (fn: (prev: T) => T) => void) => (fn: (prev: T) => T) => {
    setter(fn);
    setDirty(true);
    setMessage(null);
  };
  const editPeriods = edit(setPeriods);
  const editOfferings = edit(setOfferings);

  // 期間の重なり: 営業時間は同じ時間帯（列）が両方に入っている期間同士、メニューは同じ施設内のすべて
  const periodConflicts = useMemo(() => {
    const flagged = new Set<string>();
    periods.forEach((a, i) =>
      periods.slice(i + 1).forEach((b) => {
        const shared = labels.some((l) => a.cells[l]?.trim() && b.cells[l]?.trim());
        if (shared && a.from && b.from && overlaps(a, b)) flagged.add(a.key).add(b.key);
      }),
    );
    return flagged;
  }, [periods, labels]);
  const offeringConflicts = useMemo(() => {
    const map = new Map<string, string[]>();
    offerings.forEach((a) =>
      offerings.forEach((b) => {
        if (a.key !== b.key && a.from && b.from && overlaps(a, b)) map.set(a.key, [...(map.get(a.key) ?? []), b.name || "無題"]);
      }),
    );
    return map;
  }, [offerings]);

  function onImport(file: File) {
    const form = new FormData();
    form.set("file", file);
    setMessage(null);
    startTransition(async () => {
      const result = await importDraftAction(data.id, form);
      if (!result.ok || !result.data) {
        setMessage({ kind: "error", text: result.ok ? "読み込めませんでした" : result.error });
        return;
      }
      const draft = toPeriods(result.data.hours);
      if (result.data.hours.length) {
        setLabels((prev) => [...prev, ...draft.labels.filter((l) => !prev.includes(l))]);
        setPeriods((prev) => [...prev, ...draft.periods].sort((a, b) => a.from.localeCompare(b.from)));
      }
      setOfferings((prev) => [...prev, ...toOfferings(result.data!.offerings)]);
      setImportedFile(result.data.fileName);
      setDirty(true);
    });
  }

  function onSave() {
    const hours: Omit<HourRow, "draft">[] = [];
    for (const p of periods) {
      if (!p.from || !p.to) return setMessage({ kind: "error", text: "適用期間を入力してください" });
      for (const label of labels) {
        const parsed = parseCell(p.cells[label] ?? "");
        if (parsed === "invalid") {
          return setMessage({ kind: "error", text: `${fmtDate(p.from)}〜の「${label}」は「11:30〜14:00」の形か「休業」で入力してください` });
        }
        if (!parsed) continue;
        hours.push(
          parsed.closed
            ? { label, opens: null, closes: null, closed: true, note: null, from: p.from, to: p.to }
            : { label, opens: parsed.opens, closes: parsed.closes, closed: false, note: parsed.note, from: p.from, to: p.to },
        );
      }
    }
    const rows = offerings.filter((o) => o.name.trim());
    if (rows.some((o) => !o.from || !o.to)) return setMessage({ kind: "error", text: "メニューの提供期間を入力してください" });
    startTransition(async () => {
      const result = await saveFacilityAction(data.id, {
        hours,
        offerings: rows.map((o) => ({
          name: o.name.trim(), description: o.description.trim() || null,
          price_jpy: o.price.trim() ? Number(o.price.replace(/[^\d]/g, "")) : null, from: o.from, to: o.to,
        })),
      });
      if (!result.ok) return setMessage({ kind: "error", text: result.error });
      setPeriods((prev) => prev.map((p) => ({ ...p, draft: false })));
      setOfferings((prev) => prev.map((o) => ({ ...o, draft: false })));
      setImportedFile(null);
      setDirty(false);
      setMessage({ kind: "ok", text: "保存しました。ゲストへの案内に反映されます。" });
    });
  }

  const input = "min-h-10 w-full rounded-lg border px-2.5 text-sm outline-none focus:border-primary disabled:bg-canvas";
  const border = (draft: boolean) => (draft ? "border-[#E6C99E] bg-[#FFFBF4]" : "border-line-input bg-surface");

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-sub">
            施設・営業情報 ／ 最終更新 {data.updatedAt}
            {data.updatedBy ? ` ${data.updatedBy}` : ""}
          </div>
          <h1 className="text-[22px] font-bold">{isGlobal ? "全体" : data.name}</h1>
        </div>
        {!isGlobal && canEdit && (
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImport(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => fileRef.current?.click()}
              className="flex min-h-11 items-center gap-2 rounded-[10px] border border-line-input bg-surface px-4 text-sm font-bold disabled:opacity-50"
            >
              <UploadIcon />
              {pending && !dirty ? "読み込み中…" : "PDF・画像から読み込む"}
            </button>
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={onSave}
              className="min-h-11 rounded-[10px] bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40"
            >
              保存
            </button>
          </div>
        )}
      </div>

      {importedFile && (
        <div className="flex items-center gap-2.5 rounded-lg bg-caution-soft px-3.5 py-2.5 text-sm text-caution">
          <span className="rounded-md bg-caution px-2 py-0.5 text-xs text-white">下書き</span>
          「{importedFile}」から読み込んだ内容を入力しました。内容を確認・修正して保存してください。
        </div>
      )}
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={`rounded-lg px-3.5 py-2.5 text-sm ${message.kind === "error" ? "bg-danger-soft text-danger" : "bg-primary-soft text-primary"}`}>
          {message.text}
        </p>
      )}

      {!isGlobal && (
        <section className="overflow-hidden rounded-xl border border-line bg-surface">
          <h2 className="px-4 pt-3.5 pb-2.5 text-[15px] font-bold">営業時間</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-canvas text-left text-xs text-ink-sub">
                  <th className="px-4 py-2.5 font-normal">適用期間</th>
                  {labels.map((l) => (
                    <th key={l} className="px-2 py-2.5 font-normal">
                      {l}
                    </th>
                  ))}
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.key} className="border-t border-line align-top">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <input type="date" aria-label="適用期間の開始" value={p.from} disabled={!canEdit} onChange={(e) => editPeriods((all) => all.map((x) => (x.key === p.key ? { ...x, from: e.target.value } : x)))} className={`${input} ${border(p.draft)}`} />
                        〜
                        <input type="date" aria-label="適用期間の終了" value={p.to} disabled={!canEdit} onChange={(e) => editPeriods((all) => all.map((x) => (x.key === p.key ? { ...x, to: e.target.value } : x)))} className={`${input} ${border(p.draft)}`} />
                      </div>
                      <div className="mt-1 flex gap-1.5">
                        {p.draft && <span className="rounded bg-caution px-1.5 text-[11px] text-white">下書き</span>}
                        {periodConflicts.has(p.key) && <span className="rounded bg-danger-soft px-1.5 text-[11px] text-danger">ほかの期間と重複</span>}
                      </div>
                    </td>
                    {labels.map((l) => (
                      <td key={l} className="px-2 py-2">
                        <input
                          aria-label={`${l}（${p.from}〜）`}
                          value={p.cells[l] ?? ""}
                          placeholder="例 11:30〜14:00 / 休業"
                          disabled={!canEdit}
                          onChange={(e) => editPeriods((all) => all.map((x) => (x.key === p.key ? { ...x, cells: { ...x.cells, [l]: e.target.value } } : x)))}
                          className={`${input} ${border(p.draft)}`}
                        />
                      </td>
                    ))}
                    <td className="py-2 pr-2">
                      {canEdit && (
                        <button type="button" aria-label="この期間を削除" onClick={() => editPeriods((all) => all.filter((x) => x.key !== p.key))} className="min-h-10 w-9 rounded-lg text-ink-sub hover:bg-canvas">
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-2.5 pb-3.5">
              <button
                type="button"
                onClick={() => editPeriods((all) => [...all, { key: nextKey(), from: data.today, to: data.today, cells: {}, draft: false }])}
                className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
              >
                ＋ 期間を追加
              </button>
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="時間帯の名前（例 モーニング）" className={`${input} ${border(false)} max-w-56`} />
              <button
                type="button"
                disabled={!newLabel.trim() || labels.includes(newLabel.trim())}
                onClick={() => {
                  setLabels((prev) => [...prev, newLabel.trim()]);
                  setNewLabel("");
                  setDirty(true);
                }}
                className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub disabled:opacity-40"
              >
                ＋ 時間帯を追加
              </button>
            </div>
          )}
        </section>
      )}

      {!isGlobal && (
        <section className="overflow-hidden rounded-xl border border-line bg-surface">
          <h2 className="px-4 pt-3.5 pb-2.5 text-[15px] font-bold">メニュー・プラン</h2>
          <div className="grid grid-cols-[1.4fr_2.2fr_1fr_40px] gap-3 bg-canvas px-4 py-2.5 text-xs text-ink-sub">
            <span>名称</span>
            <span>提供期間</span>
            <span>料金（円）</span>
            <span />
          </div>
          {offerings.map((o) => (
            <div key={o.key} className="grid grid-cols-[1.4fr_2.2fr_1fr_40px] items-start gap-3 border-t border-line px-4 py-2">
              <div className="flex flex-col gap-1">
                <input aria-label="名称" value={o.name} disabled={!canEdit} onChange={(e) => editOfferings((all) => all.map((x) => (x.key === o.key ? { ...x, name: e.target.value } : x)))} className={`${input} ${border(o.draft)}`} />
                {o.draft && <span className="self-start rounded bg-caution px-1.5 text-[11px] text-white">下書き</span>}
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <input type="date" aria-label="提供期間の開始" value={o.from} disabled={!canEdit} onChange={(e) => editOfferings((all) => all.map((x) => (x.key === o.key ? { ...x, from: e.target.value } : x)))} className={`${input} ${border(o.draft)}`} />
                  〜
                  <input type="date" aria-label="提供期間の終了" value={o.to} disabled={!canEdit} onChange={(e) => editOfferings((all) => all.map((x) => (x.key === o.key ? { ...x, to: e.target.value } : x)))} className={`${input} ${border(o.draft)}`} />
                </div>
                {offeringConflicts.has(o.key) && (
                  <span className="self-start rounded bg-danger-soft px-1.5 text-[11px] text-danger">{offeringConflicts.get(o.key)!.join("、")}と期間が重複</span>
                )}
              </div>
              <input aria-label="料金" inputMode="numeric" value={o.price} disabled={!canEdit} onChange={(e) => editOfferings((all) => all.map((x) => (x.key === o.key ? { ...x, price: e.target.value } : x)))} className={`${input} ${border(o.draft)}`} />
              {canEdit ? (
                <button type="button" aria-label="このメニューを削除" onClick={() => editOfferings((all) => all.filter((x) => x.key !== o.key))} className="min-h-10 rounded-lg text-ink-sub hover:bg-canvas">
                  ×
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => editOfferings((all) => [...all, { key: nextKey(), name: "", from: data.today, to: data.today, price: "", description: "", draft: false }])}
              className="mx-4 mt-2.5 mb-3.5 min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3.5 text-sm text-ink-sub"
            >
              ＋ メニューを追加
            </button>
          )}
        </section>
      )}

      <NoticeSection data={data} canNotice={canNotice} />
    </main>
  );
}

// 特記事項: 保存ボタンとは別に、追加・削除した時点で即反映する（期限で自動的に案内から外れる）
function NoticeSection({ data, canNotice }: { data: FacilityEditorData; canNotice: boolean }) {
  const endOfToday = `${data.today}T23:59`;
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState(endOfToday);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  const label = (at: string) => {
    const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
    return `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))}（${"日月火水木金土"[d.getUTCDay()]}）${at.slice(11, 16)}`;
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h2 className="text-[15px] font-bold">
          特記事項
          <span className="ml-2.5 text-xs font-normal text-ink-sub">
            {data.kind === "global" ? "施設に紐づかないお知らせ（例: ロビーで18時から物産展）" : "期間中は上の営業情報より優先して案内"}
          </span>
        </h2>
        {canNotice && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="min-h-9 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub">
            ＋ 追加
          </button>
        )}
      </div>
      {adding && (
        <form
          className="flex flex-col gap-2 border-t border-line bg-canvas px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const now = new Date();
              const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
              const result = await addNoticeAction(data.id, { body, startsAt: startsAt || localNow, endsAt });
              if (!result.ok) return setError(result.error);
              setBody("");
              setStartsAt("");
              setEndsAt(endOfToday);
              setAdding(false);
            });
          }}
        >
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="例: 本日15時まで点検のため閉鎖" aria-label="特記事項の内容" className="min-h-10 rounded-lg border border-line-input bg-surface px-3 text-sm outline-none focus:border-primary" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              開始
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="min-h-10 rounded-lg border border-line-input bg-surface px-2" />
              <span className="text-xs text-ink-sub">（空欄は今すぐ）</span>
            </label>
            <label className="flex items-center gap-1.5">
              期限
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="min-h-10 rounded-lg border border-line-input bg-surface px-2" />
            </label>
            <span className="flex-1" />
            <button type="button" onClick={() => setAdding(false)} className="min-h-10 px-3 text-ink-sub">
              やめる
            </button>
            <button type="submit" disabled={pending || !body.trim()} className="min-h-10 rounded-lg bg-primary px-4 font-bold text-white disabled:opacity-40">
              登録して反映
            </button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
      {data.notices.map((n) => (
        <div key={n.id} className="grid grid-cols-[1.6fr_2.6fr_1.4fr_40px] items-center gap-3 border-t border-line px-4 py-3 text-sm">
          <span className="font-bold">
            {label(n.starts_at)}〜{n.ends_at.slice(0, 10) === n.starts_at.slice(0, 10) ? n.ends_at.slice(11, 16) : label(n.ends_at)}
          </span>
          <span>{n.body}</span>
          <span className="text-xs text-ink-sub">{n.created_by ?? "—"} ・ 期限で自動消去</span>
          {canNotice ? (
            <button
              type="button"
              aria-label="この特記事項を削除"
              disabled={pending}
              onClick={() => startTransition(async () => void (await deleteNoticeAction(n.id)))}
              className="min-h-10 rounded-lg text-ink-sub hover:bg-canvas"
            >
              ×
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}
      {data.notices.length === 0 && !adding && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">有効な特記事項はありません</p>}
    </section>
  );
}
