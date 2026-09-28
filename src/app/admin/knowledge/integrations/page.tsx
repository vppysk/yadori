import Link from "next/link";
import { permissionKeys, requireMember } from "@/server/auth";
import { listIntegrations } from "@/server/integrations-admin";
import { INTEGRATION_USAGE_KEYS } from "../../nav-items";

export const dynamic = "force-dynamic";

// 連携の使い方の入口: どのシステムとつながっていて、AIが何をできるかの一覧（docs/007_ai_settings.md）
export default async function IntegrationUsageIndex() {
  const member = await requireMember("/admin/knowledge/integrations");
  const keys = await permissionKeys(member.id);
  if (!INTEGRATION_USAGE_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">連携の使い方を扱う権限がありません</main>;
  const integrations = await listIntegrations(member.hotel_id);
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">連携の使い方</h1>
        <p className="text-[13px] text-ink-sub">AIがつながっている外部のシステムです。連携先ごとに、AIが使えることを確かめて、使い方（利用ルール）を書いてください。</p>
      </div>
      <div className="grid max-w-4xl gap-3 md:grid-cols-2">
        {integrations.map((i) => (
          <Link key={i.id} href={`/admin/knowledge/integrations/${i.id}`} className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface px-5 py-4 hover:border-primary">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-base">{i.name}</strong>
              <span className={`rounded-md px-2 py-0.5 text-xs ${i.active ? "bg-primary-soft text-primary" : "bg-muted text-ink-sub"}`}>{i.active ? "使用中" : "停止中"}</span>
            </div>
            <span className="text-sm text-ink-sub">AIが使えること {i.ai_tools}件</span>
            {i.pending_writes > 0 && <span className="text-sm font-bold text-caution">確認待ちの書き込み {i.pending_writes}件</span>}
          </Link>
        ))}
      </div>
      {integrations.length === 0 && <p className="text-sm text-ink-sub">つながっているシステムはありません（接続は経営画面の外部連携で設定します）</p>}
    </main>
  );
}
