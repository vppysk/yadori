"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { audit, authorize, getCurrentMember, MEMBER_COOKIE } from "@/server/auth";
import {
  acceptHandoff,
  closeHandoff,
  completeTicket,
  declineTicket,
  endShift,
  markNotificationsRead,
  replyToGuest,
  startShift,
  startTicket,
} from "@/server/staff-work";

// 現場スマホの操作。どれもログインと権限を確認してから実行し、監査ログに残す（plan 4.8）

export async function startShiftAction(slotId: string) {
  const member = await authorize("order.assignable", slotId);
  await startShift(member, slotId);
  await audit(member, "order.assignable", "shift.start", { type: "slot", id: slotId });
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

export async function acceptHandoffAction(handoffId: string) {
  const member = await authorize("handling.handoff.accept");
  await acceptHandoff(member, handoffId);
  await audit(member, "handling.handoff.accept", "handoff.accept", { type: "handoff", id: handoffId });
  redirect(`/staff/handoffs/${handoffId}`);
}

export async function closeHandoffAction(handoffId: string) {
  const member = await authorize("handling.handoff.accept");
  await closeHandoff(member, handoffId);
  await audit(member, "handling.handoff.accept", "handoff.close", { type: "handoff", id: handoffId });
  redirect("/staff/orders");
}

export async function replyToGuestAction(handoffId: string, text: string) {
  const member = await authorize("handling.handoff.accept");
  const trimmed = text.trim();
  if (!trimmed) return;
  await replyToGuest(member, handoffId, trimmed.slice(0, 1000));
  await audit(member, "handling.handoff.accept", "handoff.reply", { type: "handoff", id: handoffId });
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
