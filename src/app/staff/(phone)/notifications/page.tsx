import { requireMember } from "@/server/auth";
import { listNotifications } from "@/server/staff-work";
import { markNotificationsReadAction } from "../../actions";
import { ALERT_PREFIX, tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const member = await requireMember("/staff/notifications");
  const items = await listNotifications(member.id);
  const hasUnread = items.some((n) => !n.read_at);
  return (
    <>
      <header className="flex items-center justify-between bg-dark px-5 pt-5 pb-4 text-canvas">
        <h1 className="text-xl font-bold">{tr("通知", "Alerts")}</h1>
        {hasUnread && (
          <form action={markNotificationsReadAction}>
            <button type="submit" className="min-h-11 text-xs text-[#C9CFD1] underline">
              {tr("すべて既読にする", "Mark all as read")}
            </button>
          </form>
        )}
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3.5">
        {items.map((n) => (
          <article
            key={n.id}
            className={`flex flex-col gap-1 rounded-xl border bg-surface px-3.5 py-3 ${n.read_at ? "border-line" : "border-primary"}`}
          >
            <div className="flex justify-between gap-2 text-sm">
              <strong className={(n.kind === "ticket_supervisor" && (n.title.includes("遅延") || n.title.includes("overdue"))) || (n.kind === "external_update" && n.title.startsWith(ALERT_PREFIX)) ? "text-danger" : ""}>{n.title}</strong>
              <time className="shrink-0 text-xs text-ink-sub">
                {new Date(n.created_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}
              </time>
            </div>
            {n.body && <p className="text-[13px] leading-relaxed text-ink-sub">{n.body}</p>}
          </article>
        ))}
        {items.length === 0 && <p className="p-6 text-center text-sm text-ink-sub">{tr("通知はありません", "No alerts")}</p>}
      </main>
    </>
  );
}
