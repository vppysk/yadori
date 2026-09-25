import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { ManageTabs } from "./manage-tabs";

export const dynamic = "force-dynamic";

// 経営・管理者向け「AIチームの運営」（plan 4.3, 4.7）。上部タブで切り替える
export default async function ManageLayout({ children }: LayoutProps<"/manage">) {
  const member = await requireMember("/manage");
  const [keys, hotel] = await Promise.all([permissionKeys(member.id), getHotel(member.hotel_id)]);
  const tabs = [
    { href: "/manage", label: "担当範囲とコスト", allowed: keys.has("settings.ai_assignment") },
    { href: "/manage/policy", label: "指示とガードレール", allowed: keys.has("settings.ai_policy") },
    { href: "/manage/integrations", label: "外部連携", allowed: keys.has("settings.integrations") },
    { href: "/manage/history", label: "変更履歴", allowed: keys.has("settings.ai_assignment") || keys.has("settings.ai_policy") },
    { href: "/manage/masters", label: "マスタ", allowed: keys.has("settings.masters") },
    { href: "/manage/members", label: "メンバーと権限", allowed: keys.has("settings.members") },
  ].filter((t) => t.allowed);
  if (tabs.length === 0) {
    return <main className="p-8 text-sm text-ink-sub">この画面の権限がありません（AIの担当範囲・指示とガードレール・外部連携のいずれか）</main>;
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
