"use server";

import { refresh } from "next/cache";
import { audit, authorize, can, PermissionError } from "@/server/auth";
import { saveAssumptions, saveTargets, type Assumptions } from "@/server/dashboard";
import { addIntegration, saveConnection, syncIntegration, type ConnectionInput } from "@/server/integrations-admin";
import { grantPermission, revokeGrant, saveGroup, setMemberGroup } from "@/server/members";
import { approveReport, dismissReport, stopTrial, type Decision } from "@/server/model-review";
import { addWebhook, deleteWebhook, sendTest } from "@/server/webhooks";
import { addExportClient, deleteExportClient, saveExportClient, type ExportClientInput } from "@/server/export-clients";

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

// モデルの見直し（docs/000_plan.md 4.3）: 提案レポートの承認（全部適用か試験運用）・見送り、試験運用の中断、満足度の目標
export async function approveReportAction(reportId: string, decision: Decision): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_assignment");
    await approveReport(member, reportId, decision);
    await audit(member, "settings.ai_assignment", "model_report.approve", { type: "model_report", id: reportId }, decision);
    refresh();
  });
}

export async function dismissReportAction(reportId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_assignment");
    await dismissReport(member, reportId);
    await audit(member, "settings.ai_assignment", "model_report.dismiss", { type: "model_report", id: reportId });
    refresh();
  });
}

export async function stopTrialAction(trialId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_assignment");
    await stopTrial(member, trialId);
    await audit(member, "settings.ai_assignment", "model_trial.stop", { type: "model_trial", id: trialId });
    refresh();
  });
}

export async function saveTargetsAction(targets: { unansweredMax: number; aiTalkMax: number }): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.ai_assignment");
    await saveTargets(member, targets);
    await audit(member, "settings.ai_assignment", "targets.save", undefined, targets);
    refresh();
  });
}

// 外部連携の接続（docs/007_ai_settings.md）: 接続先、AIに使わせるツール（ツールごとの権限）、システムが決まった場面で呼ぶツール
export async function saveConnectionAction(integrationId: string, input: ConnectionInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await saveConnection(member, integrationId, input);
    await audit(member, "settings.integrations", "integration.save", { type: "integration", id: integrationId });
    refresh();
  });
}

export async function syncIntegrationAction(integrationId: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await syncIntegration(member, integrationId);
    await audit(member, "settings.integrations", "integration.sync", { type: "integration", id: integrationId });
    refresh();
  });
}

export async function addIntegrationAction(input: { name: string; slug: string; endpointEnv: string; tokenEnv: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const member = await authorize("settings.integrations");
    const id = await addIntegration(member, input);
    await audit(member, "settings.integrations", "integration.add", { type: "integration", id });
    refresh();
    return { ok: true, id };
  } catch (error) {
    if (!(error instanceof PermissionError)) console.error("[addIntegrationAction]", error);
    return { ok: false, error: error instanceof Error ? error.message : "追加できませんでした" };
  }
}

export async function saveAssumptionsAction(input: Assumptions): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.masters");
    await saveAssumptions(member, input);
    await audit(member, "settings.masters", "assumptions.save");
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

// 実績の出力口の接続元（当システムに接続してくる外部システム。docs/007_ai_settings.md）
export async function saveExportClientAction(id: string | null, input: ExportClientInput): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    const clientId = id ?? (await addExportClient(member, input));
    if (id) await saveExportClient(member, id, input);
    await audit(member, "settings.integrations", id ? "export_client.save" : "export_client.add", { type: "member", id: clientId });
    refresh();
  });
}

export async function deleteExportClientAction(id: string): Promise<Result> {
  return guard(async () => {
    const member = await authorize("settings.integrations");
    await deleteExportClient(member, id);
    await audit(member, "settings.integrations", "export_client.delete", undefined, { id });
    refresh();
  });
}
