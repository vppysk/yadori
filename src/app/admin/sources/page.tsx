import { can, requireMember } from "@/server/auth";
import { listSources } from "@/server/external-sources";
import { getHotel, localNow } from "@/server/hotel";
import { tavilyConfigured } from "@/server/integrations/web-fetch";
import { SourcesView } from "./sources-view";

export const dynamic = "force-dynamic";

// 外部の情報源（plan 4.1）。運行情報・天気予報・イベントの公式サイトなどのURLを登録し、定期的に取得してAIが要約する
export default async function SourcesPage() {
  const member = await requireMember("/admin/sources");
  if (!(await can(member.id, "knowledge.source.edit"))) return <main className="p-8 text-sm text-ink-sub">外部の情報源の権限がありません</main>;
  const [sources, hotel] = await Promise.all([listSources(member.hotel_id), getHotel(member.hotel_id)]);
  const now = localNow(hotel.timezone);
  return <SourcesView sources={sources} nowLocal={`${now.date}T${now.time}`} apiKeyConfigured={tavilyConfigured()} />;
}
