import { notFound } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";
import { getUsage } from "@/server/integrations-admin";
import { INTEGRATION_USAGE_KEYS } from "../../../nav-items";
import { UsageEditor } from "./usage-editor";

export const dynamic = "force-dynamic";

// 連携先ごとの使い方: AIが使えること（/manage で許可したツール。見るだけ）、利用ルール、確認待ちの書き込み
export default async function IntegrationUsagePage({ params }: PageProps<"/admin/knowledge/integrations/[integrationId]">) {
  const { integrationId } = await params;
  const member = await requireMember(`/admin/knowledge/integrations/${integrationId}`);
  const keys = await permissionKeys(member.id);
  if (!INTEGRATION_USAGE_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">連携の使い方を扱う権限がありません</main>;
  const usage = await getUsage(member.hotel_id, integrationId);
  if (!usage) notFound();
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">{usage.name}</h1>
        <p className="text-[13px] text-ink-sub">
          {usage.active ? "AIがこのシステムを使うときの決まりです。" : "この連携先は停止中です（AIは使いません）。"}
        </p>
      </div>
      <UsageEditor key={usage.id} usage={usage} canEditRule={keys.has("settings.integration_rules")} canConfirm={keys.has("handling.integration_write.confirm")} />
    </main>
  );
}
