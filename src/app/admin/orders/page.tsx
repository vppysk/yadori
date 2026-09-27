import { can, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { assignCandidates, getBoard, getOrderForm, listSlots } from "@/server/order-board";
import { OrderBoard } from "./order-board";

export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  const member = await requireMember("/admin/orders");
  if (!(await can(member.id, "order.board.view"))) return <main className="p-8 text-sm text-ink-sub">オーダーボードの権限がありません</main>;
  const slots = await listSlots(member.hotel_id);
  const { slot } = await searchParams;
  const current = slots.find((s) => s.id === slot) ?? slots[0];
  if (!current) return <main className="p-8 text-sm text-ink-sub">担当の枠がありません</main>;
  const [board, candidates, canCreate, canReassign, hotel] = await Promise.all([
    getBoard(member.hotel_id, current.id),
    assignCandidates(member.hotel_id, current.id),
    can(member.id, "order.create"),
    can(member.id, "order.reassign", current.id),
    getHotel(member.hotel_id),
  ]);
  const form = canCreate ? await getOrderForm(member.hotel_id) : null;
  return (
    <OrderBoard slots={slots} slotId={current.id} board={board} candidates={candidates} form={form} canReassign={canReassign} timezone={hotel.timezone} />
  );
}
