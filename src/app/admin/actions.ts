"use server";

import { refresh } from "next/cache";
import type { z } from "zod";
import { audit, authorize, PermissionError } from "@/server/auth";
import { queryOne, transaction } from "@/server/db";
import { deleteDocument, insertDocument } from "@/server/documents";
import { setDuty } from "@/server/duties";
import {
  addBoost, boostInputSchema, createUrlSource, deleteBoost, dismissUpdate, runUrlSourceChecks, setReflectMode, updateUrlSettings, urlSourceSchema,
} from "@/server/source-fetch";
import { parseFacilityRef } from "@/server/facility-fields";
import { approveSchema, approveSource, createSource, deleteSource as deleteInfoSource, setExternal, sourceFacilityIds } from "@/server/info-sources";
import { addNotice, deleteNotice, previewNotice, readDocument } from "@/server/knowledge-admin";
import { addArea, deleteArea, saveItemSettings, setFloorArea, type SaveItemsInput } from "@/server/items";
import { requestCheckBySupervisor } from "@/server/order-checks";
import { assignManually, previewAssignment, registerOrder, ticketArea, type AssignmentPreview, type RegisterOrderInput } from "@/server/order-board";
import { answerGap, dismissGap, getConversationMessages, type AnswerResult, type ConversationMessage } from "@/server/questions";
import { acceptHandoff, closeHandoff, replyToGuest } from "@/server/staff-work";
import { decideWrite, saveUsageRule } from "@/server/integrations-admin";
import { saveInstructions } from "@/server/policy";
import { tr } from "@/lib/i18n";

// 管理PCの操作。ログインと権限（範囲付きなら対象の施設）を確認し、監査ログに残す（plan 4.8）

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof PermissionError) return { ok: false, error: error.message };
    console.error("[admin action]", error);
    return { ok: false, error: error instanceof Error ? error.message : tr("保存できませんでした", "Couldn't save") };
  }
}

// ---------- 資料（案内情報の出どころ）: 登録 → AIの読み取り → 確認して承認（docs/006_guide_info.md） ----------

export async function createInfoSourceAction(formData: FormData): Promise<Result<string>> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    const isExternal = formData.get("is_external") === "on";
    const url = String(formData.get("url") ?? "").trim();
    // URLはその場で取得して読み取る。以降は定期取得で変わったら読み直して承認を依頼する
    if (url) {
      const data = parseOrThrow(urlSourceSchema, {
        title: String(formData.get("title") ?? "").trim().slice(0, 120),
        url,
        purpose: String(formData.get("purpose") ?? ""),
        interval_minutes: Number(formData.get("interval_minutes")),
        is_external: isExternal,
        reflect_mode: formData.get("reflect_mode") === "auto" ? "auto" : "approval",
      });
      const id = await createUrlSource(member, data);
      await audit(member, "knowledge.facility.edit", "source.create", { type: "info_source", id }, { title: data.title, url, external: isExternal, reflect: data.reflect_mode });
      return id;
    }
    const file = formData.get("file");
    let body = String(formData.get("text") ?? "").trim();
    let fileName: string | null = null;
    if (file instanceof File && file.size > 0) {
      fileName = file.name;
      body = file.type.startsWith("text/") || /\.(txt|md)$/.test(file.name) ? (await file.text()).normalize("NFKC") : await readDocument(member.hotel_id, file);
    }
    const title = String(formData.get("title") ?? "").trim().slice(0, 120) || fileName || "";
    if (!title) throw new Error(tr("資料の名前を入力してください", "Please enter a source name"));
    if (!body.trim()) throw new Error(tr("文章を入力するか、ファイルを選んでください", "Please enter text or choose a file"));
    const id = await createSource(member, { title, fileName, body: body.slice(0, 50_000), isExternal });
    await audit(member, "knowledge.facility.edit", "source.create", { type: "info_source", id }, { title, file: fileName, external: isExternal });
    return id;
  });
}

