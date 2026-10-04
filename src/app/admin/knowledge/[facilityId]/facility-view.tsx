"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { periodText } from "@/server/facility-fields";
import type { FacilityViewData } from "@/server/knowledge-admin";
import { addNoticeAction, deleteNoticeAction, previewNoticeAction } from "../../actions";
import { formatDayWithWeekday, tr } from "@/lib/i18n";

// 施設の画面: 案内している内容（承認済みの資料から。編集は資料の確認画面で行う）と特記事項
export function FacilityView({ data, canNotice, children }: { data: FacilityViewData; canNotice: boolean; children?: React.ReactNode }) {
  const isGlobal = data.kind === "global";
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-sub">
            {tr(`案内情報 ／ 最終更新 ${data.updatedAt}`, `Hotel information / last updated ${data.updatedAt}`)}
          </div>
          <h1 className="text-[22px] font-bold">{isGlobal ? tr("全体", "Hotel-wide") : data.name}</h1>
        </div>
        <Link href="/admin/knowledge/sources" className="flex min-h-11 items-center rounded-[10px] border border-line-input bg-surface px-4 text-sm font-bold">
          {tr("資料を追加・更新", "Add or update sources")}
        </Link>
      </div>

      {data.fields.map((f) => (
        <section key={f.fieldId} className="overflow-hidden rounded-xl border border-line bg-surface">
          <h2 className="px-4 pt-3.5 pb-2.5 text-[15px] font-bold">{f.name}</h2>
          {f.values.map((v, i) => (
            <div key={`${v.id}-${i}`} className="grid grid-cols-[1.3fr_2.6fr_1.6fr] items-start gap-3 border-t border-line px-4 py-2.5 text-sm">
              <span className="text-ink-sub">{periodText(v)}</span>
              <span>
                {v.title && <strong className="mr-2">{v.title}</strong>}
                {v.body}
                {v.overriddenBy.length > 0 && <span className="block text-xs text-ink-sub">{tr(`重なる期間は ${v.overriddenBy.join("、")} を優先`, `During the overlap, ${v.overriddenBy.join(", ")} takes priority`)}</span>}
              </span>
              <span className="text-xs text-ink-sub">
                {v.external && <span className="mr-1 rounded border border-line-input px-1 text-[11px]">{tr("外部", "External")}</span>}
                {v.sourceTitle ?? tr("導入時の設定", "Initial setup")}
              </span>
            </div>
          ))}
          {f.values.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">{tr("案内している内容はありません", "Nothing is being used for answers")}</p>}
        </section>
      ))}
      {data.fields.length === 0 && (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-sub">
          {isGlobal
            ? tr("ホテル全体の案内（チェックイン、駐車場など）は、資料から読み取ると表示されます。", "Hotel-wide info (check-in, parking, etc.) appears here once read from a source.")
            : tr("資料から読み取った内容はありません。聞かれたときは、AIは推測せずスタッフに確認すると答えます。", "Nothing has been read from sources yet. If asked, the AI won't guess and will say it will check with staff.")}
        </p>
      )}

      <NoticeSection data={data} canNotice={canNotice} />
      {children}
    </main>
  );
}

