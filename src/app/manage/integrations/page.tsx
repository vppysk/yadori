import { redirect } from "next/navigation";
import { requireMember } from "@/server/auth";
import { listIntegrations } from "@/server/integrations-admin";

export default async function IntegrationsIndex() {
  const member = await requireMember("/manage/integrations");
  const [first] = await listIntegrations(member.hotel_id);
  if (!first) return <p className="text-sm text-ink-sub">連携先がありません</p>;
  redirect(`/manage/integrations/${first.id}`);
}