export async function approveInfoSourceAction(sourceId: string, input: unknown): Promise<Result> {
  return guard(async () => {
    const data = parseOrThrow(approveSchema, input);
    // 承認で置き換わる既存の施設（今の値と、確認後の値の両方）すべてに編集の権限が要る。新しい施設を作るだけなら範囲の確認は不要
    const refs = data.rows.map((r) => parseFacilityRef(r.facility));
    const facilityIds = new Set([...(await sourceFacilityIds(sourceId)), ...refs.flatMap((r) => (r.kind === "existing" ? [r.id] : []))]);
    let member = await authorize("knowledge.facility.edit");
    for (const id of facilityIds) member = await authorize("knowledge.facility.edit", id);
    const result = await approveSource(member, sourceId, data);
    const created = refs.filter((r) => r.kind === "new").map((r) => r.name);
    await audit(member, "knowledge.facility.edit", "source.approve", { type: "info_source", id: sourceId }, {
      values: data.rows.length, winner: data.winner, newFacilities: [...new Set(created)], facilities: result.facilityIds,
    });
    refresh();
  });
}

export async function deleteInfoSourceAction(sourceId: string): Promise<Result> {
  return guard(async () => {
    let member = await authorize("knowledge.facility.edit");
    for (const id of await sourceFacilityIds(sourceId)) member = await authorize("knowledge.facility.edit", id);
    await deleteInfoSource(member, sourceId);
    await audit(member, "knowledge.facility.edit", "source.delete", { type: "info_source", id: sourceId });
    refresh();
  });
}

export async function previewNoticeAction(facilityId: string, startsAt: string, endsAt: string): Promise<Result<{ overrides: string[]; overlappingNotices: string[] }>> {
  return guard(async () => {
    const member = await authorize("knowledge.notice.edit", facilityId);
    return previewNotice(member.hotel_id, facilityId, startsAt, endsAt);
  });
}

export async function addNoticeAction(facilityId: string, input: { body: string; startsAt: string; endsAt: string }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.notice.edit", facilityId);
    const body = input.body.trim();
    if (!body) throw new Error(tr("内容を入力してください", "Please enter the content"));
    if (!input.startsAt || !input.endsAt || input.endsAt <= input.startsAt) throw new Error(tr("期限は開始より後にしてください", "The end must be after the start"));
    await addNotice(member, facilityId, { body: body.slice(0, 300), startsAt: input.startsAt, endsAt: input.endsAt });
    await audit(member, "knowledge.notice.edit", "notice.add", { type: "facility", id: facilityId }, { body });
    refresh();
  });
}

export async function deleteNoticeAction(noticeId: string): Promise<Result> {
  return guard(async () => {
    const notice = await queryOne<{ facility_id: string }>("select facility_id from special_notices where id = $1", [noticeId]);
    if (!notice) throw new Error(tr("特記事項が見つかりません", "Special notice not found"));
    const member = await authorize("knowledge.notice.edit", notice.facility_id);
    await deleteNotice(member, noticeId);
    await audit(member, "knowledge.notice.edit", "notice.delete", { type: "notice", id: noticeId });
    refresh();
  });
}

// 未回答の質問に回答する。期間のない内容はよくある質問、期間のある内容は資料になる（どちらになったかを返す）
export async function answerQuestionAction(gapId: string, answer: string): Promise<Result<AnswerResult>> {
  return guard(async () => {
    const member = await authorize("knowledge.question.answer");
    const trimmed = answer.trim();
    if (!trimmed) throw new Error(tr("回答を入力してください", "Please enter an answer"));
    const result = await answerGap(member, gapId, trimmed.slice(0, 2000));
    await audit(member, "knowledge.question.answer", "question.answer", { type: "knowledge_gap", id: gapId }, result);
    refresh();
    return result;
  });
}

export async function dismissQuestionAction(gapId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.question.answer");
    await dismissGap(member, gapId);
    await audit(member, "knowledge.question.answer", "question.dismiss", { type: "knowledge_gap", id: gapId });
    refresh();
  });
}

// 未回答の質問の根拠になった会話を読む
export async function getConversationAction(conversationId: string): Promise<Result<ConversationMessage[]>> {
  return guard(async () => {
    const member = await authorize("knowledge.question.answer");
    return getConversationMessages(member.hotel_id, conversationId);
  });
}

export async function previewAssignmentAction(roomId: string, itemIds: string[]): Promise<Result<AssignmentPreview>> {
  return guard(async () => {
    const member = await authorize("order.create");
    return previewAssignment(member, roomId, itemIds.slice(0, 50));
  });
}

