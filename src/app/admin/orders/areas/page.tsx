import { can, requireMember } from "@/server/auth";
import { getAreaSettings } from "@/server/items";
import { AreasEditor } from "./areas-editor";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function AreasPage() {
  const member = await requireMember("/admin/orders/areas");
  if (!(await can(member.id, "settings.items"))) return <main className="p-8 text-sm text-ink-sub">{tr("エリア設定の権限がありません", "You don't have permission for areas")}</main>;
  return <AreasEditor data={await getAreaSettings(member.hotel_id)} />;
}
