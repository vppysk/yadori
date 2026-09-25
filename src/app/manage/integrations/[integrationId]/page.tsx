import Link from "next/link";
import { notFound } from "next/navigation";
import { can, requireMember } from "@/server/auth";
import { getIntegration, listIntegrations } from "@/server/integrations-admin";
import { listWebhooks } from "@/server/webhooks";
import { WebhookSection } from "./webhook-section";
import { IntegrationEditor } from "./integration-editor";

export default async function IntegrationPage({ params }: PageProps<"/manage/integrations/[integrationId]">) {
  const { integrationId } = await params;
  const member = await requireMember(`/manage/integrations/${integrationId}`);
  if (!(await can(member.id, "settings.integrations"))) return <p className="text-sm text-ink-sub">外部連携の権限がありません</p>;
  const [integrations, detail, webhooks] = await Promise.all([
    listIntegrations(member.hotel_id),
    getIntegration(member.hotel_id, integrationId),
    listWebhooks(member.hotel_id),
  ]);
  if (!detail) notFound();
  return (
    <div className="flex flex-1 flex-col gap-5 xl:flex-row">
      <aside aria-label="連携先" className="flex w-full shrink-0 flex-col gap-1.5 xl:w-[260px]">
        <h2 className="px-1 pb-1 text-sm font-bold text-ink-sub">連携先</h2>
        {integrations.map((i) => (
          <Link
            key={i.id}
            href={`/manage/integrations/${i.id}`}
            aria-current={i.id === integrationId ? "page" : undefined}
            className={`flex min-h-14 flex-col justify-center rounded-xl border px-3.5 ${i.id === integrationId ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}
          >
            <strong className="text-sm">{i.name}</strong>
            <span className="text-xs text-ink-sub">{i.kind === "mcp" ? "MCP ・ 読み取り／書き込み" : "読み取りのみ"}</span>
          </Link>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <IntegrationEditor key={detail.id} detail={detail} />
        <WebhookSection webhooks={webhooks} />
      </div>
    </div>
  );
}
