"use server";

import { refresh } from "next/cache";
import { audit, authorize, PermissionError } from "@/server/auth";
import { queryOne } from "@/server/db";
import { addNotice, deleteNotice, draftFromFile, saveFacility, saveFacilitySchema, type ImportedDraft } from "@/server/knowledge-admin";
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
