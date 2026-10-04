import { redirect } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { FACILITY_KEYS, INTEGRATION_USAGE_KEYS } from "../nav-items";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// AIの設定の入口は、左の一覧の一番上（未回答の質問 → 資料 → 指示 → 連携の使い方 → 施設の順で、見られるもの）
export default async function KnowledgeIndex() {
  const member = await requireMember("/admin/knowledge");
  const keys = await permissionKeys(member.id);
  if (keys.has("knowledge.question.answer")) redirect("/admin/knowledge/questions");
  if (keys.has("knowledge.facility.edit")) redirect("/admin/knowledge/sources");
  if (keys.has("settings.ai_policy")) redirect("/admin/knowledge/instructions");
  if (INTEGRATION_USAGE_KEYS.some((k) => keys.has(k))) redirect("/admin/knowledge/integrations");
  if (!FACILITY_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">{tr("AIの設定を扱う権限がありません", "You don't have permission for AI settings")}</main>;
  const facilities = await listFacilitiesForAdmin(member.hotel_id);
  // 案内・マニュアルの権限だけなら、それが入っている「全体」欄を開く
  const documentsOnly = !keys.has("knowledge.facility.edit") && !keys.has("knowledge.notice.edit");
  const first = facilities.find((f) => f.kind === (documentsOnly ? "global" : "facility")) ?? facilities[0];
  if (!first) return <main className="p-8 text-sm text-ink-sub">{tr("施設が登録されていません", "No facilities yet")}</main>;
  redirect(`/admin/knowledge/${first.id}`);
}
