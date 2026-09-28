import { permissionKeys, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { getMyDuties, listMyTickets, listOpenHandoffs, loadSummary } from "@/server/staff-work";
import { OrdersView } from "./orders-view";

export const dynamic = "force-dynamic";

// 経過時間の表示の基準（サーバーとクライアントで同じ値から始めてハイドレーションのずれを防ぐ）
function requestTime() {
  return Date.now();
}

export default async function StaffOrdersPage() {
  const member = await requireMember("/staff/orders");
  const keys = await permissionKeys(member.id);
  const canHandoff = keys.has("handling.handoff.accept");
  const [duties, tickets, load, handoffs, hotel] = await Promise.all([
    keys.has("order.assignable") ? getMyDuties(member) : null,
    listMyTickets(member.id),
    loadSummary(member),
    canHandoff ? listOpenHandoffs(member.hotel_id) : [],
    getHotel(member.hotel_id),
  ]);
  return (
    <OrdersView
      memberName={member.display_name}
      duties={duties}
      tickets={tickets}
      load={load ?? null}
      // 他の人が引き受けた引き継ぎは表示しない
      handoffs={handoffs.filter((h) => h.status === "open" || h.accepted_by_name === member.display_name)}
      serverNow={requestTime()}
      timezone={hotel.timezone}
    />
  );
}
