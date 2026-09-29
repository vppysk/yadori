import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import { query, queryOne } from "./db";
import { getAiAgentMemberId } from "./hotel";
import { callTool, getIntegration, listAiTools, renderToolResult, syncTools, usageRules, type AiTool, type ToolDefinition } from "./integrations/mcp";
import { recordLlmCall } from "./metrics";

// 連携係（docs/007_ai_settings.md 3.4）: 外部の連携先（MCP）のツールをAIが選んで使う。
// 回答係にはツールを持たせない（Nemotronがツール呼び出しを文字で書く・同じ呼び出しを繰り返したため。plan 12章）。
// 連携係は呼ぶツールと引数を1回で選ぶだけにし（強制ツール呼び出し）、呼び出しと結果の整形はコードで行う。
// 予約番号・ホテルIDはサーバーがゲスト本人の値で上書きする（AIは他人の予約を指定できない）。
// ツールの種類（読み取り／書き込み）は持たない。「スタッフの確認後に送る」ツールは integration_writes に積み、それ以外はその場で呼ぶ。呼び出しはすべて監査ログに残る（callTool）

const MAX_CALLS = 4;
// 引数をサーバーの値で固定する項目
const BOUND_ARGS = ["reservation_id", "hotel_id", "written_by"] as const;

const planSchema = z.object({
  calls: z
    .array(
      z.object({
        tool: z.string().describe("ツールの名前（「連携先.ツール名」の形）"),
        args: z.record(z.string(), z.unknown()).describe("引数。予約番号・ホテルIDは書かなくてよい"),
      }),
    )
    .max(MAX_CALLS)
    .describe("呼ぶツール。必要なければ空の配列"),
});

type Guest = { hotelId: string; reservationId: string; roomNumber: string; checkIn: string; checkOut: string };
type ToolWithSchema = AiTool & { key: string; schema?: ToolDefinition["inputSchema"] };

// 連携係が選べるツール（システムが決まった場面で呼ぶツールは除く）と、その入力スキーマ。
// スタッフのAI相談では、そのスタッフに権限があり、スタッフの確認が要らないツールだけ
async function availableTools(hotelId: string, staffMemberId?: string): Promise<ToolWithSchema[]> {
  const tools = (await listAiTools(hotelId, null, staffMemberId)).filter((t) => !staffMemberId || !t.require_staff_confirm);
  const ids = [...new Set(tools.map((t) => t.integration_id))];
  const loadSchemas = () => query<{ integration_id: string; name: string; input_schema: ToolDefinition["inputSchema"] | null }>(
    "select integration_id, name, input_schema from integration_tools where integration_id = any($1)",
    [ids],
  );
  let schemas = await loadSchemas();
  // スキーマが未取得のツールがあれば、その連携先のツールを取り直す
  const missing = new Set(schemas.filter((s) => !s.input_schema).map((s) => s.integration_id));
  if (missing.size) {
    for (const id of missing) {
      const integration = tools.find((t) => t.integration_id === id)!.integration;
      await syncTools(integration).catch((error) => console.warn("[integration-agent] ツールを取得できなかった", integration.name, error));
    }
    schemas = await loadSchemas();
  }
  // 引数を固定できないため、スキーマのないツールは使わせない
  return tools
    .filter((t) => schemas.some((s) => s.integration_id === t.integration_id && s.name === t.name && s.input_schema))
    .map((t) => ({
    ...t,
    key: `${t.integration.slug}.${t.name}`,
    schema: schemas.find((s) => s.integration_id === t.integration_id && s.name === t.name)?.input_schema ?? undefined,
  }));
}

function describeTools(tools: ToolWithSchema[], rules: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const integrationId of new Set(tools.map((t) => t.integration_id))) {
    const group = tools.filter((t) => t.integration_id === integrationId);
    lines.push("", `### ${group[0].integration.name}`, `利用ルール:`, rules.get(integrationId) ?? "（なし）", "ツール:");
    for (const t of group) {
      const props = Object.entries(t.schema?.properties ?? {})
        .filter(([name]) => !(BOUND_ARGS as readonly string[]).includes(name))
        .map(([name, p]) => `${name}${t.schema?.required?.includes(name) ? "（必須）" : ""}: ${p.description ?? p.type ?? ""}`);
      lines.push(`- ${t.key}: ${t.description}${t.require_staff_confirm ? "（スタッフの確認後に送られる）" : ""}${props.length ? ` ／ 引数: ${props.join("、")}` : ""}`);
    }
  }
  return lines;
}

