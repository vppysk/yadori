import { MCPClient } from "@mastra/mcp";
import { query, queryOne, transaction } from "../db";
import { getAiAgentMemberId } from "../hotel";
import { tr } from "@/lib/i18n";

// 外部連携（MCP）の共通部分。連携先ごとに接続し、ツールの一覧（説明・入力スキーマ）の取得と呼び出しを行う。
// どのツールをAIに使わせるかは、外部連携の画面でツールごとに選ぶ（integration_tools.ai_enabled）。docs/007_ai_settings.md。
// ツールの種類（読み取り／書き込み）は持たない（MCPは読み書きとも同じ tools/call で、種類は相手の自己申告しかないため）。
// 呼び出しは、誰の依頼か（AI・スタッフのAI相談）と引数・結果を、すべて監査ログに残す（callTool）。
// スタッフのAI相談では、相談している人にもツールの権限（integration.<slug>.<ツール名>）が要る

export type Integration = { id: string; hotel_id: string; name: string; slug: string; endpoint_env: string | null; token_env: string | null };
export type ToolRole = "reservation" | "search" | "preload";
export type IntegrationTool = {
  integration_id: string;
  name: string;
  description: string;
  role: ToolRole | null;
  require_staff_confirm: boolean;
  permission_key: string;
};
// 入力スキーマ（MCPのJSON Schema）。連携係への説明と、引数の固定に使う
export type ToolDefinition = { name: string; description: string; inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } };

const globalForMcp = globalThis as unknown as { mcpClients?: Map<string, MCPClient> };

function client(integration: Integration): MCPClient {
  const url = integration.endpoint_env ? process.env[integration.endpoint_env] : undefined;
  const token = integration.token_env ? process.env[integration.token_env] : undefined;
  if (!url) throw new Error(tr(`連携先「${integration.name}」の接続先（${integration.endpoint_env ?? "未設定"}）が環境変数にありません`, `The endpoint for \"${integration.name}\" (${integration.endpoint_env ?? "not set"}) is missing from the environment`));
  globalForMcp.mcpClients ??= new Map();
  const key = `${integration.id}:${url}`;
  let c = globalForMcp.mcpClients.get(key);
  if (!c) {
    c = new MCPClient({
      id: `integration-${integration.id}`,
      servers: { [integration.slug]: { url: new URL(url), requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined } },
    });
    globalForMcp.mcpClients.set(key, c);
  }
  return c;
}

export async function getIntegration(integrationId: string): Promise<Integration | undefined> {
  return queryOne<Integration>("select id, hotel_id, name, slug, endpoint_env, token_env from integrations where id = $1 and kind = 'mcp' and active", [integrationId]);
}

// 相手のMCPサーバーが公開しているツールの定義（説明・入力スキーマ）
export async function fetchToolDefinitions(integration: Integration): Promise<ToolDefinition[]> {
  const catalog = await client(integration).listToolDefinitions();
  return Object.values(catalog[integration.slug] ?? {}).map((d) => ({
    name: d.name,
    description: d.description ?? d.title ?? "",
    inputSchema: (d.inputSchema ?? {}) as ToolDefinition["inputSchema"],
  }));
}

// 相手のツールの一覧を取り直して保存する。新しいツールはAIに使わせない状態で入れ（/manage で選ぶ）、スタッフ用の権限（integration.<slug>.<ツール名>）を作る。
// すでにあるツールの設定（AIに使わせるか・用途・スタッフの確認）は変えない
export async function syncTools(integration: Integration): Promise<ToolDefinition[]> {
  const definitions = await fetchToolDefinitions(integration);
  await transaction(async (client) => {
    for (const d of definitions) {
      const key = `integration.${integration.slug}.${d.name}`;
      await client.query(
        `insert into permissions (key, category, label, scope_kind) values ($1, 'integration', $2, null)
         on conflict (key) do update set label = excluded.label`,
        [key, `${integration.name}: ${d.description || d.name}`.slice(0, 200)],
      );
      await client.query(
        `insert into integration_tools (integration_id, name, description, input_schema, permission_key)
         values ($1, $2, $3, $4, $5)
         on conflict (integration_id, name) do update set description = excluded.description, input_schema = excluded.input_schema, synced_at = now()`,
        [integration.id, d.name, d.description, JSON.stringify(d.inputSchema), key],
      );
    }
    // 相手から消えたツールは一覧から外す（権限は監査ログのために残す）
    await client.query("delete from integration_tools where integration_id = $1 and not (name = any($2))", [integration.id, definitions.map((d) => d.name)]);
  });
  return definitions;
}

// 呼び出しの記録に残す、誰の何のための呼び出しか
export type CallContext = {
  // guest_context: 会話の最初の予約の取得・毎回読む情報 ／ search: 予約の検索 ／ agent: 連携係 ／ confirmed: スタッフが確認して送った呼び出し
  purpose: "guest_context" | "search" | "agent" | "confirmed";
  conversationId?: string;
  // スタッフのAI相談・確認して送ったとき、そのスタッフ
  staffMemberId?: string;
};

