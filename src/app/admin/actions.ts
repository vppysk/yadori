"use server";

import { refresh } from "next/cache";
import type { z } from "zod";
import { audit, authorize, PermissionError } from "@/server/auth";
import { queryOne, transaction } from "@/server/db";
import { deleteDocument, insertDocument } from "@/server/documents";
import {
  addBoost, addSource, boostInputSchema, deleteBoost, deleteSource, runSourceChecks, sourceInputSchema, updateSource,
} from "@/server/external-sources";
import { addNotice, deleteNotice, draftFromFile, readDocument, saveFacility, saveFacilitySchema, type ImportedDraft } from "@/server/knowledge-admin";
import { addSlot, deleteSlot, saveItemSettings, type SaveItemsInput } from "@/server/items";
import { previewOrder, reassignManually, registerOrder, type OrderPreview } from "@/server/order-board";
import { answerQuestion, dismissQuestion } from "@/server/questions";

// 管理PCの操作。ログインと権限（範囲付きなら対象の施設）を確認し、監査ログに残す（plan 4.8）

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof PermissionError) return { ok: false, error: error.message };
    console.error("[admin action]", error);
    return { ok: false, error: error instanceof Error ? error.message : "保存できませんでした" };
  }
}

export async function saveFacilityAction(facilityId: string, input: unknown): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit", facilityId);
    const parsed = saveFacilitySchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    await saveFacility(member, facilityId, parsed.data);
    await audit(member, "knowledge.facility.edit", "facility.save", { type: "facility", id: facilityId }, {
      hours: parsed.data.hours.length,
      offerings: parsed.data.offerings.length,
    });
    refresh();
  });
}

export async function importDraftAction(facilityId: string, formData: FormData): Promise<Result<ImportedDraft>> {
  return guard(async () => {
    const member = await authorize("knowledge.facility.edit", facilityId);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("ファイルを選んでください");
    const draft = await draftFromFile(member, facilityId, file);
    await audit(member, "knowledge.facility.edit", "facility.import_draft", { type: "facility", id: facilityId }, { file: file.name });
    return draft;
  });
}

export async function addNoticeAction(facilityId: string, input: { body: string; startsAt: string; endsAt: string }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.notice.edit", facilityId);
    const body = input.body.trim();
    if (!body) throw new Error("内容を入力してください");
    if (!input.startsAt || !input.endsAt || input.endsAt <= input.startsAt) throw new Error("期限は開始より後にしてください");
    await addNotice(member, facilityId, { body: body.slice(0, 300), startsAt: input.startsAt, endsAt: input.endsAt });
    await audit(member, "knowledge.notice.edit", "notice.add", { type: "facility", id: facilityId }, { body });
    refresh();
  });
}

export async function deleteNoticeAction(noticeId: string): Promise<Result> {
  return guard(async () => {
    const notice = await queryOne<{ facility_id: string }>("select facility_id from special_notices where id = $1", [noticeId]);
    if (!notice) throw new Error("特記事項が見つかりません");
    const member = await authorize("knowledge.notice.edit", notice.facility_id);
    await deleteNotice(member, noticeId);
    await audit(member, "knowledge.notice.edit", "notice.delete", { type: "notice", id: noticeId });
    refresh();
  });
}

export async function answerQuestionAction(questionId: string, answer: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.question.answer");
    const trimmed = answer.trim();
    if (!trimmed) throw new Error("回答を入力してください");
    await answerQuestion(member, questionId, trimmed.slice(0, 2000));
    await audit(member, "knowledge.question.answer", "question.answer", { type: "question", id: questionId });
    refresh();
  });
}

export async function dismissQuestionAction(questionId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.question.answer");
    await dismissQuestion(member, questionId);
    await audit(member, "knowledge.question.answer", "question.dismiss", { type: "question", id: questionId });
    refresh();
  });
}

export async function previewOrderAction(roomNumber: string, text: string): Promise<Result<OrderPreview>> {
  return guard(async () => {
    const member = await authorize("order.create");
    if (!roomNumber.trim() || !text.trim()) throw new Error("部屋番号とご依頼内容を入力してください");
    return previewOrder(member, roomNumber.trim(), text.trim().slice(0, 500));
  });
}

export async function registerOrderAction(input: {
  roomNumber: string;
  text: string;
  source: "phone" | "front_desk" | "other";
  items: { item: string; label: string; quantity: number }[];
}): Promise<Result> {
  return guard(async () => {
    const member = await authorize("order.create");
    const tickets = await registerOrder(member, input);
    await audit(member, "order.create", "order.register", undefined, { room: input.roomNumber, tickets: tickets.map((t) => t.id) });
    refresh();
  });
}

export async function reassignAction(ticketId: string, slotId: string, toMemberId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("order.reassign", slotId);
    await reassignManually(member, ticketId, toMemberId);
    await audit(member, "order.reassign", "ticket.reassign", { type: "ticket", id: ticketId }, { to: toMemberId });
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

export async function addSlotAction(jobRoleId: string, areaId: string | null): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await addSlot(member, jobRoleId, areaId);
    await audit(member, "settings.items", "slot.add", undefined, { jobRoleId, areaId });
    refresh();
  });
}

export async function deleteSlotAction(slotId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.items");
    await deleteSlot(member, slotId);
    await audit(member, "settings.items", "slot.delete", { type: "slot", id: slotId });
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
    if (!title) throw new Error("タイトルを入力してください");
    if (!text) throw new Error("本文を入力するか、ファイルを選んでください");
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

// ---------- 外部の情報源 ----------

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  return parsed.data;
}

export async function addSourceAction(input: unknown): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    const data = parseOrThrow(sourceInputSchema, input);
    const id = await addSource(member, data);
    await audit(member, "knowledge.source.edit", "external_source.add", { type: "external_source", id }, { name: data.name, url: data.url });
    // 登録直後に1回取得して、取れるページかをすぐ確認できるようにする
    await runSourceChecks(member.hotel_id, [id]);
    refresh();
  });
}

export async function updateSourceAction(sourceId: string, patch: { active?: boolean; interval_minutes?: number }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    await updateSource(member, sourceId, patch);
    await audit(member, "knowledge.source.edit", "external_source.update", { type: "external_source", id: sourceId }, patch);
    refresh();
  });
}

export async function deleteSourceAction(sourceId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    await deleteSource(member, sourceId);
    await audit(member, "knowledge.source.edit", "external_source.delete", { type: "external_source", id: sourceId });
    refresh();
  });
}

export async function fetchSourceNowAction(sourceId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    await audit(member, "knowledge.source.edit", "external_source.fetch_now", { type: "external_source", id: sourceId });
    await runSourceChecks(member.hotel_id, [sourceId]);
    refresh();
  });
}

export async function addBoostAction(input: unknown): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    const data = parseOrThrow(boostInputSchema, input);
    await addBoost(member, data);
    await audit(member, "knowledge.source.edit", "external_source.boost_add", undefined, data);
    refresh();
  });
}

export async function deleteBoostAction(boostId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("knowledge.source.edit");
    await deleteBoost(member, boostId);
    await audit(member, "knowledge.source.edit", "external_source.boost_delete", { type: "external_source_boost", id: boostId });
    refresh();
  });
}
