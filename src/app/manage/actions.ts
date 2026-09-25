"use server";

import { refresh } from "next/cache";
import { audit, authorize, PermissionError } from "@/server/auth";
import { applyAssignments, type Handler } from "@/server/dashboard";

type Result = { ok: true } | { ok: false; error: string };

async function guard(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    if (!(error instanceof PermissionError)) console.error("[manage action]", error);
    return { ok: false, error: error instanceof Error ? error.message : "保存できませんでした" };
  }
}

export async function applyAssignmentsAction(next: Record<string, Handler>): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_assignment");
    await applyAssignments(member, next);
    await audit(member, "settings.ai_assignment", "ai_assignments.apply");
    refresh();
  });
}
