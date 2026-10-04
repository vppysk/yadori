import { can, requireMember } from "@/server/auth";
import { getDutySettings } from "@/server/duties";
import { DutiesEditor } from "./duties-editor";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function DutiesPage() {
  const member = await requireMember("/admin/orders/duties");
  if (!(await can(member.id, "settings.items"))) return <main className="p-8 text-sm text-ink-sub">{tr("担当設定の権限がありません", "You don't have permission for duties")}</main>;
  return <DutiesEditor data={await getDutySettings(member.hotel_id)} />;
}
