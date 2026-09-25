import Link from "next/link";
import { can, requireMember } from "@/server/auth";
import { listHandoffHistory } from "@/server/staff-work";

export const dynamic = "force-dynamic";

const KINDS: Record<string, string> = {
  talk_request: "スタッフとの会話を希望",
  complaint: "クレーム",
  overdue_order: "オーダー遅延",
  unanswerable: "AIが回答できない",
  safety: "安全に関わる内容",
};
const STATUSES: Record<string, string> = { open: "未対応", accepted: "対応中", closed: "対応完了" };
const WRITES: Record<string, string> = { pending_confirm: "お客様メモ: 確認待ち", held: "お客様メモ: 保留", written: "お客様メモに記録済み", rejected: "お客様メモ: 取りやめ" };

// 引き継ぎ・クレーム履歴（plan 4.6「履歴と経緯」）
export default async function HandoffHistoryPage({ searchParams }: PageProps<"/admin/handoffs">) {
  const member = await requireMember("/admin/handoffs");
  if (!(await can(member.id, "handling.complaint.view"))) return <main className="p-8 text-sm text-ink-sub">引き継ぎ・クレーム履歴の権限がありません</main>;
  const { kind, status } = await searchParams;
  const k = typeof kind === "string" && kind in KINDS ? kind : undefined;
  const s = typeof status === "string" && status in STATUSES ? status : undefined;
  const rows = await listHandoffHistory(member.hotel_id, { kind: k, status: s });
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const link = (params: { kind?: string; status?: string }) => {
    const q = new URLSearchParams(Object.entries({ kind: k, status: s, ...params }).filter(([, v]) => v) as [string, string][]);
    return `/admin/handoffs${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) => `flex min-h-9 items-center rounded-lg border px-3 text-[13px] ${active ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input bg-surface"}`;

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <h1 className="text-[22px] font-bold">引き継ぎ・クレーム履歴</h1>
      <div className="flex flex-wrap gap-1.5">
        <Link href={link({ kind: "" })} className={chip(!k)}>すべて</Link>
        {Object.entries(KINDS).map(([key, label]) => (
          <Link key={key} href={link({ kind: key })} className={chip(k === key)}>{label}</Link>
        ))}
        <span className="mx-2 w-px bg-line" />
        <Link href={link({ status: "" })} className={chip(!s)}>全状態</Link>
        {Object.entries(STATUSES).map(([key, label]) => (
          <Link key={key} href={link({ status: key })} className={chip(s === key)}>{label}</Link>
        ))}
      </div>
      <section className="flex flex-col rounded-xl border border-line bg-surface">
        {rows.map((h) => {
          const alert = h.kind === "complaint" || h.kind === "overdue_order" || h.kind === "safety";
          return (
            <details key={h.id} className="border-t border-line px-5 py-3 first:border-t-0">
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <time className="w-24 text-ink-sub">{fmt(h.created_at)}</time>
                <strong className={`w-52 ${alert ? "text-danger" : ""}`}>
                  {h.room_number ? `${h.room_number}号室 ` : ""}
                  {KINDS[h.kind] ?? h.kind}
                </strong>
                <span className="min-w-0 flex-1 truncate text-ink-sub">{h.summary}</span>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs">{STATUSES[h.status] ?? h.status}</span>
              </summary>
              <div className="mt-3 grid gap-3 pl-28 text-[13px] md:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <p className="leading-relaxed"><strong>AI要約：</strong>{h.summary}</p>
                  <p className="text-ink-sub">
                    受付 {fmt(h.created_at)} ・ 引き受け {fmt(h.accepted_at)}{h.accepted_by_name ? `（${h.accepted_by_name}）` : ""} ・ 完了 {fmt(h.closed_at)}
                  </p>
                  {h.write_status && <p className="text-ink-sub">{WRITES[h.write_status] ?? h.write_status}</p>}
                </div>
                <ol className="flex flex-col gap-1.5">
                  {h.messages.map((m, i) => (
                    <li key={i} className={`rounded-lg px-2.5 py-1.5 leading-relaxed ${m.role === "user" ? "bg-canvas" : "bg-primary-soft"}`}>
                      <span className="mr-1.5 text-[11px] text-ink-sub">{m.role === "user" ? "ゲスト" : m.role === "staff" ? "スタッフ" : "AI"}</span>
                      {m.content}
                    </li>
                  ))}
                  {h.messages.length === 0 && <li className="text-ink-sub">会話はありません（オーダーの遅延など）</li>}
                </ol>
              </div>
            </details>
          );
        })}
        {rows.length === 0 && <p className="px-5 py-4 text-sm text-ink-sub">該当する履歴はありません</p>}
      </section>
    </main>
  );
}
