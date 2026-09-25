import { can, requireMember } from "@/server/auth";
import { assignableMembers, getBoard, listSlots } from "@/server/order-board";
import { OrderBoard } from "./order-board";

export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  const member = await requireMember("/admin/orders");
  if (!(await can(member.id, "order.board.view"))) return <main className="p-8 text-sm text-ink-sub">オーダーボードの権限がありません</main>;
  const slots = await listSlots(member.hotel_id);
  const { slot } = await searchParams;
  const current = slots.find((s) => s.id === slot) ?? slots[0];
  if (!current) return <main className="p-8 text-sm text-ink-sub">担当の枠がありません</main>;
  const [board, candidates, canCreate, canReassign] = await Promise.all([
    getBoard(member.hotel_id, current.id),
    assignableMembers(member.hotel_id, current.id),
    can(member.id, "order.create"),
    can(member.id, "order.reassign", current.id),
  ]);
  return <OrderBoard slots={slots} slotId={current.id} board={board} candidates={candidates} canCreate={canCreate} canReassign={canReassign} />;
}
