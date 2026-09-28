import { can, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { assignCandidates, getBoard, getOrderForm, listAreas } from "@/server/order-board";
import { OrderBoard } from "./order-board";

export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: PageProps<"/admin/orders/board">) {
  const member = await requireMember("/admin/orders/board");
  if (!(await can(member.id, "order.board.view"))) return <main className="p-8 text-sm text-ink-sub">オーダーボードの権限がありません</main>;
  const areas = await listAreas(member.hotel_id);
  const { area } = await searchParams;
  const areaId = areas.find((a) => a.id === area)?.id ?? null;
  const [board, candidates, canCreate, hotel] = await Promise.all([
    getBoard(member.hotel_id, areaId, member.id),
    assignCandidates(member.hotel_id),
    can(member.id, "order.create"),
    getHotel(member.hotel_id),
  ]);
  const form = canCreate ? await getOrderForm(member.hotel_id) : null;
  return (
    <OrderBoard areas={areas} areaId={areaId} board={board} candidates={candidates} form={form} timezone={hotel.timezone} />
  );
}
