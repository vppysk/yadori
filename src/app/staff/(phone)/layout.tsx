import { requireMember } from "@/server/auth";
import { unreadCount } from "@/server/staff-work";
import { PhoneNav } from "./phone-nav";

export const dynamic = "force-dynamic";

// 現場スマホ（plan 4.6）: 下部タブ オーダー／AIに相談／通知。情報の登録・編集機能は持たせない
export default async function PhoneLayout({ children }: LayoutProps<"/staff">) {
  const member = await requireMember("/staff/orders");
  const unread = await unreadCount(member.id);
  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-canvas text-ink">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <PhoneNav unread={unread} />
    </div>
  );
}
