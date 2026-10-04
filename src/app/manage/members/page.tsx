import { can, requireMember } from "@/server/auth";
import { getMembersData } from "@/server/members";
import { MembersEditor } from "./members-editor";
import { tr } from "@/lib/i18n";

export default async function MembersPage() {
  const member = await requireMember("/manage/members");
  if (!(await can(member.id, "settings.members"))) return <p className="text-sm text-ink-sub">{tr("メンバーと権限の管理の権限がありません", "You don't have permission to manage members")}</p>;
  return <MembersEditor data={await getMembersData(member.hotel_id)} />;
}
