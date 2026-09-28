import { can, requireMember } from "@/server/auth";
import { getAreaSettings } from "@/server/items";
import { AreasEditor } from "./areas-editor";

export const dynamic = "force-dynamic";

export default async function AreasPage() {
  const member = await requireMember("/admin/orders/areas");
  if (!(await can(member.id, "settings.items"))) return <main className="p-8 text-sm text-ink-sub">エリア設定の権限がありません</main>;
  return <AreasEditor data={await getAreaSettings(member.hotel_id)} />;
}
