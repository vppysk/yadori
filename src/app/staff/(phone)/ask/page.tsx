import { can, requireMember } from "@/server/auth";
import { listAskMessages } from "@/server/staff-ask";
import { AskView } from "./ask-view";

export const dynamic = "force-dynamic";

export default async function StaffAskPage() {
  const member = await requireMember("/staff/ask");
  if (!(await can(member.id, "handling.consult"))) {
    return <main className="p-6 text-sm text-ink-sub">AIへの相談の権限がありません</main>;
  }
  return <AskView messages={await listAskMessages(member)} />;
}
