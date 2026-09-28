import { redirect } from "next/navigation";
import { permissionKeys, requireMember } from "@/server/auth";

export const dynamic = "force-dynamic";

// オーダー管理の入口は、見られるもののうち日々使う画面（オーダー状況 → 担当設定）
export default async function OrdersIndex() {
  const member = await requireMember("/admin/orders");
  const keys = await permissionKeys(member.id);
  if (keys.has("order.board.view")) redirect("/admin/orders/board");
  if (keys.has("settings.items")) redirect("/admin/orders/duties");
  return <main className="p-8 text-sm text-ink-sub">オーダー管理の権限がありません</main>;
}
