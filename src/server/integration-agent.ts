import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import { query, queryOne } from "./db";
import { getAiAgentMemberId } from "./hotel";
import { callTool, getIntegration, listAiTools, renderToolResult, syncTools, usageRules, type AiTool, type ToolDefinition } from "./integrations/mcp";
import { recordLlmCall } from "./metrics";

// 連携係（docs/007_ai_settings.md 3.4）: 外部の連携先（MCP）のツールをAIが選んで使う。
// 回答係にはツールを持たせない（Nemotronがツール呼び出しを文字で書く・同じ呼び出しを繰り返したため。plan 12章）。
// 連携係は呼ぶツールと引数を1回で選ぶだけにし（強制ツール呼び出し）、呼び出しと結果の整形はコードで行う。
// 予約番号・ホテルIDはサーバーがゲスト本人の値で上書きする（AIは他人の予約を指定できない）。書き込みは integration_writes に積んでから送る

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

// 連携係が選べるツール（システムが決まった場面で呼ぶツールは除く）と、その入力スキーマ
async function availableTools(hotelId: string, access?: "read" | "write", staffMemberId?: string): Promise<ToolWithSchema[]> {
  const tools = (await listAiTools(hotelId, null, staffMemberId)).filter((t) => !access || t.access === access);
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
      lines.push(`- ${t.key}（${t.access === "read" ? "読み取り" : "書き込み"}）: ${t.description}${props.length ? ` ／ 引数: ${props.join("、")}` : ""}`);
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
      "あなたはホテルのゲスト対応AIの連携係。外部の連携先（予約システムなど）のツールを呼ぶかどうかを判断し、呼ぶツールと引数を選ぶ。",
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

export type IntegrationFacts = { text: string; wrote: number };

// ゲストの発言（またはスタッフのAI相談の質問）に答えるために連携先を調べる。読み取りの結果は回答係に渡す文章にし、
// 書き込みは積む（利用ルールで決められているときだけ）。スタッフのAI相談（staffMemberId あり）は読み取りだけで、そのスタッフにも権限があるツールに絞る
export async function consultIntegrations(params: {
  guest: Guest;
  conversationId?: string;
  text: string;
  history: { role: string; content: string }[];
  staffMemberId?: string;
}): Promise<IntegrationFacts | undefined> {
  const { guest, staffMemberId } = params;
  const tools = await availableTools(guest.hotelId, staffMemberId ? "read" : undefined, staffMemberId);
  if (tools.length === 0) return undefined;
  const speaker = staffMemberId ? "スタッフ" : "ゲスト";
  let calls;
  try {
    calls = await plan({
      hotelId: guest.hotelId,
      conversationId: params.conversationId,
      tools,
      task: staffMemberId
        ? ["スタッフが、このゲストについてAIに相談している。答えるのに連携先の情報が必要なときだけ、読み取りのツールを選ぶ。"]
        : [
            "ゲストの発言に答えるのに、連携先の情報が必要なときだけ読み取りのツールを選ぶ。",
            "書き込みのツールは、利用ルールで書くように決められている内容がゲストの発言にあるときだけ選ぶ。",
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

  const sections: string[] = [];
  const written: string[] = [];
  for (const { tool, args } of bound) {
    if (tool.access === "write") {
      // スタッフの相談からは書き込まない（読み取りのツールしか渡していないが、念のため）
      if (staffMemberId) continue;
      const content = await queueWrite({ tool, args, guest, conversationId: params.conversationId });
      written.push(`・${tool.integration.name}: ${tool.description || tool.name}「${content}」`);
      continue;
    }
    try {
      const data = await callTool<unknown>(tool.integration, tool.name, args);
      sections.push(`### ${tool.integration.name}: ${tool.description || tool.name}`, renderToolResult(data));
    } catch (error) {
      console.warn("[integration-agent] ツールの呼び出しに失敗", tool.key, error);
      sections.push(`### ${tool.integration.name}: ${tool.description || tool.name}`, "・取得できなかった（推測で答えない）");
    }
  }
  // 記録しただけで手配はしていない（回答係が「ご用意します」と約束したため、2026-09-28）
  if (written.length) sections.push("### 記録したこと（記録しただけで、手配・予約はしていない。手配したとは言わない）", ...written);
  return sections.length ? { text: sections.join("\n"), wrote: written.length } : undefined;
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
  const tools = await availableTools(params.guest.hotelId, "write");
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
    await queueWrite({ tool, args, guest: params.guest, conversationId: params.conversationId, handoffId: params.handoffId, forceConfirm });
  }
}

async function queueWrite(params: {
  tool: AiTool;
  args: Record<string, unknown>;
  guest: Guest;
  conversationId?: string;
  handoffId?: string;
  forceConfirm?: boolean;
}): Promise<string> {
  const { tool, args, guest } = params;
  const confirm = tool.require_staff_confirm || params.forceConfirm;
  const content = typeof args.body === "string" ? args.body : JSON.stringify(args);
  const [{ id }] = await query<{ id: string }>(
    `insert into integration_writes (integration_id, tool_name, args, external_reservation_id, room_number, content, status, handoff_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      tool.integration_id, tool.name, JSON.stringify(args), guest.reservationId, guest.roomNumber, content,
      confirm ? "pending_confirm" : "written", params.handoffId ?? null, (await getAiAgentMemberId(guest.hotelId)) ?? null,
    ],
  );
  if (!confirm) await sendWrite(id);
  return content;
}

// 確認待ちの書き込みをスタッフが確認したとき、または確認の要らない書き込みのときに相手のシステムへ送る。失敗したら保留にする
export async function sendWrite(writeId: string) {
  const write = await queryOne<{ integration_id: string; tool_name: string | null; args: Record<string, unknown> | null }>(
    "select integration_id, tool_name, args from integration_writes where id = $1",
    [writeId],
  );
  if (!write?.tool_name || !write.args) return;
  try {
    const integration = await getIntegration(write.integration_id);
    if (!integration) throw new Error("連携先が無効です");
    await callTool(integration, write.tool_name, write.args);
    await query("update integration_writes set status = 'written', written_at = now(), hold_reason = null where id = $1", [writeId]);
  } catch (error) {
    console.warn("[integration-agent] 書き込みに失敗", error);
    await query("update integration_writes set status = 'held', hold_reason = $2 where id = $1", [writeId, `送れなかった: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500)]);
  }
}
