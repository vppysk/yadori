"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { FacilityListItem } from "@/server/knowledge-admin";
import { tr } from "@/lib/i18n";

const itemClass = (active: boolean) =>
  `flex min-h-11 items-center justify-between rounded-lg px-2.5 text-sm ${active ? "bg-primary-soft font-bold text-primary" : "hover:bg-canvas"}`;

// note: どこに効くか（ゲストへの回答とスタッフのAI相談のどちらか・両方）
const heading = (label: string, first = false, note?: string) => (
  <>
    {!first && <div className="mx-1 my-1.5 h-px bg-line" />}
    <div className="flex flex-col px-2.5 pb-1.5 text-xs text-ink-sub">
      {label}
      {note && <span className="text-[11px] text-ink-sub/80">{note}</span>}
    </div>
  </>
);

// AIの設定の左の一覧（docs/007_ai_settings.md）。答える内容 → 答え方 → 連携の使い方 → 館内の情報（施設ごと）。
// 答える内容と館内の情報はゲストへの回答とスタッフのAI相談の両方、答え方はゲストへの回答だけに効く
export function KnowledgeNav({
  facilities,
  showQuestions,
  showSources,
  showInstructions,
  integrations,
  pendingSources,
  unseenUpdates,
}: {
  facilities: FacilityListItem[];
  showQuestions: boolean;
  showSources: boolean;
  showInstructions: boolean;
  // 連携の使い方を見られないときは null
  integrations: { id: string; name: string; pending: number }[] | null;
  pendingSources: number;
  unseenUpdates: number;
}) {
  const pathname = usePathname();
  const link = (href: string, label: React.ReactNode, active = pathname.startsWith(href)) => (
    <Link key={href} href={href} aria-current={active ? "page" : undefined} className={itemClass(active)}>
      {label}
    </Link>
  );
  // 区切り線は2つ目以降の見出しの上にだけ引く
  const shown = [showQuestions || showSources, showInstructions, integrations !== null, facilities.length > 0];
  const section = (index: number, label: string, note?: string) => heading(label, !shown.slice(0, index).some(Boolean), note);
  return (
    <aside aria-label={tr("AIの設定", "AI settings")} className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-3 py-6">
      {shown[0] && section(0, tr("答える内容", "What the AI knows"), tr("ゲスト・AI相談の共通", "Shared by guest chat & staff AI"))}
      {showQuestions && (
        <Link href="/admin/knowledge/questions" aria-current={pathname.startsWith("/admin/knowledge/questions") ? "page" : undefined} className={itemClass(pathname.startsWith("/admin/knowledge/questions"))}>
          {tr("未回答の質問", "Unanswered questions")}
        </Link>
      )}
      {showSources && (
        <Link href="/admin/knowledge/sources" aria-current={pathname.startsWith("/admin/knowledge/sources") ? "page" : undefined} className={itemClass(pathname.startsWith("/admin/knowledge/sources"))}>
          {tr("資料", "Sources")}
          <span className="flex items-center gap-1.5">
            {pendingSources > 0 && <span className="text-[11px] font-normal text-caution">{tr(`確認待ち ${pendingSources}`, `${pendingSources} to review`)}</span>}
            {unseenUpdates > 0 && (
              <span className="min-w-5 rounded-full bg-caution px-1.5 text-center text-[11px] font-bold text-white" aria-label={tr(`自動反映の未確認の更新 ${unseenUpdates}件`, `${unseenUpdates} unseen auto updates`)}>
                {unseenUpdates}
              </span>
            )}
          </span>
        </Link>
      )}
      {showInstructions && (
        <>
          {section(1, tr("答え方", "How the AI answers"), tr("ゲストへの回答", "Guest replies"))}
          {link("/admin/knowledge/instructions", tr("指示", "Instructions"))}
        </>
      )}
      {integrations && (
        <>
          {section(2, tr("連携の使い方", "Connected systems"))}
          {link("/admin/knowledge/integrations", tr("連携先の一覧", "All connections"), pathname === "/admin/knowledge/integrations")}
          {integrations.map((i) =>
            link(
              `/admin/knowledge/integrations/${i.id}`,
              <>
                {i.name}
                {i.pending > 0 && <span className="shrink-0 text-[11px] font-normal text-caution">{tr(`確認待ち ${i.pending}`, `${i.pending} to review`)}</span>}
              </>,
            ),
          )}
        </>
      )}
      {shown[3] && section(3, tr("館内の情報", "Hotel information"), tr("ゲスト・AI相談の共通", "Shared by guest chat & staff AI"))}
      {facilities.map((f, i) => {
        const href = `/admin/knowledge/${f.id}`;
        return (
          <div key={f.id}>
            {f.kind === "facility" && facilities[i - 1]?.kind === "global" && <div className="px-2.5 pt-1.5 pb-1 text-xs text-ink-sub">{tr("施設", "Facilities")}</div>}
            <Link href={href} aria-current={pathname === href ? "page" : undefined} className={itemClass(pathname === href)}>
              {f.kind === "global" ? (
                <span className="flex flex-col py-1.5 leading-tight">
                  {f.name}
                  <span className="text-[11px] font-normal text-ink-sub">{tr("お知らせ・案内・マニュアル", "Notices, guides, manuals")}</span>
                </span>
              ) : (
                f.name
              )}
              {f.notices > 0 ? (
                <span className="text-[11px] font-normal text-caution">{tr(`特記 ${f.notices}`, `Notice ${f.notices}`)}</span>
              ) : f.needs_check ? (
                <span className="size-2 rounded-full bg-[#D98A2B]" aria-label={tr("要確認あり", "Needs review")} />
              ) : null}
            </Link>
          </div>
        );
      })}
    </aside>
  );
}
