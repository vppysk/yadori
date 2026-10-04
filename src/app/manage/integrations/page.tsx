import { redirect } from "next/navigation";
import { requireMember } from "@/server/auth";
import { listIntegrations } from "@/server/integrations-admin";
import { tr } from "@/lib/i18n";

export default async function IntegrationsIndex() {
  const member = await requireMember("/manage/integrations");
  const [first] = await listIntegrations(member.hotel_id);
  if (!first) return <p className="text-sm text-ink-sub">{tr("連携先がありません。左の欄から追加してください。", "No connections yet. Add one from the left.")}</p>;
  redirect(`/manage/integrations/${first.id}`);
}
