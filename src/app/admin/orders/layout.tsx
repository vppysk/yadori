import { permissionKeys, requireMember } from "@/server/auth";
import { ORDER_KEYS } from "../nav-items";
import { OrdersNav } from "./orders-nav";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// オーダー管理（plan 4.2、docs/005_order.md）。担当設定・オーダー状況と、マスタ設定（エリア・品目）
export default async function OrdersLayout({ children }: LayoutProps<"/admin/orders">) {
  const member = await requireMember("/admin/orders");
  const keys = await permissionKeys(member.id);
  if (!ORDER_KEYS.some((k) => keys.has(k))) return <main className="p-8 text-sm text-ink-sub">{tr("オーダー管理の権限がありません", "You don't have permission for orders")}</main>;
  return (
    <>
      <OrdersNav showBoard={keys.has("order.board.view")} showSettings={keys.has("settings.items")} />
      {children}
    </>
  );
}
