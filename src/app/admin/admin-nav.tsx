"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "../staff/actions";
import { tr } from "@/lib/i18n";

// badge: 自動反映で更新された資料など、まだ見ていない件数（0なら出さない）
export type AdminNavItem = { href: string; label: string; exact?: boolean; ready?: boolean; allowed?: boolean; badge?: number };

export function AdminNav({ hotelName, memberName, items }: { hotelName: string; memberName: string; items: AdminNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={tr("管理メニュー", "Admin menu")} className="flex w-[230px] shrink-0 flex-col gap-1 bg-dark px-4 py-6 text-canvas">
      <div className="px-2.5 pb-5 font-mincho text-lg font-semibold">
        {hotelName}
        <span className="block font-sans text-[11px] font-normal text-[#AEB6B9]">{tr("管理", "Admin")}</span>
      </div>
      {items.map((item) => {
        const path = item.href.split("#")[0];
        const active = !item.href.includes("#") && (item.exact ? pathname === path : pathname.startsWith(path));
        if (item.ready === false) {
          return (
            <span key={item.href} className="flex min-h-11 items-center rounded-[10px] px-3 text-sm text-[#6F7A7E]" title={tr("準備中", "Coming soon")}>
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center justify-between rounded-[10px] px-3 text-sm ${active ? "bg-dark-2 font-bold" : "hover:bg-dark-2"}`}
          >
            {item.label}
            {item.badge ? (
              <span className="min-w-5 rounded-full bg-caution px-1.5 text-center text-[11px] font-bold text-white" aria-label={tr(`未確認の更新 ${item.badge}件`, `${item.badge} unseen updates`)}>
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
      <div className="mt-auto flex items-center justify-between px-2.5 pt-6 text-xs text-[#AEB6B9]">
        <span>{memberName}</span>
        <form action={logoutAction}>
          <button type="submit" className="min-h-11 underline">
            {tr("ログアウト", "Log out")}
          </button>
        </form>
      </div>
    </nav>
  );
}
