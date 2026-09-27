import { permissionKeys, requireMember } from "@/server/auth";
import { queryOne } from "@/server/db";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { KnowledgeNav } from "./knowledge-nav";

export const dynamic = "force-dynamic";

// 館内の情報（plan 4.1）。資料（読み取り→確認→承認）と、施設ごとの案内している内容・特記事項
export default async function KnowledgeLayout({ children }: LayoutProps<"/admin/knowledge">) {
  const member = await requireMember("/admin/knowledge");
  const [facilities, keys, pending] = await Promise.all([
    listFacilitiesForAdmin(member.hotel_id),
    permissionKeys(member.id),
    queryOne<{ count: number }>("select count(*)::int count from info_sources where hotel_id = $1 and status = 'pending'", [member.hotel_id]),
  ]);
  return (
    <>
      <KnowledgeNav facilities={facilities} showSources={keys.has("knowledge.facility.edit")} pendingSources={pending?.count ?? 0} />
      {children}
    </>
  );
}