export async function registerOrderAction(input: RegisterOrderInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("order.create");
    const tickets = await registerOrder(member, { ...input, note: input.note.slice(0, 300) });
    await audit(member, "order.create", "order.register", undefined, { room: input.roomId, tickets: tickets.map((t) => t.id) });
    refresh();
  });
}

// 手動割り当て。権限はチケットのエリアで確かめる
export async function assignManuallyAction(ticketId: string, toMemberId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("order.reassign", await ticketArea(ticketId));
    await assignManually(member, ticketId, toMemberId);
    await audit(member, "order.reassign", "ticket.assign_manually", { type: "ticket", id: ticketId }, { to: toMemberId });
    refresh();
  });
}

// 上長の「担当者に確認」。担当者に状況の確認を送る（docs/005_order.md 6章）
export async function requestCheckAction(ticketId: string, message: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("order.reassign", await ticketArea(ticketId));
    await requestCheckBySupervisor(member, ticketId, message.slice(0, 200));
    await audit(member, "order.reassign", "ticket.request_check", { type: "ticket", id: ticketId }, { message });
    refresh();
  });
}

export async function saveItemSettingsAction(input: SaveItemsInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await saveItemSettings(member, input);
    await audit(member, "settings.items", "items.save", undefined, { items: input.items.length, settings: input.settings });
    refresh();
  });
}

// 担当設定（スタッフ × 役割 × エリア）（docs/005_order.md 2章）
export async function setDutyAction(memberId: string, jobRoleId: string, areaId: string | null, on: boolean): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await setDuty(member, memberId, jobRoleId, areaId, on);
    await audit(member, "settings.items", on ? "duty.add" : "duty.remove", { type: "member", id: memberId }, { jobRoleId, areaId });
    refresh();
  });
}

export async function addAreaAction(name: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await addArea(member, name);
    await audit(member, "settings.items", "area.add", undefined, { name });
    refresh();
  });
}

export async function deleteAreaAction(areaId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await deleteArea(member, areaId);
    await audit(member, "settings.items", "area.delete", { type: "area", id: areaId });
    refresh();
  });
}

export async function setFloorAreaAction(building: string | null, floor: number, areaId: string | null): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await setFloorArea(member, building, floor, areaId);
    await audit(member, "settings.items", "rooms.area", undefined, { building, floor, areaId });
    refresh();
  });
}

export async function registerDocumentAction(formData: FormData): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.document.register");
    const title = String(formData.get("title") ?? "").trim().slice(0, 120);
    const file = formData.get("file");
    let text = String(formData.get("text") ?? "").trim();
    if (file instanceof File && file.size > 0) {
      text = file.type.startsWith("text/") || file.name.endsWith(".txt") || file.name.endsWith(".md")
        ? (await file.text()).normalize("NFKC")
        : await readDocument(member.hotel_id, file);
    }
    if (!title) throw new Error(tr("タイトルを入力してください", "Please enter a title"));
    if (!text) throw new Error(tr("本文を入力するか、ファイルを選んでください", "Please enter text or choose a file"));
    // 登録時の確認はしない（plan 4.1）。回答精度は定期評価で見る
    const id = await transaction((client) => insertDocument(client, { hotelId: member.hotel_id, title, source: "upload", text: text.slice(0, 50_000), createdBy: member.id }));
    await audit(member, "knowledge.document.register", "document.register", { type: "document", id }, { title });
    refresh();
  });
}

export async function deleteDocumentAction(documentId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.document.register");
    await deleteDocument(member.hotel_id, documentId);
    await audit(member, "knowledge.document.register", "document.delete", { type: "document", id: documentId });
    refresh();
  });
}

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? tr("入力内容を確認してください", "Please check your input"));
  return parsed.data;
}

export async function setExternalAction(sourceId: string, isExternal: boolean): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await setExternal(member, sourceId, isExternal);
    await audit(member, "knowledge.facility.edit", "source.external", { type: "info_source", id: sourceId }, { isExternal });
    refresh();
  });
}

// ---------- URLの資料: 取得の設定・今すぐ取得・更新の見送り・期間を限定して頻度を上げる ----------

