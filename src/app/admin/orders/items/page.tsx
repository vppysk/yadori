import { can, requireMember } from "@/server/auth";
import { getItemSettings } from "@/server/items";
import { ItemsEditor } from "./items-editor";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function ItemsPage() {
  const member = await requireMember("/admin/orders/items");
  if (!(await can(member.id, "settings.items"))) return <main className="p-8 text-sm text-ink-sub">{tr("品目設定の権限がありません", "You don't have permission for items")}</main>;
  const data = await getItemSettings(member.hotel_id);
  return <ItemsEditor data={data} />;
}