// 選ばれた呼び出しを検証し、引数をサーバーの値で固定する
function bind(tools: ToolWithSchema[], calls: z.infer<typeof planSchema>["calls"], guest: Guest, extra: Record<string, unknown> = {}) {
  const seen = new Set<string>();
  const result: { tool: ToolWithSchema; args: Record<string, unknown> }[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.key === call.tool || t.name === call.tool);
    if (!tool) continue;
    const props = tool.schema?.properties ?? {};
    const fixed: Record<string, unknown> = { reservation_id: guest.reservationId, hotel_id: guest.hotelId, written_by: "AIエージェント", ...extra };
    const args = { ...call.args };
    for (const [name, value] of Object.entries(fixed)) if (name in props) args[name] = value;
    // 必須の引数がそろっていない呼び出しは送らない
    if ((tool.schema?.required ?? []).some((name) => args[name] === undefined || args[name] === "")) continue;
    const key = `${tool.key}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ tool, args });
  }
  return result.slice(0, MAX_CALLS);
}

async function plan(params: { hotelId: string; conversationId?: string; tools: ToolWithSchema[]; task: string[]; prompt: string }) {
  const rules = await usageRules(params.hotelId);
  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: planSchema,
    name: "choose_tools",
    description: "外部の連携先のツールのうち、呼ぶものと引数を選ぶ",
    system: [
      "あなたはホテルのAIの連携係。外部の連携先（予約システムなど）のツールを呼ぶかどうかを判断し、呼ぶツールと引数を選ぶ。",
      ...params.task,
      "予約番号・ホテルID・書き手はシステムが入れるので、引数に書かない。",
      `同じツールを同じ引数で2回呼ばない。最大${MAX_CALLS}件。必要なければ calls を空にする。`,
      "",
      "## 連携先とツール",
      ...describeTools(params.tools, rules),
    ].join("\n"),
    prompt: params.prompt,
    maxOutputTokens: 1500,
  });
  await recordLlmCall({ hotelId: params.hotelId, conversationId: params.conversationId, purpose: "integration_agent", thinking: false, usage });
  return object.calls;
}

export type IntegrationFacts = { text: string };

// ゲストの発言（またはスタッフのAI相談の質問）に答えるために連携先のツールを使う。結果は回答係に渡す文章にする。
// スタッフのAI相談（staffMemberId あり）は、そのスタッフにも権限があるツールに絞る
export async function consultIntegrations(params: {
  guest: Guest;
  conversationId?: string;
  text: string;
  history: { role: string; content: string }[];
  staffMemberId?: string;
}): Promise<IntegrationFacts | undefined> {
  const { guest, staffMemberId } = params;
  const tools = await availableTools(guest.hotelId, staffMemberId);
  if (tools.length === 0) return undefined;
  const speaker = staffMemberId ? "スタッフ" : "ゲスト";
  let calls;
  try {
    calls = await plan({
      hotelId: guest.hotelId,
      conversationId: params.conversationId,
      tools,
      task: [
        staffMemberId
          ? "スタッフが、このゲストについてAIに相談している。答えるのに連携先の情報が必要なときだけ、情報を取るツールを選ぶ。記録・変更をするツールは選ばない。"
          : "ゲストの発言に答えるのに連携先の情報が必要なときだけ、情報を取るツールを選ぶ。",
        ...(staffMemberId ? [] : ["記録・変更をするツールは、利用ルールで記録するように決められている内容がゲストの発言にあるときだけ選ぶ。"]),
      ],
      prompt: [
        `ゲスト: ${guest.roomNumber}号室、ご滞在 ${guest.checkIn}〜${guest.checkOut}`,
        ...params.history.slice(-4).map((m) => `${m.role === "user" ? speaker : "AI"}: ${m.content}`),
        `${speaker}（今回の発言）: ${params.text}`,
      ].join("\n"),
    });
  } catch (error) {
    console.warn("[integration-agent] ツールを選べなかった", error);
    return undefined;
  }
  const bound = bind(tools, calls, guest);
  if (bound.length === 0) return undefined;

  // 呼んだことは手配・予約の完了を意味しない（連携係がお客様メモに好みを書いたとき、回答係が「ご用意します」と約束した。2026-09-28）
  const sections: string[] = ["（ツールを呼んだ結果。呼んだことは手配・予約の完了を意味しない。結果に書かれていることだけを伝え、手配したとは言わない）"];
  for (const { tool, args } of bound) {
    const title = `### ${tool.integration.name}: ${tool.description || tool.name}`;
    if (tool.require_staff_confirm) {
      await queueCall({ tool, args, guest, conversationId: params.conversationId });
      sections.push(title, "・スタッフの確認待ちにした（まだ送っていない）");
      continue;
    }
    try {
      const data = await callTool<unknown>(tool.integration, tool.name, args, { purpose: "agent", conversationId: params.conversationId, staffMemberId });
      sections.push(title, renderToolResult(data));
    } catch (error) {
      console.warn("[integration-agent] ツールの呼び出しに失敗", tool.key, error);
      sections.push(title, "・取得できなかった（推測で答えない）");
    }
  }
  return { text: sections.join("\n") };
}

