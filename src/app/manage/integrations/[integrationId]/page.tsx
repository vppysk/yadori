import { notFound } from "next/navigation";
import { requireMember } from "@/server/auth";
import { getConnection } from "@/server/integrations-admin";
import { ConnectionEditor } from "./connection-editor";

export default async function IntegrationPage({ params }: PageProps<"/manage/integrations/[integrationId]">) {
  const { integrationId } = await params;
  const member = await requireMember(`/manage/integrations/${integrationId}`);
  const detail = await getConnection(member.hotel_id, integrationId);
  if (!detail) notFound();
  return <ConnectionEditor key={detail.id} detail={detail} />;
}
