import { cancelStaffRequest, getGuestSession, handleGuestMessage, requestStaff } from "@/server/guest-chat";

// デモ用: 予約番号をそのままゲストの識別に使う（認証は未実装）
export async function GET(_request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const session = await getGuestSession(reservationId);
  if (!session) return Response.json({ error: "予約が見つかりません" }, { status: 404 });
  return Response.json(session);
}

export async function POST(request: Request, { params }: RouteContext<"/api/guest/[reservationId]">) {
  const { reservationId } = await params;
  const body = (await request.json()) as { text?: string; action?: "talk_to_staff" | "cancel_staff" };
  if (body.action === "talk_to_staff") return Response.json(await requestStaff(reservationId));
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
