import { can, requireMember } from "@/server/auth";
import { listSources } from "@/server/info-sources";
import { SourcesView } from "./sources-view";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// 資料（docs/002_facility_master_design.md）: 登録するとAIが施設・項目ごとに読み取り、確認して承認すると案内に使われる
export default async function SourcesPage() {
  const member = await requireMember("/admin/knowledge/sources");
  if (!(await can(member.id, "knowledge.facility.edit"))) return <main className="p-8 text-sm text-ink-sub">{tr("資料を登録する権限がありません", "You don't have permission to add sources")}</main>;
  return <SourcesView sources={await listSources(member.hotel_id)} />;
}
