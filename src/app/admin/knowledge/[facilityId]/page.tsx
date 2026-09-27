import { notFound } from "next/navigation";
import { can, permissionKeys, requireMember } from "@/server/auth";
import { listDocuments } from "@/server/documents";
import { getFacilityView } from "@/server/knowledge-admin";
import { DocumentsSection } from "./documents-section";
import { FACILITY_KEYS } from "../../nav-items";
import { FacilityView } from "./facility-view";

export const dynamic = "force-dynamic";

// 施設の案内している内容（承認済みの資料から）と特記事項。「全体」欄には案内・マニュアル（RAG）も入れる（plan 4.1, 4.6）
export default async function FacilityPage({ params }: PageProps<"/admin/knowledge/[facilityId]">) {
  const { facilityId } = await params;
  const member = await requireMember(`/admin/knowledge/${facilityId}`);
  // 未回答の質問の権限だけの人には施設の内容を見せない（左の一覧にも出さない）
  const keys = await permissionKeys(member.id);
  if (!FACILITY_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">施設の情報を見る権限がありません</main>;
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
