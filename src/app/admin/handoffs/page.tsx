import Link from "next/link";
import { AI_REASONS, ALERT_CATEGORIES, ALERT_KINDS, FAILURE_CAUSES, FAILURE_STAGES, HANDOFF_LABELS, alertCategoryOf, type AlertCategory } from "@/lib/handoff-kinds";
import { can, requireMember } from "@/server/auth";
import { getHandoffDetail, listHandoffHistory } from "@/server/staff-work";
import { ConversationPanel } from "./conversation-panel";

export const dynamic = "force-dynamic";

const STATUSES: Record<string, string> = { open: "未対応", accepted: "対応中", closed: "対応完了", cancelled: "ゲストが取り消し" };

// 対応アラート（plan 4.6「履歴と経緯」）: 人が応対する必要のあるゲストの会話。行を選ぶと右の会話パネルで該当のメッセージを開き、そのまま返信できる
export default async function HandoffAlertsPage({ searchParams }: PageProps<"/admin/handoffs">) {
  const member = await requireMember("/admin/handoffs");
  if (!(await can(member.id, "handling.complaint.view"))) return <main className="p-8 text-sm text-ink-sub">対応アラートの権限がありません</main>;
  const params = await searchParams;
  const pick = (value: string | string[] | undefined, allowed: object) => (typeof value === "string" && value in allowed ? value : undefined);
  const category = pick(params.category, ALERT_CATEGORIES) as AlertCategory | undefined;
  const reason = category === "ai" ? pick(params.reason, AI_REASONS) : undefined;
  const status = pick(params.status, STATUSES);
  const selectedId = typeof params.id === "string" ? params.id : undefined;

  const kinds = reason ? [reason] : category ? [...ALERT_CATEGORIES[category].kinds] : ALERT_KINDS;
  const [rows, selected, canReply] = await Promise.all([
    listHandoffHistory(member.hotel_id, { kinds, status }),
    selectedId ? getHandoffDetail(member.hotel_id, selectedId) : undefined,
    can(member.id, "handling.handoff.accept"),
  ]);
  const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const link = (next: { category?: string; reason?: string; status?: string; id?: string }) => {
    const merged = { category, reason, status, id: selectedId, ...next };
    const q = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][]);
    return `/admin/handoffs${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) =>
    `flex min-h-9 items-center rounded-lg border px-3 text-[13px] ${active ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input bg-surface"}`;

  return (
    <div className="flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
        <h1 className="text-[22px] font-bold">対応アラート</h1>
        <div className="flex flex-wrap gap-1.5">
          <Link href={link({ category: "", reason: "" })} className={chip(!category)}>すべて</Link>
          {Object.entries(ALERT_CATEGORIES).map(([key, c]) => (
            <Link key={key} href={link({ category: key, reason: "" })} className={chip(category === key)}>{c.label}</Link>
          ))}
          <span className="mx-2 w-px bg-line" />
          <Link href={link({ status: "" })} className={chip(!status)}>全状態</Link>
          {Object.entries(STATUSES).map(([key, label]) => (
            <Link key={key} href={link({ status: key })} className={chip(status === key)}>{label}</Link>
          ))}
        </div>
        {category === "ai" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-ink-sub">理由</span>
            <Link href={link({ reason: "" })} className={chip(!reason)}>すべて</Link>
            {Object.entries(AI_REASONS).map(([key, label]) => (
              <Link key={key} href={link({ reason: key })} className={chip(reason === key)}>{label}</Link>
            ))}
          </div>
        )}
        <section className="flex flex-col rounded-xl border border-line bg-surface">
          {rows.map((h) => {
            const cat = alertCategoryOf(h.kind);
            const alert = cat === "safety" || cat === "complaint";
            const active = h.id === selectedId;
            return (
              <Link
                key={h.id}
                href={link({ id: h.id })}
                scroll={false}
                aria-current={active ? "true" : undefined}
                className={`flex flex-col gap-1 border-t border-line px-5 py-3 text-sm first:border-t-0 ${active ? "bg-primary-soft" : "hover:bg-canvas"}`}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <time className="w-24 text-ink-sub">{fmt(h.created_at)}</time>
                  <strong className={`w-56 ${alert ? "text-danger" : ""}`}>
                    {h.room_number ? `${h.room_number}号室 ` : ""}
                    {cat ? ALERT_CATEGORIES[cat].label : HANDOFF_LABELS[h.kind]}
                  </strong>
                  {cat === "ai" && <span className="rounded-md border border-line-input px-2 py-0.5 text-xs">{AI_REASONS[h.kind]}</span>}
                  <span className="min-w-0 flex-1 truncate text-ink-sub">{h.summary}</span>
                  <span className="w-20 shrink-0 truncate text-right text-xs text-ink-sub">{h.accepted_by_name ? `担当 ${h.accepted_by_name}` : ""}</span>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs">{STATUSES[h.status] ?? h.status}</span>
                </div>
                {h.kind === "system_error" && (
                  <p className="pl-28 text-xs text-danger">
                    原因: {FAILURE_CAUSES[h.failure_cause ?? "unknown"]}
                    {h.failure_stage ? `（${FAILURE_STAGES[h.failure_stage]}）` : ""}
                    {(h.same_cause_24h ?? 0) > 1 ? ` ・ 直近24時間で同じ原因 ${h.same_cause_24h}件` : ""}
                  </p>
                )}
              </Link>
            );
          })}
          {rows.length === 0 && <p className="px-5 py-4 text-sm text-ink-sub">該当するアラートはありません</p>}
        </section>
      </main>
      {selected && (
        <aside className="sticky top-0 flex h-dvh w-[420px] shrink-0 flex-col border-l border-line bg-surface">
          <ConversationPanel key={selected.id} handoff={selected} canReply={canReply} closeHref={link({ id: "" })} />
        </aside>
      )}
    </div>
  );
}
