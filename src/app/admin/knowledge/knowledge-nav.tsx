"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { FacilityListItem } from "@/server/knowledge-admin";

const itemClass = (active: boolean) =>
  `flex min-h-11 items-center justify-between rounded-lg px-2.5 text-sm ${active ? "bg-primary-soft font-bold text-primary" : "hover:bg-canvas"}`;

export function KnowledgeNav({ facilities, showSources, pendingSources }: { facilities: FacilityListItem[]; showSources: boolean; pendingSources: number }) {
  const pathname = usePathname();
  return (
    <aside aria-label="館内の情報" className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface px-3 py-6">
      {showSources && (
        <Link href="/admin/knowledge/sources" aria-current={pathname.startsWith("/admin/knowledge/sources") ? "page" : undefined} className={itemClass(pathname.startsWith("/admin/knowledge/sources"))}>
          資料
          {pendingSources > 0 && <span className="text-[11px] font-normal text-caution">確認待ち {pendingSources}</span>}
        </Link>
      )}
      {facilities.map((f, i) => {
        const href = `/admin/knowledge/${f.id}`;
        return (
          <div key={f.id}>
            {f.kind === "facility" && facilities[i - 1]?.kind === "global" && (
              <>
                <div className="mx-1 my-1.5 h-px bg-line" />
                <div className="px-2.5 pb-1.5 text-xs text-ink-sub">施設</div>
              </>
            )}
            <Link href={href} aria-current={pathname === href ? "page" : undefined} className={itemClass(pathname === href)}>
              {f.kind === "global" ? (
                <span className="flex flex-col py-1.5 leading-tight">
                  {f.name}
                  <span className="text-[11px] font-normal text-ink-sub">お知らせ・案内・マニュアル</span>
                </span>
              ) : (
                f.name
              )}
              {f.notices > 0 ? (
                <span className="text-[11px] font-normal text-caution">特記 {f.notices}</span>
              ) : f.needs_check ? (
                <span className="size-2 rounded-full bg-[#D98A2B]" aria-label="要確認あり" />
              ) : null}
            </Link>
          </div>
        );
      })}
    </aside>
  );
}
