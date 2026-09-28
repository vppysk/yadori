import { can, requireMember } from "@/server/auth";
import { getHotel } from "@/server/hotel";
import { getMyDuties, listMyTickets, loadSummary } from "@/server/staff-work";
import { OrdersView } from "./orders-view";

export const dynamic = "force-dynamic";

// 経過時間の表示の基準（サーバーとクライアントで同じ値から始めてハイドレーションのずれを防ぐ）
function requestTime() {
  return Date.now();
}

export default async function StaffOrdersPage() {
  const member = await requireMember("/staff/orders");
  const assignable = await can(member.id, "order.assignable");
  const [duties, tickets, load, hotel] = await Promise.all([
    assignable ? getMyDuties(member) : null,
    listMyTickets(member.id),
    loadSummary(member),
    getHotel(member.hotel_id),
  ]);
  return (
    <OrdersView
      memberName={member.display_name}
      duties={duties}
      tickets={tickets}
      load={load ?? null}
      serverNow={requestTime()}
      timezone={hotel.timezone}
    />
  );
}
