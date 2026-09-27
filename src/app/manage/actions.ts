"use server";

import { refresh } from "next/cache";
import { audit, authorize, can, PermissionError } from "@/server/auth";
import { applyAssignments, type Handler } from "@/server/dashboard";
import { decideWrite, saveIntegration, type IntegrationInput } from "@/server/integrations-admin";
import { saveMasters, type Masters } from "@/server/masters";
import { grantPermission, revokeGrant, saveGroup, setMemberGroup } from "@/server/members";
import { savePolicy, type PolicyInput } from "@/server/policy";
import type { InstructionOverrides } from "@/server/guest-chat";
import type { Pattern } from "@/server/hotel";
import { addWebhook, deleteWebhook, sendTest } from "@/server/webhooks";
import { replay, tryInstructions, type InstructionTrial, type ReplayRequest, type ReplayResult } from "@/server/replay";

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

export async function savePolicyAction(input: PolicyInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_policy");
    await savePolicy(member, input);
    await audit(member, "settings.ai_policy", "ai_policy.save");
    refresh();
  });
}

export async function saveIntegrationAction(integrationId: string, input: IntegrationInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await saveIntegration(member, integrationId, input);
    await audit(member, "settings.integrations", "integration.save", { type: "integration", id: integrationId });
    refresh();
  });
}

export async function decideWriteAction(writeId: string, approve: boolean): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await decideWrite(member, writeId, approve);
    await audit(member, "settings.integrations", approve ? "integration_write.approve" : "integration_write.reject", { type: "integration_write", id: writeId });
    refresh();
  });
}

export async function saveMastersAction(input: Omit<Masters, "jobTitles" | "actualMinutes">): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.masters");
    await saveMasters(member, input);
    await audit(member, "settings.masters", "masters.save");
    refresh();
  });
}

export async function setMemberGroupAction(memberId: string, groupId: string, on: boolean): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.members");
    await setMemberGroup(member, memberId, groupId, on);
    // 自分の管理権限を外してしまった場合は元に戻す
    if (!(await can(member.id, "settings.members"))) {
      await setMemberGroup(member, memberId, groupId, !on);
      throw new Error("自分の「メンバーと権限の管理」がなくなるため変更できません");
    }
    await audit(member, "settings.members", on ? "member.group.add" : "member.group.remove", { type: "member", id: memberId }, { groupId });
    refresh();
  });
}

export async function grantPermissionAction(input: { memberId: string; permissionKey: string; scopeIds: string[] | null; expiresAt: string | null }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.members");
    await grantPermission(member, input);
    await audit(member, "settings.members", "member.permission.grant", { type: "member", id: input.memberId }, input);
    refresh();
  });
}

export async function revokeGrantAction(grantId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.members");
    await revokeGrant(member, grantId);
    await audit(member, "settings.members", "member.permission.revoke", undefined, { grantId });
    refresh();
  });
}

export async function saveGroupAction(groupId: string | null, input: { name: string; permissions: { key: string; scope_ids: string[] | null }[] }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.members");
    if (!input.name.trim()) throw new Error("グループ名を入力してください");
    await saveGroup(member, groupId, input);
    await audit(member, "settings.members", groupId ? "group.save" : "group.create", groupId ? { type: "group", id: groupId } : undefined, { name: input.name });
    refresh();
  });
}

export async function tryInstructionsAction(pattern: Pattern, draft: InstructionOverrides): Promise<{ ok: true; trial: InstructionTrial } | { ok: false; error: string }> {
  try {
    const member = await authorize("settings.ai_policy");
    const trial = await tryInstructions(member.hotel_id, pattern, draft);
    await audit(member, "settings.ai_policy", "ai_policy.try", undefined, { pattern });
    return { ok: true, trial };
  } catch (error) {
    console.error("[tryInstructionsAction]", error);
    return { ok: false, error: error instanceof Error ? error.message : "試せませんでした" };
  }
}

export async function addWebhookAction(url: string): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  try {
    const member = await authorize("settings.integrations");
    const secret = await addWebhook(member, url.trim());
    await audit(member, "settings.integrations", "webhook.add", undefined, { url });
    refresh();
    return { ok: true, secret };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "登録できませんでした" };
  }
}

export async function deleteWebhookAction(id: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await deleteWebhook(member, id);
    await audit(member, "settings.integrations", "webhook.delete", { type: "webhook", id });
    refresh();
  });
}

export async function testWebhookAction(id: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    const r = await sendTest(member, id);
    if (!r.ok) throw new Error(`送信に失敗しました（${r.status ?? "接続できない"}）`);
  });
}
