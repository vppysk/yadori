"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { audit, authorize, can, getCurrentMember, MEMBER_COOKIE } from "@/server/auth";
import { getHotel, localNow } from "@/server/hotel";
import { replyCheck, type CheckReply } from "@/server/order-checks";
import { archiveAskSession, askAi } from "@/server/staff-ask";
import { searchGuests, type GuestSearchResult } from "@/server/staff-ask-guests";
import {
  completeTicket,
  declineTicket,
  endShift,
  markNotificationsRead,
  startShift,
  startTicket,
} from "@/server/staff-work";

// 現場スマホの操作。どれもログインと権限を確認してから実行し、監査ログに残す（plan 4.8）

export async function startShiftAction() {
  const member = await authorize("order.assignable");
  await startShift(member);
  await audit(member, "order.assignable", "shift.start");
  refresh();
}

export async function endShiftAction() {
  const member = await authorize("order.assignable");
  await endShift(member);
  await audit(member, "order.assignable", "shift.end");
  refresh();
}

export async function startTicketAction(ticketId: string) {
  const member = await authorize("order.assignable");
  await startTicket(member, ticketId);
  await audit(member, "order.assignable", "ticket.start", { type: "ticket", id: ticketId });
  refresh();
}

export async function completeTicketAction(ticketId: string) {
  const member = await authorize("order.assignable");
  await completeTicket(member, ticketId);
  await audit(member, "order.assignable", "ticket.done", { type: "ticket", id: ticketId });
  refresh();
}

export async function declineTicketAction(ticketId: string, reason: string) {
  const member = await authorize("order.assignable");
  const trimmed = reason.trim() || "理由の記載なし";
  await declineTicket(member, ticketId, trimmed.slice(0, 200));
  await audit(member, "order.assignable", "ticket.decline", { type: "ticket", id: ticketId }, { reason: trimmed });
  refresh();
}

// 状況の確認への返事（向かっています／対応できない＋任意の一言）
export async function replyCheckAction(ticketId: string, reply: CheckReply, etaMinutes: number | null, note: string) {
  const member = await authorize("order.assignable");
  await replyCheck(member, ticketId, reply, { etaMinutes: etaMinutes ?? undefined, note });
  await audit(member, "order.assignable", "ticket.reply_check", { type: "ticket", id: ticketId }, { reply, etaMinutes });
  refresh();
}

export async function markNotificationsReadAction() {
  // 自分宛ての通知を既読にするだけなので、ログインしていれば権限は問わない
  const member = await getCurrentMember();
  if (member) await markNotificationsRead(member.id);
  refresh();
}

export async function logoutAction() {
  (await cookies()).delete(MEMBER_COOKIE);
  redirect("/staff/login");
}

// AIに相談。sessionId がなければ新しい会話を作る。ゲストの参照は権限がある人だけ（なければ選択も文からの照合もしない）
export async function askAiAction(
  sessionId: string | null,
  text: string,
  guestIds: string[],
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const member = await authorize("handling.consult");
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "質問を入力してください" };
  const canViewGuests = await can(member.id, "handling.consult.guest");
  try {
    const result = await askAi(member, { sessionId, text: trimmed.slice(0, 1000), guestIds: canViewGuests ? guestIds.slice(0, 3) : [], canViewGuests });
    for (const m of result.mentions) {
      await audit(member, "handling.consult.guest", "ask.guest_reference", { type: "reservation", id: m.reservationId }, { sessionId: result.sessionId });
    }
    refresh();
    return { ok: true, sessionId: result.sessionId };
  } catch (error) {
    console.error("[askAiAction]", error);
    return { ok: false, error: "いま答えられません。時間をおいてお試しください。" };
  }
}

export async function searchGuestsAction(text: string): Promise<{ ok: boolean; guests?: GuestSearchResult[]; error?: string }> {
  const member = await authorize("handling.consult.guest");
  try {
    const hotel = await getHotel(member.hotel_id);
    const guests = await searchGuests(hotel.id, localNow(hotel.timezone).date, text.slice(0, 50), member.id);
    await audit(member, "handling.consult.guest", "ask.guest_search", undefined, { query: text.slice(0, 50), hits: guests.length });
    return { ok: true, guests };
  } catch (error) {
    console.error("[searchGuestsAction]", error);
    const denied = error instanceof Error && error.message.includes("権限");
    return { ok: false, error: denied ? "予約を検索する権限がありません（上長に確認してください）" : "予約・客室管理システムに接続できませんでした" };
  }
}

export async function archiveAskSessionAction(sessionId: string) {
  const member = await authorize("handling.consult");
  await archiveAskSession(member, sessionId);
  await audit(member, "handling.consult", "ask.session_archive", { type: "conversation", id: sessionId });
  refresh();
}
