"use server";

import { refresh } from "next/cache";
import { audit, authorize, PermissionError } from "@/server/auth";
import { applyAssignments, type Handler } from "@/server/dashboard";
import { replay, type ReplayRequest, type ReplayResult } from "@/server/replay";

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

// 精密見積もり: 変更した業務ごとに過去の質問を2つのモデルで再生する（LLMを呼ぶため、1回に2業務まで）
export async function runReplayAction(requests: ReplayRequest[]): Promise<{ ok: true; results: ReplayResult[] } | { ok: false; error: string }> {
  try {
    const member = await authorize("settings.ai_assignment");
    const targets = requests.slice(0, 2);
    const results: ReplayResult[] = [];
    for (const r of targets) results.push(await replay(member.hotel_id, r));
    await audit(member, "settings.ai_assignment", "ai_assignments.replay", undefined, { requests: targets });
    return { ok: true, results };
  } catch (error) {
    console.error("[runReplayAction]", error);
    return { ok: false, error: error instanceof Error ? error.message : "精密見積もりに失敗しました" };
  }
}
