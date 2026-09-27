"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { periodText } from "@/server/facility-fields";
import type { FacilityViewData } from "@/server/knowledge-admin";
import { addNoticeAction, deleteNoticeAction, previewNoticeAction } from "../../actions";

// 施設の画面: 案内している内容（承認済みの資料から。編集は資料の確認画面で行う）と特記事項
export function FacilityView({ data, canNotice, children }: { data: FacilityViewData; canNotice: boolean; children?: React.ReactNode }) {
  const isGlobal = data.kind === "global";
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-sub">
            案内情報 ／ 最終更新 {data.updatedAt}
          </div>
          <h1 className="text-[22px] font-bold">{isGlobal ? "全体" : data.name}</h1>
        </div>
        <Link href="/admin/knowledge/sources" className="flex min-h-11 items-center rounded-[10px] border border-line-input bg-surface px-4 text-sm font-bold">
          資料を追加・更新
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
                {v.overriddenBy.length > 0 && <span className="block text-xs text-ink-sub">重なる期間は {v.overriddenBy.join("、")} を優先</span>}
              </span>
              <span className="text-xs text-ink-sub">
                {v.external && <span className="mr-1 rounded border border-line-input px-1 text-[11px]">外部</span>}
                {v.sourceTitle ?? "導入時の設定"}
              </span>
            </div>
          ))}
          {f.values.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-ink-sub">案内している内容はありません</p>}
        </section>
      ))}
      {data.fields.length === 0 && (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-sub">
          {isGlobal ? "ホテル全体の案内（チェックイン、駐車場など）は、資料から読み取ると表示されます。" : "資料から読み取った内容はありません。聞かれたときは、AIは推測せずスタッフに確認すると答えます。"}
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
    const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
    return `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))}（${"日月火水木金土"[d.getUTCDay()]}）${at.slice(11, 16)}`;
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h2 className="text-[15px] font-bold">
          特記事項
          <span className="ml-2.5 text-xs font-normal text-ink-sub">
            {data.kind === "global" ? "施設に紐づかないお知らせ（例: ロビーで18時から物産展）" : "期間中は資料の内容より優先して案内"}
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
          {preview && (preview.overrides.length > 0 || preview.overlappingNotices.length > 0) && (
            <div className="flex flex-col gap-0.5 text-xs text-ink-sub">
              {preview.overrides.length > 0 && <span>この期間は、{summarize(preview.overrides)}より優先して案内します</span>}
              {preview.overlappingNotices.length > 0 && <span>期間が重なる特記事項があります（両方案内します）: {summarize(preview.overlappingNotices.map((b) => `「${b}」`))}</span>}
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
      {data.notices.map((n) => (
        <div key={n.id} className="grid grid-cols-[1.6fr_2.6fr_1.4fr_40px] items-center gap-3 border-t border-line px-4 py-3 text-sm">
          <span className="font-bold">
            {label(n.starts_at)}〜{n.ends_at.slice(0, 10) === n.starts_at.slice(0, 10) ? n.ends_at.slice(11, 16) : label(n.ends_at)}
            {n.ends_at.slice(0, 10) === data.today && <span className="ml-1.5 rounded bg-caution-soft px-1.5 py-0.5 text-[11px] font-normal text-caution">本日まで</span>}
          </span>
          <span>
            {n.body}
            {n.overrides.length > 0 && <span className="block text-xs text-ink-sub">{summarize(n.overrides)}より優先して案内</span>}
          </span>
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

// 「営業時間「ランチ」、営業時間「ディナー」ほか2件」
function summarize(items: string[], max = 3): string {
  return items.slice(0, max).join("、") + (items.length > max ? `ほか${items.length - max}件` : "");
}
