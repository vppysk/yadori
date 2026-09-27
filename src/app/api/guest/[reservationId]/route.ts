import { cancelOrder, cancelStaffRequest, getGuestSession, handleGuestMessage, requestStaff, submitOrder } from "@/server/guest-chat";
import type { SubmitOrderInput } from "@/server/order-drafts";

// デモ用: 予約番号をそのままゲストの識別に使う（認証は未実装）
export async function GET(_request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const session = await getGuestSession(reservationId);
  if (!session) return Response.json({ error: "予約が見つかりません" }, { status: 404 });
  return Response.json(session);
}

export async function POST(request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const body = (await request.json()) as {
    text?: string;
    action?: "talk_to_staff" | "cancel_staff" | "submit_order" | "cancel_order";
    draftId?: string;
    order?: SubmitOrderInput;
  };
  if (body.action === "talk_to_staff") return Response.json(await requestStaff(reservationId));
  // お届けの依頼の選択欄（docs/005_order.md 2章）
  if (body.action === "submit_order" || body.action === "cancel_order") {
    if (!body.draftId) return Response.json({ error: "ご依頼が見つかりません" }, { status: 400 });
    try {
      if (body.action === "cancel_order") {
        await cancelOrder(reservationId, body.draftId);
        return Response.json({ ok: true });
      }
      const order = body.order;
      if (!order || !Array.isArray(order.lines)) return Response.json({ error: "品目と数量をお選びください" }, { status: 400 });
      const input: SubmitOrderInput = {
        lines: order.lines.map((l) => ({ itemId: String(l.itemId), quantity: Number(l.quantity) })),
        note: String(order.note ?? "").slice(0, 300),
        deliver: order.deliver ? { date: String(order.deliver.date), time: String(order.deliver.time) } : null,
      };
      return Response.json({ tickets: await submitOrder(reservationId, body.draftId, input) });
    } catch (error) {
      // 入力の誤り（品切れ・過ぎた時刻など）はゲストに伝える
      console.warn("[api/guest] ご依頼の確定に失敗", error);
      return Response.json({ error: error instanceof Error ? error.message : "ご依頼を確定できませんでした" }, { status: 409 });
    }
  }
  if (body.action === "cancel_staff") {
    const { cancelled, error } = await cancelStaffRequest(reservationId);
    if (!cancelled) return Response.json({ error }, { status: 409 });
    return Response.json({ cancelled });
  }

  const text = body.text?.trim();
  if (!text) return Response.json({ error: "メッセージが空です" }, { status: 400 });
  if (text.length > 1000) return Response.json({ error: "メッセージが長すぎます" }, { status: 400 });
  try {
    return Response.json(await handleGuestMessage(reservationId, text));
  } catch (error) {
    console.error("[api/guest] メッセージの処理に失敗", error);
    return Response.json({ error: "ただいま応答できません。時間をおいてお試しください。" }, { status: 500 });
  }
}
