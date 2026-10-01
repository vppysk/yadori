import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { ManageTabs } from "./manage-tabs";

export const dynamic = "force-dynamic";

// 経営・管理者向け「AIチームの運営」（plan 4.3, 4.7）。上部タブで切り替える。
// ゲスト対応AIの指示と連携の利用ルールは現場が書くため管理PCの「AIの設定」にある（docs/007_ai_settings.md）
export default async function ManageLayout({ children }: LayoutProps<"/manage">) {
  const member = await requireMember("/manage");
  const [keys, hotel] = await Promise.all([permissionKeys(member.id), getHotel(member.hotel_id)]);
  const tabs = [
    { href: "/manage", label: "AIの成果", allowed: keys.has("settings.ai_assignment") },
    { href: "/manage/models", label: "モデルの見直し", allowed: keys.has("settings.ai_assignment") },
    { href: "/manage/integrations", label: "外部連携", allowed: keys.has("settings.integrations") },
    { href: "/manage/history", label: "変更履歴", allowed: ["settings.ai_assignment", "settings.ai_policy", "settings.integrations"].some((k) => keys.has(k)) },
    { href: "/manage/members", label: "メンバーと権限", allowed: keys.has("settings.members") },
  ].filter((t) => t.allowed);
  if (tabs.length === 0) {
    return <main className="p-8 text-sm text-ink-sub">この画面の権限がありません（AIの成果とモデルの見直し・外部連携・メンバーと権限のいずれか）</main>;
  }
  return (
    <div className="flex min-h-dvh flex-col gap-4.5 bg-canvas px-9 pt-7 pb-8 text-ink">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-mincho text-base font-semibold">{hotel.name}</div>
          <h1 className="text-[26px] font-bold whitespace-nowrap">AIチームの運営</h1>
        </div>
        <ManageTabs tabs={tabs.map(({ href, label }) => ({ href, label }))} />
      </header>
      {children}
    </div>
  );
}
