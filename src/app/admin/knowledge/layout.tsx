import { permissionKeys, requireMember } from "@/server/auth";
import { queryOne } from "@/server/db";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { FACILITY_KEYS, KNOWLEDGE_KEYS } from "../nav-items";
import { KnowledgeNav } from "./knowledge-nav";

export const dynamic = "force-dynamic";

// 館内の情報（plan 4.1）。未回答の質問、資料（読み取り→確認→承認）、施設ごとの案内している内容・特記事項。
// 左の一覧は権限ごとに出し分ける（グループはプリセットで、権限は個別に付けられるため。plan 4.8）
export default async function KnowledgeLayout({ children }: LayoutProps<"/admin/knowledge">) {
  const member = await requireMember("/admin/knowledge");
  const keys = await permissionKeys(member.id);
  if (!KNOWLEDGE_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">館内の情報を扱う権限がありません</main>;
  const showQuestions = keys.has("knowledge.question.answer");
  const showSources = keys.has("knowledge.facility.edit");
  const showFacilities = FACILITY_KEYS.some((k) => keys.has(k));
  const [facilities, pending] = await Promise.all([
    showFacilities ? listFacilitiesForAdmin(member.hotel_id) : [],
    showSources
      ? queryOne<{ count: number }>("select count(*)::int count from info_sources where hotel_id = $1 and status = 'pending'", [member.hotel_id])
      : undefined,
  ]);
  return (
    <>
      <KnowledgeNav
        facilities={facilities}
        showQuestions={showQuestions}
        showSources={showSources}
        pendingSources={pending?.count ?? 0}
      />
      {children}
    </>
  );
}
