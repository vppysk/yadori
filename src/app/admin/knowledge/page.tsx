import { redirect } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";

export const dynamic = "force-dynamic";

export default async function KnowledgeIndex() {
  const member = await requireMember("/admin/knowledge");
  const [facilities, keys] = await Promise.all([listFacilitiesForAdmin(member.hotel_id), permissionKeys(member.id)]);
  // 館内の情報の入口は資料（読み取り→確認→承認）
  if (keys.has("knowledge.facility.edit")) redirect("/admin/knowledge/sources");
  // 案内・マニュアルの権限だけなら、それが入っている「全体」欄を開く
  const documentsOnly = !keys.has("knowledge.facility.edit") && !keys.has("knowledge.notice.edit");
  const first = facilities.find((f) => f.kind === (documentsOnly ? "global" : "facility")) ?? facilities[0];
  if (!first) return <main className="p-8 text-sm text-ink-sub">施設が登録されていません</main>;
  redirect(`/admin/knowledge/${first.id}`);
}
