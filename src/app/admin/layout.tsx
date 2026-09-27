import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { AdminNav } from "./admin-nav";
import { adminNavItems } from "./nav-items";

export const dynamic = "force-dynamic";

// 管理PC（plan 4.6）。メニューはログインしたメンバーの権限で出し分ける（plan 4.8）
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const member = await requireMember("/admin");
  const [keys, hotel] = await Promise.all([permissionKeys(member.id), getHotel(member.hotel_id)]);
  const items = adminNavItems(keys);
  return (
    <div className="flex min-h-dvh bg-canvas text-ink">
      <AdminNav hotelName={hotel.name} memberName={member.display_name} items={items} />
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}
