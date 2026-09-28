import { can, requireMember } from "@/server/auth";
import { listIntegrations } from "@/server/integrations-admin";
import { listWebhooks } from "@/server/webhooks";
import { IntegrationsAside } from "./integrations-aside";
import { WebhookSection } from "./webhook-section";

// 外部連携の「つなぐ」（docs/007_ai_settings.md）: 連携先（MCPサーバー）の接続と、AIに使わせるツール。
// 利用ルールと書き込みの確認は、現場が扱うため管理PCの「AIの設定」にある。実績の出力口（Webhook）もここ
export default async function IntegrationsLayout({ children }: LayoutProps<"/manage/integrations">) {
  const member = await requireMember("/manage/integrations");
  if (!(await can(member.id, "settings.integrations"))) return <p className="text-sm text-ink-sub">外部連携の権限がありません</p>;
  const [integrations, webhooks] = await Promise.all([listIntegrations(member.hotel_id), listWebhooks(member.hotel_id)]);
  return (
    <div className="flex flex-1 flex-col gap-5 xl:flex-row">
      <IntegrationsAside integrations={integrations} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {children}
        <WebhookSection webhooks={webhooks} />
      </div>
    </div>
  );
}
