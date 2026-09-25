import { can, requireMember } from "@/server/auth";
import { getMasters } from "@/server/masters";
import { MastersEditor } from "./masters-editor";

export default async function MastersPage() {
  const member = await requireMember("/manage/masters");
  if (!(await can(member.id, "settings.masters"))) return <p className="text-sm text-ink-sub">マスタの権限がありません</p>;
  return <MastersEditor masters={await getMasters(member.hotel_id)} />;
}
