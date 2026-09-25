import { can, requireMember } from "@/server/auth";
import { getPolicy } from "@/server/policy";
import { PolicyEditor } from "./policy-editor";

export default async function PolicyPage() {
  const member = await requireMember("/manage/policy");
  if (!(await can(member.id, "settings.ai_policy"))) return <p className="text-sm text-ink-sub">指示とガードレールの権限がありません</p>;
  return <PolicyEditor policy={await getPolicy(member.hotel_id)} />;
}
