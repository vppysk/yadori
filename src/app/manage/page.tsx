import { can, requireMember } from "@/server/auth";
import { getDashboard } from "@/server/dashboard";
import { Dashboard } from "./dashboard";
import { tr } from "@/lib/i18n";

export default async function ManagePage() {
  const member = await requireMember("/manage");
  const [canPlan, canAssumptions] = await Promise.all([can(member.id, "settings.ai_assignment"), can(member.id, "settings.masters")]);
  if (!canPlan) return <p className="text-sm text-ink-sub">{tr("AIの成果とモデルの見直しの権限がありません", "You don't have permission for AI results and model review")}</p>;
  return <Dashboard data={await getDashboard(member.hotel_id)} canEditAssumptions={canAssumptions} />;
}
