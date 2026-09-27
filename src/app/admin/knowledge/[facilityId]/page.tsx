import { notFound } from "next/navigation";
import { can, requireMember } from "@/server/auth";
import { listDocuments } from "@/server/documents";
import { getFacilityView } from "@/server/knowledge-admin";
import { DocumentsSection } from "./documents-section";
import { FacilityView } from "./facility-view";

export const dynamic = "force-dynamic";

// 施設の案内している内容（承認済みの資料から）と特記事項。「全体」欄には案内・マニュアル（RAG）も入れる（plan 4.1, 4.6）
export default async function FacilityPage({ params }: PageProps<"/admin/knowledge/[facilityId]">) {
  const { facilityId } = await params;
  const member = await requireMember(`/admin/knowledge/${facilityId}`);
  const [view, canNotice, canDocuments] = await Promise.all([
    getFacilityView(member.hotel_id, facilityId),
    can(member.id, "knowledge.notice.edit", facilityId),
    can(member.id, "knowledge.document.register"),
  ]);
  if (!view) notFound();
  const documents = view.kind === "global" && canDocuments ? await listDocuments(member.hotel_id) : null;
  return (
    <FacilityView key={facilityId} data={view} canNotice={canNotice}>
      {documents && <DocumentsSection documents={documents} />}
    </FacilityView>
  );
}
