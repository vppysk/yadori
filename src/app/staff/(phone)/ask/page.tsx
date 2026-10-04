import { can, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { listAskSessions } from "@/server/staff-ask";
import { AskView } from "./ask-view";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// 新しい会話（最初の質問を送ったときに会話を作り、/staff/ask/[id] に移る）
export default async function StaffAskPage() {
  const member = await requireMember("/staff/ask");
  if (!(await can(member.id, "handling.consult"))) {
    return <main className="p-6 text-sm text-ink-sub">{tr("AIへの相談の権限がありません", "You don't have permission to ask the AI")}</main>;
  }
  const [sessions, canViewGuests, hotel] = await Promise.all([listAskSessions(member), can(member.id, "handling.consult.guest"), getHotel(member.hotel_id)]);
  return <AskView key="new" session={null} sessions={sessions} canViewGuests={canViewGuests} timezone={hotel.timezone} />;
}
