import { redirect } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { FACILITY_KEYS } from "../nav-items";

export const dynamic = "force-dynamic";

// 案内情報の入口は、左の一覧の一番上（未回答の質問 → 資料 → 施設の順で、見られるもの）
export default async function KnowledgeIndex() {
  const member = await requireMember("/admin/knowledge");
  const keys = await permissionKeys(member.id);
  if (keys.has("knowledge.question.answer")) redirect("/admin/knowledge/questions");
  if (keys.has("knowledge.facility.edit")) redirect("/admin/knowledge/sources");
  if (!FACILITY_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">案内情報を扱う権限がありません</main>;
  const facilities = await listFacilitiesForAdmin(member.hotel_id);
  // 案内・マニュアルの権限だけなら、それが入っている「全体」欄を開く
  const documentsOnly = !keys.has("knowledge.facility.edit") && !keys.has("knowledge.notice.edit");
  const first = facilities.find((f) => f.kind === (documentsOnly ? "global" : "facility")) ?? facilities[0];
  if (!first) return <main className="p-8 text-sm text-ink-sub">施設が登録されていません</main>;
  redirect(`/admin/knowledge/${first.id}`);
}
