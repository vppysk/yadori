import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { ManageTabs } from "./manage-tabs";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// 経営・管理者向け「AIチームの運営」（plan 4.3, 4.7）。上部タブで切り替える。
// ゲスト対応AIの指示と連携の利用ルールは現場が書くため管理PCの「AIの設定」にある（docs/007_ai_settings.md）
export default async function ManageLayout({ children }: LayoutProps<"/manage">) {
  const member = await requireMember("/manage");
  const [keys, hotel] = await Promise.all([permissionKeys(member.id), getHotel(member.hotel_id)]);
  const tabs = [
    { href: "/manage", label: tr("AIの成果", "AI results"), allowed: keys.has("settings.ai_assignment") },
    { href: "/manage/models", label: tr("モデルの見直し", "Model review"), allowed: keys.has("settings.ai_assignment") },
    { href: "/manage/integrations", label: tr("外部連携", "Integrations"), allowed: keys.has("settings.integrations") },
    { href: "/manage/history", label: tr("変更履歴", "History"), allowed: ["settings.ai_assignment", "settings.ai_policy", "settings.integrations"].some((k) => keys.has(k)) },
    { href: "/manage/members", label: tr("メンバーと権限", "Members & permissions"), allowed: keys.has("settings.members") },
  ].filter((t) => t.allowed);
  if (tabs.length === 0) {
    return <main className="p-8 text-sm text-ink-sub">{tr("この画面の権限がありません（AIの成果とモデルの見直し・外部連携・メンバーと権限のいずれか）", "You don't have permission for this page (AI results & model review, integrations, or members & permissions)")}</main>;
  }
  return (
    <div className="flex min-h-dvh flex-col gap-4.5 bg-canvas px-9 pt-7 pb-8 text-ink">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-mincho text-base font-semibold">{hotel.name}</div>
          <h1 className="text-[26px] font-bold whitespace-nowrap">{tr("AIチームの運営", "Running the AI team")}</h1>
        </div>
        <ManageTabs tabs={tabs.map(({ href, label }) => ({ href, label }))} />
      </header>
      {children}
    </div>
  );
}
