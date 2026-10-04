"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tr } from "@/lib/i18n";

const itemClass = (active: boolean) =>
  `flex min-h-11 items-center rounded-lg px-2.5 text-sm ${active ? "bg-primary-soft font-bold text-primary" : "hover:bg-canvas"}`;

// オーダー管理の左の一覧（案内情報と同じ形）。権限ごとに出し分ける
export function OrdersNav({ showBoard, showSettings }: { showBoard: boolean; showSettings: boolean }) {
  const pathname = usePathname();
  const item = (href: string, label: string) => (
    <Link key={href} href={href} aria-current={pathname.startsWith(href) ? "page" : undefined} className={itemClass(pathname.startsWith(href))}>
      {label}
    </Link>
  );
  return (
    <aside aria-label={tr("オーダー管理", "Orders")} className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface px-3 py-6">
      {showSettings && item("/admin/orders/duties", tr("担当設定", "Duties"))}
      {showBoard && item("/admin/orders/board", tr("オーダー状況", "Order board"))}
      {showSettings && (
        <>
          <div className="mx-1 my-1.5 h-px bg-line" />
          <div className="px-2.5 pb-1.5 text-xs text-ink-sub">{tr("マスタ設定", "Settings")}</div>
          {item("/admin/orders/areas", tr("エリア設定", "Areas"))}
          {item("/admin/orders/items", tr("品目設定", "Items"))}
        </>
      )}
    </aside>
  );
}
