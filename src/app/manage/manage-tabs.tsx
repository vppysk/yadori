"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ManageTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="AIチームの運営" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
      {tabs.map((tab) => {
        const active = tab.href === "/manage" ? pathname === "/manage" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-10 items-center rounded-lg px-4 text-sm whitespace-nowrap ${active ? "bg-dark font-bold text-white" : "text-ink-sub hover:bg-canvas"}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
