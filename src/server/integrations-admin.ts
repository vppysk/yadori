import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { sendWrite } from "./integration-agent";
import { fetchToolDefinitions, syncTools, type Integration, type ToolRole } from "./integrations/mcp";
import { extractChecks, listReplyChecks, replaceChecks, type ReplyCheck } from "./reply-checks";

// 外部連携の設定（docs/007_ai_settings.md）。
// つなぐ（/manage、開発者・経営）: 連携先の接続、AIに使わせるツール、システムが決まった場面で呼ぶツール、スタッフの確認の要否
// 使い方（管理PCのAIの設定、現場）: 利用ルール（自然文）と、確認待ちの書き込み

export type IntegrationSummary = { id: string; name: string; slug: string; active: boolean; ai_tools: number; tools: number; pending_writes: number };

// MCPの連携先の一覧（Webページの取得はサービスの一部として出さない）
export async function listIntegrations(hotelId: string): Promise<IntegrationSummary[]> {
  return query<IntegrationSummary>(
    `select i.id, i.name, i.slug, i.active,
       (select count(*)::int from integration_tools t where t.integration_id = i.id and t.ai_enabled) ai_tools,
       (select count(*)::int from integration_tools t where t.integration_id = i.id) tools,
       (select count(*)::int from integration_writes w where w.integration_id = i.id and w.status in ('pending_confirm', 'held')) pending_writes
     from integrations i where i.hotel_id = $1 and i.kind = 'mcp' order by i.name`,
    [hotelId],
  );
}

export type ToolSetting = {
  name: string;
  description: string;
  role: ToolRole | null;
  require_staff_confirm: boolean;
  ai_enabled: boolean;
};

async function listTools(integrationId: string): Promise<ToolSetting[]> {
  return query<ToolSetting>(
    "select name, description, role, require_staff_confirm, ai_enabled from integration_tools where integration_id = $1 order by role nulls last, name",
    [integrationId],
  );
}

async function findIntegration(hotelId: string, integrationId: string): Promise<(Integration & { active: boolean }) | undefined> {
  return queryOne("select id, hotel_id, name, slug, endpoint_env, token_env, active from integrations where id = $1 and hotel_id = $2 and kind = 'mcp'", [integrationId, hotelId]);
}

// ---------- つなぐ（/manage） ----------

export type ConnectionDetail = Integration & { active: boolean; tools: ToolSetting[]; status: { ok: true } | { ok: false; error: string } };

export async function getConnection(hotelId: string, integrationId: string): Promise<ConnectionDetail | undefined> {
  const integration = await findIntegration(hotelId, integrationId);
  if (!integration) return undefined;
  // つながるかを確かめる（ツールの一覧を取る）
  const status = await fetchToolDefinitions(integration)
    .then(() => ({ ok: true }) as const)
    .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }) as const);
  return { ...integration, tools: await listTools(integrationId), status };
}

export type ConnectionInput = {
  name: string;
  endpointEnv: string;
  tokenEnv: string;
  active: boolean;
  tools: { name: string; aiEnabled: boolean; role: ToolRole | null; requireStaffConfirm: boolean }[];
};

export async function saveConnection(member: Member, integrationId: string, input: ConnectionInput) {
  await transaction(async (client) => {
    const before = await getConnectionSnapshot(member.hotel_id, integrationId);
    if (!before) throw new Error("連携先が見つかりません");
    if (!input.name.trim()) throw new Error("連携先の名前を入力してください");
    await client.query("update integrations set name = $3, endpoint_env = $4, token_env = $5, active = $6 where id = $1 and hotel_id = $2", [
      integrationId, member.hotel_id, input.name.trim(), input.endpointEnv.trim() || null, input.tokenEnv.trim() || null, input.active,
    ]);
    for (const role of ["reservation", "search"] as const) {
      if (input.tools.filter((t) => t.role === role).length > 1) throw new Error(`「${ROLE_LABELS[role]}」に指定できるツールは1つです`);
    }
    for (const t of input.tools) {
      // システムが決まった場面で呼ぶツールは、スタッフの確認を挟めない（予約の確認・毎回読む情報）
      await client.query(
        "update integration_tools set ai_enabled = $3, role = $4, require_staff_confirm = $5 where integration_id = $1 and name = $2",
        [integrationId, t.name, t.aiEnabled, t.role, t.role ? false : t.requireStaffConfirm],
      );
    }
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'integrations', $2, $3, $4)", [
      member.hotel_id, JSON.stringify({ before, after: input }), `外部連携「${input.name.trim()}」の接続の変更`, member.id,
    ]);
  });
}

async function getConnectionSnapshot(hotelId: string, integrationId: string) {
  const integration = await findIntegration(hotelId, integrationId);
  if (!integration) return undefined;
  return { name: integration.name, endpointEnv: integration.endpoint_env, tokenEnv: integration.token_env, active: integration.active, tools: await listTools(integrationId) };
}

export async function addIntegration(member: Member, input: { name: string; slug: string; endpointEnv: string; tokenEnv: string }): Promise<string> {
  const slug = input.slug.trim().toLowerCase();
  if (!input.name.trim()) throw new Error("連携先の名前を入力してください");
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) throw new Error("記号は英小文字で始まる英数字・_（2〜31文字）にしてください");
  if (!input.endpointEnv.trim()) throw new Error("接続先の環境変数を入力してください");
  const [{ id }] = await query<{ id: string }>(
    "insert into integrations (hotel_id, name, kind, slug, endpoint_env, token_env) values ($1, $2, 'mcp', $3, $4, $5) returning id",
    [member.hotel_id, input.name.trim(), slug, input.endpointEnv.trim(), input.tokenEnv.trim() || null],
  );
  // 追加した時点でツールの一覧を取る（つながらなくても登録はする）
  await syncIntegration(member, id).catch((error) => console.warn("[integrations] ツールを取得できなかった", error));
  return id;
}

