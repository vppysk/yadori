"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellIcon, ChatIcon, OrdersIcon } from "@/components/icons";
import { tr } from "@/lib/i18n";

const TABS = [
  { href: "/staff/orders", label: tr("オーダー", "Orders"), Icon: OrdersIcon },
  { href: "/staff/ask", label: tr("AIに相談", "Ask AI"), Icon: ChatIcon },
  { href: "/staff/notifications", label: tr("通知", "Alerts"), Icon: BellIcon },
];

export function PhoneNav({ unread }: { unread: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label={tr("スタッフメニュー", "Staff menu")} className="grid grid-cols-3 border-t border-line bg-surface px-2 pt-1.5 pb-6">
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`relative flex min-h-13 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "font-bold text-primary" : "text-ink-sub"}`}
          >
            <Icon />
            {label}
            {href === "/staff/notifications" && unread > 0 && (
              <span className="absolute top-1 left-1/2 ml-2 min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-bold text-white">
                {unread}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
