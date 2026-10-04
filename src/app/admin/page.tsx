import { redirect } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";
import { adminNavItems } from "./nav-items";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// 管理PCにホームはない。サイドバーの一番上（見られるもののうち）に移る
export default async function AdminIndex() {
  const member = await requireMember("/admin");
  const items = adminNavItems(await permissionKeys(member.id));
  if (!items[0]) return <main className="p-8 text-sm text-ink-sub">{tr("管理PCで使える機能の権限がありません", "You don't have permission for any admin features")}</main>;
  redirect(items[0].href);
}