export async function syncIntegration(member: Member, integrationId: string) {
  const integration = await findIntegration(member.hotel_id, integrationId);
  if (!integration) throw new Error("連携先が見つかりません");
  return syncTools(integration);
}

export const ROLE_LABELS: Record<ToolRole, string> = {
  reservation: "ゲストの予約の取得",
  search: "予約の検索（スタッフのAI相談）",
  preload: "ゲストの情報として毎回読む",
};

// ---------- 使い方（管理PC） ----------

export type WriteRow = { id: string; room_number: string | null; tool_name: string | null; content: string; status: string; hold_reason: string | null; created_at: string };
// 最近のツールの呼び出し（監査ログ）。誰の依頼か（AIの判断・スタッフのAI相談・確認して送った）と成否
export type CallRow = { tool: string; purpose: string; staff: string | null; ok: boolean; error: string | null; created_at: string };
export type UsageDetail = {
  id: string;
  name: string;
  active: boolean;
  rule: string;
  checks: ReplyCheck[];
  // AIが使えるツール（/manage で許可したもの）と、使わせていないツールの数
  tools: ToolSetting[];
  hiddenTools: number;
  // スタッフの確認後に送る呼び出し
  writes: WriteRow[];
  calls: CallRow[];
};

export async function getUsage(hotelId: string, integrationId: string): Promise<UsageDetail | undefined> {
  const integration = await findIntegration(hotelId, integrationId);
  if (!integration) return undefined;
  const [rule, checks, tools, writes, calls] = await Promise.all([
    queryOne<{ body: string }>("select body from ai_instructions where hotel_id = $1 and scope = 'integration' and integration_id = $2", [hotelId, integrationId]),
    listReplyChecks(hotelId),
    listTools(integrationId),
    query<WriteRow>(
      `select id, room_number, tool_name, content, status, hold_reason, created_at from integration_writes
       where integration_id = $1 order by (status in ('pending_confirm', 'held')) desc, created_at desc limit 20`,
      [integrationId],
    ),
    query<CallRow>(
      `select l.detail->>'tool' tool, l.detail->>'purpose' purpose, m.display_name staff, coalesce((l.detail->>'ok')::boolean, true) ok, l.detail->>'error' error,
         to_char(l.created_at at time zone h.timezone, 'FMMM/FMDD HH24:MI') created_at
       from audit_logs l join hotels h on h.id = l.hotel_id
       left join members m on m.id = (l.detail->>'staff_member_id')::uuid
       where l.action = 'integration.tool_call' and l.target_id = $1 order by l.created_at desc limit 20`,
      [integrationId],
    ),
  ]);
  const enabled = tools.filter((t) => t.ai_enabled);
  return {
    id: integration.id,
    name: integration.name,
    active: integration.active,
    rule: rule?.body ?? "",
    checks: checks.filter((c) => c.source_type === "integration" && c.integration_id === integrationId),
    tools: enabled,
    hiddenTools: tools.length - enabled.length,
    writes,
    calls,
  };
}

// 利用ルールを保存し、回答後にチェックすべき項目を抜き出して差し替える（抜き出しに失敗しても保存は通す）
export async function saveUsageRule(member: Member, integrationId: string, body: string): Promise<{ checksUpdated: boolean }> {
  const integration = await findIntegration(member.hotel_id, integrationId);
  if (!integration) throw new Error("連携先が見つかりません");
  const trimmed = body.trim().slice(0, 4000);
  const checks = await extractChecks(member.hotel_id, trimmed, "integration").catch((error) => {
    console.warn("[integrations] チェック項目を抜き出せなかった", error);
    return undefined;
  });
  await transaction(async (client) => {
    const before = await client.query<{ body: string }>("select body from ai_instructions where integration_id = $1 and scope = 'integration'", [integrationId]);
    await client.query("delete from ai_instructions where integration_id = $1 and scope = 'integration'", [integrationId]);
    if (trimmed) {
      await client.query("insert into ai_instructions (hotel_id, scope, integration_id, body, updated_by) values ($1, 'integration', $2, $3, $4)", [
        member.hotel_id, integrationId, trimmed, member.id,
      ]);
    }
    if (checks) await replaceChecks(client, member.hotel_id, { type: "integration", integrationId }, checks);
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'integrations', $2, $3, $4)", [
      member.hotel_id, JSON.stringify({ before: { rule: before.rows[0]?.body ?? "" }, after: { rule: trimmed, checks: checks ?? null } }),
      `「${integration.name}」の利用ルールの変更`, member.id,
    ]);
  });
  return { checksUpdated: checks !== undefined };
}

// 確認待ち・保留の書き込みを、スタッフが確認して送る／取りやめる
export async function decideWrite(member: Member, writeId: string, approve: boolean) {
  const write = await queryOne<{ status: string }>(
    `select w.status from integration_writes w join integrations i on i.id = w.integration_id where w.id = $1 and i.hotel_id = $2`,
    [writeId, member.hotel_id],
  );
  if (!write || !["pending_confirm", "held"].includes(write.status)) throw new Error("この書き込みは確認できません");
  if (!approve) {
    await query("update integration_writes set status = 'rejected', confirmed_by = $2 where id = $1", [writeId, member.id]);
    return;
  }
  await query("update integration_writes set confirmed_by = $2 where id = $1", [writeId, member.id]);
  await sendWrite(writeId, member.id);
}