// 特記事項: 保存ボタンとは別に、追加・削除した時点で即反映する（期限で自動的に案内から外れる）
function NoticeSection({ data, canNotice }: { data: FacilityViewData; canNotice: boolean }) {
  const endOfToday = `${data.today}T23:59`;
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState(endOfToday);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<{ overrides: string[]; overlappingNotices: string[] } | null>(null);

  // 期間を入れたら、優先して案内することになる内容と、重なる特記事項を先に見せる
  const effectiveStart = startsAt || `${data.today}T00:00`;
  useEffect(() => {
    if (!adding || !endsAt || endsAt <= effectiveStart) return;
    let cancelled = false;
    previewNoticeAction(data.id, effectiveStart, endsAt).then((r) => {
      if (!cancelled) setPreview(r.ok && r.data ? r.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [adding, data.id, effectiveStart, endsAt]);

  const label = (at: string) => {
    return `${formatDayWithWeekday(at.slice(0, 10))} ${at.slice(11, 16)}`;
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h2 className="text-[15px] font-bold">
          {tr("特記事項", "Special notices")}
          <span className="ml-2.5 text-xs font-normal text-ink-sub">
            {data.kind === "global"
              ? tr("施設に紐づかないお知らせ（例: ロビーで18時から物産展）", "Notices not tied to a facility (e.g. local crafts fair in the lobby from 18:00)")
              : tr("期間中は資料の内容より優先して案内", "Overrides source content while active")}
          </span>
        </h2>
        {canNotice && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="min-h-9 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub">
            {tr("＋ 追加", "+ Add")}
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
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder={tr("例: 本日15時まで点検のため閉鎖", "e.g. Closed until 15:00 today for maintenance")} aria-label={tr("特記事項の内容", "Special notice")} className="min-h-10 rounded-lg border border-line-input bg-surface px-3 text-sm outline-none focus:border-primary" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              {tr("開始", "Start")}
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="min-h-10 rounded-lg border border-line-input bg-surface px-2" />
              <span className="text-xs text-ink-sub">{tr("（空欄は今すぐ）", "(blank = now)")}</span>
            </label>
            <label className="flex items-center gap-1.5">
              {tr("期限", "Until")}
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="min-h-10 rounded-lg border border-line-input bg-surface px-2" />
            </label>
            <span className="flex-1" />
            <button type="button" onClick={() => setAdding(false)} className="min-h-10 px-3 text-ink-sub">
              {tr("やめる", "Cancel")}
            </button>
            <button type="submit" disabled={pending || !body.trim()} className="min-h-10 rounded-lg bg-primary px-4 font-bold text-white disabled:opacity-40">
              {tr("登録して反映", "Publish now")}
            </button>
          </div>
          {preview && (preview.overrides.length > 0 || preview.overlappingNotices.length > 0) && (
            <div className="flex flex-col gap-0.5 text-xs text-ink-sub">
              {preview.overrides.length > 0 && <span>{tr(`この期間は、${summarize(preview.overrides)}より優先して案内します`, `During this period it overrides ${summarize(preview.overrides)}`)}</span>}
              {preview.overlappingNotices.length > 0 && (
                <span>
                  {tr("期間が重なる特記事項があります（両方案内します）: ", "Overlaps with other notices (both will be used): ")}
                  {summarize(preview.overlappingNotices.map((b) => tr(`「${b}」`, `"${b}"`)))}
                </span>
              )}
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
      {data.notices.map((n) => (
        <div key={n.id} className="grid grid-cols-[1.6fr_2.6fr_1.4fr_40px] items-center gap-3 border-t border-line px-4 py-3 text-sm">
          <span className="font-bold">
            {label(n.starts_at)}{tr("〜", " – ")}{n.ends_at.slice(0, 10) === n.starts_at.slice(0, 10) ? n.ends_at.slice(11, 16) : label(n.ends_at)}
            {n.ends_at.slice(0, 10) === data.today && <span className="ml-1.5 rounded bg-caution-soft px-1.5 py-0.5 text-[11px] font-normal text-caution">{tr("本日まで", "Ends today")}</span>}
          </span>
          <span>
            {n.body}
            {n.overrides.length > 0 && <span className="block text-xs text-ink-sub">{tr(`${summarize(n.overrides)}より優先して案内`, `Overrides ${summarize(n.overrides)}`)}</span>}
          </span>
          <span className="text-xs text-ink-sub">{n.created_by ?? "—"} ・ {tr("期限で自動消去", "Auto-removed when it ends")}</span>
          {canNotice ? (
            <button
              type="button"
              aria-label={tr("この特記事項を削除", "Delete this notice")}
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
      {data.notices.length === 0 && !adding && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">{tr("有効な特記事項はありません", "No active special notices")}</p>}
    </section>
  );
}

// 「営業時間「ランチ」、営業時間「ディナー」ほか2件」
function summarize(items: string[], max = 3): string {
  return items.slice(0, max).join(tr("、", ", ")) + (items.length > max ? tr(`ほか${items.length - max}件`, ` and ${items.length - max} more`) : "");
}
