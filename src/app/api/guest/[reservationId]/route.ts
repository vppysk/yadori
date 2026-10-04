import { cancelOrder, cancelStaffRequest, getGuestSession, handleGuestMessage, nudgeOrder, requestStaff, rescheduleOrder, submitOrder } from "@/server/guest-chat";
import type { SubmitOrderInput } from "@/server/order-drafts";
import { tr } from "@/lib/i18n";

// デモ用: 予約番号をそのままゲストの識別に使う（認証は未実装）
export async function GET(_request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const session = await getGuestSession(reservationId);
  if (!session) return Response.json({ error: tr("予約が見つかりません", "Reservation not found") }, { status: 404 });
  return Response.json(session);
}

export async function POST(request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const body = (await request.json()) as {
    text?: string;
    action?: "talk_to_staff" | "cancel_staff" | "submit_order" | "cancel_order" | "nudge_order" | "reschedule_order";
    draftId?: string;
    ticketId?: string;
    deliver?: { date: string; time: string };
    order?: SubmitOrderInput;
  };
  if (body.action === "talk_to_staff") return Response.json(await requestStaff(reservationId));
  // 未完了のご依頼の「状況を確認する」（docs/005_order.md 6章）
  if (body.action === "nudge_order") {
    if (!body.ticketId) return Response.json({ error: tr("ご依頼が見つかりません", "Request not found") }, { status: 400 });
    try {
      return Response.json(await nudgeOrder(reservationId, body.ticketId));
    } catch (error) {
      console.warn("[api/guest] 状況の確認に失敗", error);
      return Response.json({ error: error instanceof Error ? error.message : tr("確認できませんでした", "Couldn't check") }, { status: 409 });
    }
  }
  // 未完了のご依頼の「時間を変更」
  if (body.action === "reschedule_order") {
    if (!body.ticketId || !body.deliver) return Response.json({ error: tr("お届けの日時をお選びください", "Please choose a delivery date and time") }, { status: 400 });
    try {
      return Response.json(await rescheduleOrder(reservationId, body.ticketId, String(body.deliver.date), String(body.deliver.time)));
    } catch (error) {
      console.warn("[api/guest] お届け時間の変更に失敗", error);
      return Response.json({ error: error instanceof Error ? error.message : tr("変更できませんでした", "Couldn't change it") }, { status: 409 });
    }
  }
  // お届けの依頼の選択欄（docs/005_order.md 2章）
  if (body.action === "submit_order" || body.action === "cancel_order") {
    if (!body.draftId) return Response.json({ error: tr("ご依頼が見つかりません", "Request not found") }, { status: 400 });
    try {
      if (body.action === "cancel_order") {
        await cancelOrder(reservationId, body.draftId);
        return Response.json({ ok: true });
      }
      const order = body.order;
      if (!order || !Array.isArray(order.lines)) return Response.json({ error: tr("品目と数量をお選びください", "Please choose items and quantities") }, { status: 400 });
      const input: SubmitOrderInput = {
        lines: order.lines.map((l) => ({ itemId: String(l.itemId), quantity: Number(l.quantity) })),
        note: String(order.note ?? "").slice(0, 300),
        deliver: order.deliver ? { date: String(order.deliver.date), time: String(order.deliver.time) } : null,
      };
      return Response.json({ tickets: await submitOrder(reservationId, body.draftId, input) });
    } catch (error) {
      // 入力の誤り（品切れ・過ぎた時刻など）はゲストに伝える
      console.warn("[api/guest] ご依頼の確定に失敗", error);
      return Response.json({ error: error instanceof Error ? error.message : tr("ご依頼を確定できませんでした", "Couldn't place the request") }, { status: 409 });
    }
  }
  if (body.action === "cancel_staff") {
    const { cancelled, error } = await cancelStaffRequest(reservationId);
    if (!cancelled) return Response.json({ error }, { status: 409 });
    return Response.json({ cancelled });
  }

  const text = body.text?.trim();
  if (!text) return Response.json({ error: tr("メッセージが空です", "The message is empty") }, { status: 400 });
  if (text.length > 1000) return Response.json({ error: tr("メッセージが長すぎます", "The message is too long") }, { status: 400 });
  try {
    return Response.json(await handleGuestMessage(reservationId, text));
  } catch (error) {
    console.error("[api/guest] メッセージの処理に失敗", error);
    return Response.json({ error: tr("ただいま応答できません。時間をおいてお試しください。", "We can't respond right now. Please try again shortly.") }, { status: 500 });
  }
}
