import { notFound } from "next/navigation";
import { can, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { getAskSession, listAskSessions } from "@/server/staff-ask";
import { AskView } from "../ask-view";

export const dynamic = "force-dynamic";

export default async function StaffAskSessionPage({ params }: PageProps<"/staff/ask/[id]">) {
  const { id } = await params;
  const member = await requireMember(`/staff/ask/${id}`);
  if (!(await can(member.id, "handling.consult"))) {
    return <main className="p-6 text-sm text-ink-sub">AIへの相談の権限がありません</main>;
  }
  const [session, sessions, canViewGuests, hotel] = await Promise.all([
    getAskSession(member, id),
    listAskSessions(member),
    can(member.id, "handling.consult.guest"),
    getHotel(member.hotel_id),
  ]);
  if (!session) notFound();
  return <AskView key={session.id} session={session} sessions={sessions} canViewGuests={canViewGuests} timezone={hotel.timezone} />;
}