export async function updateUrlSettingsAction(sourceId: string, patch: { active?: boolean; interval_minutes?: number }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await updateUrlSettings(member, sourceId, patch);
    await audit(member, "knowledge.facility.edit", "source.url_settings", { type: "info_source", id: sourceId }, patch);
    refresh();
  });
}

// 反映のしかた（承認して反映／自動反映）を変える。前の方式の内容を消し、すぐ取り直す
export async function setReflectModeAction(sourceId: string, mode: "approval" | "auto"): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await setReflectMode(member, sourceId, mode);
    await audit(member, "knowledge.facility.edit", "source.reflect_mode", { type: "info_source", id: sourceId }, { mode });
    await runUrlSourceChecks(member.hotel_id, [sourceId]);
    refresh();
  });
}

export async function fetchUrlSourceNowAction(sourceId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await audit(member, "knowledge.facility.edit", "source.fetch_now", { type: "info_source", id: sourceId });
    const result = await runUrlSourceChecks(member.hotel_id, [sourceId]);
    if ("skipped" in result && result.skipped) throw new Error(result.skipped);
    refresh();
  });
}

export async function dismissUpdateAction(sourceId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await dismissUpdate(member, sourceId);
    await audit(member, "knowledge.facility.edit", "source.dismiss_update", { type: "info_source", id: sourceId });
    refresh();
  });
}

export async function addBoostAction(sourceId: string, input: unknown): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    const data = parseOrThrow(boostInputSchema, input);
    await addBoost(member, sourceId, data);
    await audit(member, "knowledge.facility.edit", "source.boost_add", { type: "info_source", id: sourceId }, data);
    refresh();
  });
}

export async function deleteBoostAction(boostId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit");
    await deleteBoost(member, boostId);
    await audit(member, "knowledge.facility.edit", "source.boost_delete", { type: "info_source_boost", id: boostId });
    refresh();
  });
}

// ---------- 対応アラート: 会話パネルからゲストに応対する ----------

export async function acceptHandoffAdminAction(handoffId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("handling.handoff.accept");
    await acceptHandoff(member, handoffId);
    await audit(member, "handling.handoff.accept", "handoff.accept", { type: "handoff", id: handoffId });
    refresh();
  });
}

// 返信すると、まだ誰も引き受けていない引き継ぎは返信した人が引き受けたことにする
export async function replyHandoffAdminAction(handoffId: string, text: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("handling.handoff.accept");
    const trimmed = text.trim();
    if (!trimmed) return;
    await acceptHandoff(member, handoffId);
    await replyToGuest(member, handoffId, trimmed.slice(0, 1000));
    await audit(member, "handling.handoff.accept", "handoff.reply", { type: "handoff", id: handoffId });
    refresh();
  });
}

export async function closeHandoffAdminAction(handoffId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("handling.handoff.accept");
    await closeHandoff(member, handoffId);
    await audit(member, "handling.handoff.accept", "handoff.close", { type: "handoff", id: handoffId });
    refresh();
  });
}

// ---------- AIの設定: 指示と連携の利用ルール（docs/007_ai_settings.md） ----------

export async function saveInstructionsAction(body: string): Promise<Result<{ checksUpdated: boolean }>> {
  return guard(async () => {
    const member = await authorize("settings.ai_policy");
    const result = await saveInstructions(member, body);
    await audit(member, "settings.ai_policy", "ai_policy.save");
    refresh();
    return result;
  });
}

export async function saveUsageRuleAction(integrationId: string, body: string): Promise<Result<{ checksUpdated: boolean }>> {
  return guard(async () => {
    const member = await authorize("settings.integration_rules");
    const result = await saveUsageRule(member, integrationId, body);
    await audit(member, "settings.integration_rules", "integration_rule.save", { type: "integration", id: integrationId });
    refresh();
    return result;
  });
}

export async function decideWriteAction(writeId: string, approve: boolean): Promise<Result> {
  return guard(async () => {
    const member = await authorize("handling.integration_write.confirm");
    await decideWrite(member, writeId, approve);
    await audit(member, "handling.integration_write.confirm", approve ? "integration_write.approve" : "integration_write.reject", { type: "integration_write", id: writeId });
    refresh();
  });
}
