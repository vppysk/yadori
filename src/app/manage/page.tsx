import { can, requireMember } from "@/server/auth";
import { getDashboard } from "@/server/dashboard";
import { Dashboard } from "./dashboard";

export default async function ManagePage() {
  const member = await requireMember("/manage");
  const [canPlan, canAssumptions] = await Promise.all([can(member.id, "settings.ai_assignment"), can(member.id, "settings.masters")]);
  if (!canPlan) return <p className="text-sm text-ink-sub">AIの成果とモデルの見直しの権限がありません</p>;
  return <Dashboard data={await getDashboard(member.hotel_id)} canEditAssumptions={canAssumptions} />;
}
