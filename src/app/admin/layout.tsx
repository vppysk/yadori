import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { listOpenQuestions } from "@/server/questions";
import { AdminNav, type AdminNavItem } from "./admin-nav";

export const dynamic = "force-dynamic";

// 管理PC（plan 4.6）。メニューはログインしたメンバーの権限で出し分ける（plan 4.8）
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const member = await requireMember("/admin");
  const [keys, hotel, questions] = await Promise.all([
    permissionKeys(member.id),
    getHotel(member.hotel_id),
    listOpenQuestions(member.hotel_id),
  ]);
  const items: AdminNavItem[] = [
    { href: "/admin", label: "ホーム", exact: true },
    { href: "/admin/orders", label: "オーダー", allowed: keys.has("order.board.view") },
    {
      href: "/admin/knowledge",
      label: "館内の情報",
      allowed: keys.has("knowledge.facility.edit") || keys.has("knowledge.notice.edit") || keys.has("knowledge.document.register"),
    },
    { href: "/admin/items", label: "品目・担当設定", allowed: keys.has("settings.items") },
    { href: "/admin/sources", label: "外部の情報源", allowed: keys.has("knowledge.source.edit") },
    { href: "/admin#questions", label: "未回答の質問", badge: questions.length, allowed: keys.has("knowledge.question.answer") },
    { href: "/admin/handoffs", label: "対応アラート", allowed: keys.has("handling.complaint.view") },
  ];
  return (
    <div className="flex min-h-dvh bg-canvas text-ink">
      <AdminNav hotelName={hotel.name} memberName={member.display_name} items={items.filter((i) => i.allowed !== false)} />
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}