// 引き継いだ案件を、利用ルールに沿って連携先に書き戻す（plan 3章「既存システムへの書き戻し」）。
// クレーム・オーダーの遅延はスタッフの確認後に送る（固定の決まり）
export async function writeBackHandoff(params: {
  guest: Guest;
  conversationId?: string;
  handoffId: string;
  kind: string;
  summary: string;
  aiReply?: string;
  handedTo: string;
}) {
  const tools = await availableTools(params.guest.hotelId);
  if (tools.length === 0) return;
  const calls = await plan({
    hotelId: params.guest.hotelId,
    conversationId: params.conversationId,
    tools,
    task: [
      "AIからスタッフへ引き継いだ案件を、連携先の利用ルールに沿って書き戻す。利用ルールに引き継ぎの書き方がなければ calls を空にする。",
      "書く内容は事実だけにし、推測しない。形式の項目名（「ご要望の要約」など）はそのまま書かず、中身を書く。分類の引数があれば「AI引継」にする。",
    ],
    prompt: [
      `引き継ぎの種類: ${params.kind}`,
      `ご要望の要約: ${params.summary}`,
      `AIが案内した内容: ${params.aiReply ?? "なし"}`,
      `引き継ぎ先: ${params.handedTo}`,
    ].join("\n"),
  });
  const forceConfirm = params.kind === "complaint" || params.kind === "overdue_order";
  for (const { tool, args } of bind(tools, calls, params.guest)) {
    if (tool.require_staff_confirm || forceConfirm) {
      await queueCall({ tool, args, guest: params.guest, conversationId: params.conversationId, handoffId: params.handoffId });
      continue;
    }
    await callTool(tool.integration, tool.name, args, { purpose: "agent", conversationId: params.conversationId }).catch((error) =>
      console.warn("[integration-agent] 書き戻しに失敗", tool.key, error),
    );
  }
}

// スタッフの確認後に送る呼び出しを積む
async function queueCall(params: { tool: AiTool; args: Record<string, unknown>; guest: Guest; conversationId?: string; handoffId?: string }) {
  const { tool, args, guest } = params;
  const content = typeof args.body === "string" ? args.body : JSON.stringify(args);
  await query(
    `insert into integration_writes (integration_id, tool_name, args, external_reservation_id, room_number, content, status, handoff_id, created_by)
     values ($1, $2, $3, $4, $5, $6, 'pending_confirm', $7, $8)`,
    [tool.integration_id, tool.name, JSON.stringify(args), guest.reservationId, guest.roomNumber, content, params.handoffId ?? null, (await getAiAgentMemberId(guest.hotelId)) ?? null],
  );
}

// 確認待ちの呼び出しを、スタッフが確認して相手のシステムへ送る。失敗したら保留にする
export async function sendWrite(writeId: string, staffMemberId: string) {
  const write = await queryOne<{ integration_id: string; tool_name: string | null; args: Record<string, unknown> | null }>(
    "select integration_id, tool_name, args from integration_writes where id = $1",
    [writeId],
  );
  if (!write?.tool_name || !write.args) return;
  try {
    const integration = await getIntegration(write.integration_id);
    if (!integration) throw new Error("連携先が無効です");
    await callTool(integration, write.tool_name, write.args, { purpose: "confirmed", staffMemberId });
    await query("update integration_writes set status = 'written', written_at = now(), hold_reason = null where id = $1", [writeId]);
  } catch (error) {
    console.warn("[integration-agent] 書き込みに失敗", error);
    await query("update integration_writes set status = 'held', hold_reason = $2 where id = $1", [writeId, `送れなかった: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500)]);
  }
}
