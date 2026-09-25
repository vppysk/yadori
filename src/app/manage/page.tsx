import { can, requireMember } from "@/server/auth";
import { getDashboard } from "@/server/dashboard";
import { Dashboard } from "./dashboard";

export default async function ManagePage() {
  const member = await requireMember("/manage");
  if (!(await can(member.id, "settings.ai_assignment"))) {
    return <p className="text-sm text-ink-sub">AIの担当範囲とコストの権限がありません</p>;
  }
  return <Dashboard data={await getDashboard(member.hotel_id)} />;
}
