import { notFound } from "next/navigation";
import { getGuestSession } from "@/server/guest-chat";
import { GuestChat } from "./guest-chat";

export const dynamic = "force-dynamic";

export default async function GuestPage({ params }: PageProps<"/guest/[reservationId]">) {
  const { reservationId } = await params;
  const session = await getGuestSession(reservationId);
  if (!session) notFound();
  return <GuestChat reservationId={reservationId} initialSession={session} />;
}
