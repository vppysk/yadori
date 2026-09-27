"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { SourceReview } from "@/server/info-sources";
import { IMPACT_LABELS } from "@/lib/fetch-intervals";
import type { UrlSettings } from "@/server/source-fetch";
import { setExternalAction } from "../../../actions";
import { UrlPanel } from "./url-panel";

// 自動反映のURL資料（docs/006_guide_info.md）: 承認はなく、取得のたびのAIの要約をそのまま案内に使う。ここでは最新の要約と取得の設定を見る
export function AutoSourceView({ review, settings }: { review: SourceReview; settings: UrlSettings }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const impact = settings.auto_impact ?? "none";
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1.5">
        <div className="text-xs text-ink-sub">
          <Link href="/admin/knowledge/sources" className="hover:underline">
            資料
          </Link>
          {" ／ 自動反映"}
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
                if (!r.ok) setError(r.error);
              })
            }
            className="size-4"
          />
          外部情報（ホテル以外が管理している資料）。案内では出どころを添えます
        </label>
      </div>
      <p className="text-sm text-ink-sub">取得のたびにAIが要約し、承認を待たずにゲストへの案内とAI相談に時点付きで使います。影響があるとき・解消したときは現場スマホに通知します。</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <section className={`flex flex-col gap-2 rounded-xl border px-4 py-3.5 text-sm ${impact === "alert" ? "border-danger bg-danger-soft" : "border-line bg-surface"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">最新の要約</h2>
          <span className={`rounded px-1.5 text-[11px] ${impact === "alert" ? "bg-danger text-white" : impact === "notice" ? "bg-caution text-white" : "bg-muted"}`}>{IMPACT_LABELS[impact]}</span>
          <span className="flex-1" />
          <span className="text-xs text-ink-sub">{settings.auto_updated_at ? `内容が変わった日時 ${settings.auto_updated_at}` : "まだ取得していません"}</span>
        </div>
        <p className="leading-relaxed">{settings.auto_summary ?? "—"}</p>
        {settings.auto_staff_message && <p className="text-xs text-ink-sub">スタッフへの通知: {settings.auto_staff_message}</p>}
      </section>
      <UrlPanel sourceId={review.id} settings={settings} />
      <details className="rounded-xl border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer font-bold">取得した本文</summary>
        <pre className="mt-2 max-h-96 overflow-y-auto font-sans text-sm leading-relaxed break-all whitespace-pre-wrap text-ink-sub">{review.body}</pre>
      </details>
    </main>
  );
}