// ツールを呼ぶ。成否にかかわらず監査ログに残す（実行者はAIエージェント、権限はツールの権限キー）
export async function callTool<T>(integration: Integration, name: string, args: Record<string, unknown>, context: CallContext): Promise<T> {
  let result: T | undefined;
  let error: unknown;
  try {
    const toolsets = await client(integration).listToolsets();
    const tool = toolsets[integration.slug]?.[name];
    if (!tool?.execute) throw new Error(tr(`連携先「${integration.name}」にツール ${name} がありません`, `\"${integration.name}\" has no tool named ${name}`));
    // エージェントを介さず直接呼ぶため、実行コンテキストは空で渡す
    result = parseResult<T>(await tool.execute(args, {} as Parameters<typeof tool.execute>[1]));
    return result;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await logCall(integration, name, args, context, error).catch((e) => console.warn("[mcp] 監査ログを残せなかった", e));
  }
}

function parseResult<T>(result: unknown): T {
  // MCPの結果は structuredContent か、JSON文字列のテキストで返る
  if (result && typeof result === "object" && "content" in result && Array.isArray((result as { content: unknown }).content)) {
    const r = result as { structuredContent?: T; content: { type: string; text?: string }[] };
    if (r.structuredContent) return r.structuredContent;
    const text = r.content.find((c) => c.type === "text")?.text;
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return { text } as T;
    }
  }
  return result as T;
}

async function logCall(integration: Integration, name: string, args: Record<string, unknown>, context: CallContext, error: unknown) {
  const ai = await getAiAgentMemberId(integration.hotel_id);
  await query(
    `insert into audit_logs (hotel_id, member_id, permission_key, action, target_type, target_id, detail)
     values ($1, $2, (select permission_key from integration_tools where integration_id = $3 and name = $4), 'integration.tool_call', 'integration', $3, $5)`,
    [
      integration.hotel_id, ai ?? null, integration.id, name,
      JSON.stringify({
        tool: name, args, purpose: context.purpose, conversation_id: context.conversationId ?? null, staff_member_id: context.staffMemberId ?? null,
        ok: !error, error: error ? String(error instanceof Error ? error.message : error).slice(0, 300) : null,
      }),
    ],
  );
}

// メンバー（人）がこのツールを使えるか。スタッフのAI相談では、AIエージェントと相談している人の両方に権限が要る
export async function memberMayUse(memberId: string, permissionKey: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>("select has_permission($1, $2) ok", [memberId, permissionKey]);
  return row?.ok ?? false;
}

// AIに使わせるツール（連携先が有効なものだけ）。role を指定すると、その場面でシステムが呼ぶツールに絞る。
// staffMemberId を渡すと、そのスタッフにも権限があるツールに絞る（スタッフのAI相談）
export type AiTool = IntegrationTool & { integration: Integration };

export async function listAiTools(hotelId: string, role?: ToolRole | null, staffMemberId?: string): Promise<AiTool[]> {
  // role を省略したときはすべて、null のときは連携係が選んで使うツールだけ
  return query<AiTool>(
    `select t.integration_id, t.name, t.description, t.role, t.require_staff_confirm, t.permission_key,
       json_build_object('id', i.id, 'hotel_id', i.hotel_id, 'name', i.name, 'slug', i.slug, 'endpoint_env', i.endpoint_env, 'token_env', i.token_env) integration
     from integration_tools t join integrations i on i.id = t.integration_id
     where i.hotel_id = $1 and i.kind = 'mcp' and i.active and t.ai_enabled
       and ($3 or t.role is not distinct from $2::text)
       and ($4::uuid is null or has_permission($4, t.permission_key))
     order by i.name, t.name`,
    [hotelId, role ?? null, role === undefined, staffMemberId ?? null],
  );
}

// 連携先の利用ルール（管理PCで現場が書く自然文）
export async function usageRules(hotelId: string): Promise<Map<string, string>> {
  const rows = await query<{ integration_id: string; body: string }>(
    "select integration_id, body from ai_instructions where hotel_id = $1 and scope = 'integration'",
    [hotelId],
  );
  return new Map(rows.map((r) => [r.integration_id, r.body]));
}

// ツールの結果を指示に入れる文章にする（配列の要素は1行ずつ、ID・日時の列は省く）
export function renderToolResult(data: unknown): string {
  const skip = /(^id$|_id$|created_at|updated_at|written_by)/;
  const line = (v: unknown): string =>
    v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>)
          .filter(([k, x]) => !skip.test(k) && x !== null && x !== "")
          .map(([k, x]) => (typeof x === "object" ? `${k}: ${JSON.stringify(x)}` : String(x)))
          .join("／")
      : String(v);
  if (Array.isArray(data)) return data.length ? data.map((d) => `・${line(d)}`).join("\n") : "・なし";
  if (data && typeof data === "object") {
    const values = Object.values(data as Record<string, unknown>);
    // { notes: [...] } のように配列1つを包んだ形は中身を並べる
    if (values.length === 1 && Array.isArray(values[0])) return renderToolResult(values[0]);
    return `・${line(data)}`;
  }
  return `・${String(data)}`;
}
