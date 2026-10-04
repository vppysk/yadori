import { permissionKeys, requireMember } from "@/server/auth";
import { queryOne } from "@/server/db";
import { listIntegrations } from "@/server/integrations-admin";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { countUnseenUpdates } from "@/server/source-fetch";
import { FACILITY_KEYS, GUEST_AI_KEYS, INTEGRATION_USAGE_KEYS } from "../nav-items";
import { KnowledgeNav } from "./knowledge-nav";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// AIの設定（旧 案内情報。docs/007_ai_settings.md）。AIのどこに効くかでまとめる（答える内容はゲストとスタッフのAI相談の共通、答え方はゲスト向け）:
// 答える内容（未回答の質問・資料・施設ごとの内容。docs/006_guide_info.md）、答え方（指示）、連携の使い方（利用ルール・確認待ちの書き込み）。
// 左の一覧は権限ごとに出し分ける（グループはプリセットで、権限は個別に付けられるため。plan 4.8）
export default async function KnowledgeLayout({ children }: LayoutProps<"/admin/knowledge">) {
  const member = await requireMember("/admin/knowledge");
  const keys = await permissionKeys(member.id);
  if (!GUEST_AI_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">{tr("AIの設定を扱う権限がありません", "You don't have permission for AI settings")}</main>;
  const showQuestions = keys.has("knowledge.question.answer");
  const showSources = keys.has("knowledge.facility.edit");
  const showFacilities = FACILITY_KEYS.some((k) => keys.has(k));
  const showInstructions = keys.has("settings.ai_policy");
  const showIntegrations = INTEGRATION_USAGE_KEYS.some((k) => keys.has(k));
  const [facilities, pending, unseen, integrations] = await Promise.all([
    showFacilities ? listFacilitiesForAdmin(member.hotel_id) : [],
    showSources
      ? queryOne<{ count: number }>("select count(*)::int count from info_sources where hotel_id = $1 and status <> 'approved'", [member.hotel_id])
      : undefined,
    showSources ? countUnseenUpdates(member.hotel_id) : 0,
    showIntegrations ? listIntegrations(member.hotel_id) : [],
  ]);
  return (
    <>
      <KnowledgeNav
        facilities={facilities}
        showQuestions={showQuestions}
        showSources={showSources}
        showInstructions={showInstructions}
        integrations={showIntegrations ? integrations.map((i) => ({ id: i.id, name: i.name, pending: i.pending_writes })) : null}
        pendingSources={pending?.count ?? 0}
        unseenUpdates={unseen}
      />
      {children}
    </>
  );
}
