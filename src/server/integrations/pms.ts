import { MCPClient } from "@mastra/mcp";
import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import { query, queryOne } from "../db";
import { getAiAgentMemberId } from "../hotel";
import { recordLlmCall } from "../metrics";

// 予約・客室管理システムとの連携（変換層）。plan 3章「ゲスト文脈」「既存システムへの書き戻し」、4.7。
// 相手のMCPツールの出力を自前の形に変換し、項目ごとの読み書きルール（integration_field_rules）と
// AIエージェントの権限（has_permission）をここで必ず確認する。プロンプトの書き方では越えられない

const globalForMcp = globalThis as unknown as { pmsClient?: MCPClient };

function client(): MCPClient {
  const url = process.env.PMS_MCP_URL;
  const token = process.env.PMS_MCP_TOKEN;
  if (!url || !token) throw new Error("PMS_MCP_URL と PMS_MCP_TOKEN が必要です");
  globalForMcp.pmsClient ??= new MCPClient({
    id: "pms-client",
    servers: { pms: { url: new URL(url), requestInit: { headers: { Authorization: `Bearer ${token}` } } } },
  });
  return globalForMcp.pmsClient;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const tools = await client().listTools();
  const tool = tools[`pms_${name}`];
  if (!tool?.execute) throw new Error(`予約・客室管理システムにツール ${name} がありません`);
  // エージェントを介さず直接呼ぶため、実行コンテキストは空で渡す
  const result = (await tool.execute(args, {} as Parameters<typeof tool.execute>[1])) as { structuredContent?: T; content?: { type: string; text?: string }[] } | T;
  // MCPの結果は structuredContent か、JSON文字列のテキストで返る
  if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
    const text = result.content.find((c) => c.type === "text")?.text;
    return (result.structuredContent ?? (text ? JSON.parse(text) : {})) as T;
  }
  return result as T;
}

type Integration = { id: string; hotel_id: string };
type FieldRule = { field: string; can_read: boolean; write_mode: "none" | "append" | "write"; require_staff_confirm: boolean };

// デモは1ホテル・1連携先。複数ホテルに広げるときは、ゲストのURLにホテルを含めて引き当てる
async function pmsIntegration(): Promise<Integration> {
  const row = await queryOne<Integration>("select id, hotel_id from integrations where kind = 'mcp' and active order by name limit 1");
  if (!row) throw new Error("予約・客室管理システムの連携が設定されていません");
  return row;
}

async function fieldRules(integrationId: string): Promise<Map<string, FieldRule>> {
  const rows = await query<FieldRule>("select field, can_read, write_mode, require_staff_confirm from integration_field_rules where integration_id = $1", [
    integrationId,
  ]);
  return new Map(rows.map((r) => [r.field, r]));
}

export async function aiMayUse(hotelId: string, permissionKey: string): Promise<boolean> {
  const ai = await getAiAgentMemberId(hotelId);
  if (!ai) return false;
  const row = await queryOne<{ ok: boolean }>("select has_permission($1, $2) ok", [ai, permissionKey]);
  return row?.ok ?? false;
}

export type GuestContext = {
  reservationId: string;
  hotelId: string;
  guestName: string;
  // 客室の一意のID（本館・別館で同じ部屋番号があっても区別できる）と、表示名（棟＋部屋番号）
  roomId: string | null;
  roomNumber: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  planName: string | null;
  // 読み取りが許可されている場合のみ
  guestNotes?: { category: string; body: string }[];
};

type RawReservation = {
  reservation_id: string;
  hotel_id: string;
  guest_name: string;
  room_id?: string;
  room_number: string;
  check_in: string;
  check_out: string;
  adults: number;
  plan_name: string | null;
  total_amount_jpy?: number;
  error?: string;
};

// ゲスト文脈プロバイダ: 予約内容と（許可されていれば）お客様メモを取得する。料金・支払いは読み取り不可なら渡さない
export async function getGuestContext(reservationId: string): Promise<GuestContext | undefined> {
  const integration = await pmsIntegration();
  if (!(await aiMayUse(integration.hotel_id, "integration.pms.read"))) throw new Error("AIエージェントに予約情報の読み取り権限がありません");
  const rules = await fieldRules(integration.id);
  if (!rules.get("reservation")?.can_read) throw new Error("予約内容の読み取りが許可されていません");

  const raw = await callTool<RawReservation>("get_reservation", { reservation_id: reservationId });
  if (!raw || raw.error || raw.hotel_id !== integration.hotel_id) return undefined;
  // 変換層: 相手の項目名を自前の形に直し、許可されていない項目（料金など）は落とす。部屋は客室IDで自前の部屋マスタに当て、表示名を使う
  const room = raw.room_id
    ? await queryOne<{ label: string }>("select label from rooms where hotel_id = $1 and id = $2", [integration.hotel_id, raw.room_id])
    : undefined;
  const context: GuestContext = {
    reservationId: raw.reservation_id,
    hotelId: raw.hotel_id,
    guestName: raw.guest_name,
    roomId: room ? raw.room_id! : null,
    roomNumber: room?.label ?? raw.room_number,
    checkIn: raw.check_in,
    checkOut: raw.check_out,
    adults: raw.adults,
    planName: raw.plan_name,
  };
  if (rules.get("guest_notes")?.can_read) {
    const { notes } = await callTool<{ notes: { category: string; body: string }[] }>("list_guest_notes", { reservation_id: reservationId });
    context.guestNotes = notes.map((n) => ({ category: n.category, body: n.body }));
  }
  return context;
}

export async function readRuleText(): Promise<string | undefined> {
  const integration = await pmsIntegration();
  const row = await queryOne<{ body: string }>("select body from ai_instructions where integration_id = $1 and scope = 'integration_read'", [integration.id]);
  return row?.body;
}

// ---------- 書き戻し（引き継ぎをお客様メモへ） ----------

const HANDOFF_PREFIX = "【AI引継】";

// 引き継いだ案件を、外部連携の書き込みルール（自然文）に沿ってお客様メモに追記する。
// クレーム関連はスタッフの確認後に書く（確認待ちで保存）。形式が合わなければ保留
export async function writeBackHandoff(params: {
  hotelId: string;
  reservationId: string;
  roomNumber: string;
  handoffId: string;
  kind: string;
  summary: string;
  aiReply?: string;
  handedTo: string;
}) {
  const integration = await pmsIntegration();
  const rules = await fieldRules(integration.id);
  const rule = rules.get("guest_notes");
  if (!rule || rule.write_mode === "none") return;
  if (!(await aiMayUse(params.hotelId, "integration.pms.append"))) return;

  const writeRule = await queryOne<{ body: string }>("select body from ai_instructions where integration_id = $1 and scope = 'integration_write'", [
    integration.id,
  ]);
  const hotel = await queryOne<{ timezone: string }>("select timezone from hotels where id = $1", [params.hotelId]);
  const now = new Date().toLocaleString("ja-JP", { timeZone: hotel?.timezone ?? "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  let content: string;
  try {
    const { object, usage } = await generateStructured({
      tier: "small",
      schema: z.object({ body: z.string().describe("お客様メモに追記する1行") }),
      name: "compose_note",
      description: "お客様メモへの追記内容を作る",
      system: [
        "ホテルの予約・客室管理システムのお客様メモに追記する文を、次の書き込みルールに沿って作る。事実だけを書き、推測しない。",
        writeRule?.body ?? `${HANDOFF_PREFIX}日時／ご要望の要約／AIが案内した内容／引き継ぎ先 の形式で書く。`,
      ].join("\n"),
      prompt: [
        `日時: ${now}`,
        `引き継ぎの種類: ${params.kind}`,
        `ご要望の要約（元になる内容）: ${params.summary}`,
        `AIが案内した内容: ${params.aiReply ?? "なし"}`,
        `引き継ぎ先: ${params.handedTo}`,
        "形式の項目名（「ご要望の要約」など）はそのまま書かず、中身を書く。",
      ].join("\n"),
    });
    await recordLlmCall({ hotelId: params.hotelId, purpose: "compose_note", thinking: false, usage });
    content = object.body.trim();
  } catch (error) {
    console.warn("[pms] 追記内容を作れなかったため定型で書く", error);
    content = `${HANDOFF_PREFIX}${now}／${params.summary}／—／${params.handedTo}`;
  }

  // ガードレール: 形式チェック（書き込みルールの形式）とクレーム関連の確認待ち
  const formatOk = content.startsWith(HANDOFF_PREFIX);
  const needsConfirm = rule.require_staff_confirm || params.kind === "complaint" || params.kind === "overdue_order";
  const status = !formatOk ? "held" : needsConfirm ? "pending_confirm" : "written";
  const aiMemberId = await getAiAgentMemberId(params.hotelId);
  const [{ id }] = await query<{ id: string }>(
    `insert into integration_writes (integration_id, field, external_reservation_id, room_number, content, status, hold_reason, handoff_id, created_by, written_at)
     values ($1, 'guest_notes', $2, $3, $4, $5, $6, $7, $8, case when $5 = 'written' then now() end) returning id`,
    [integration.id, params.reservationId, params.roomNumber, content, status, formatOk ? null : `「${HANDOFF_PREFIX}」で始まる形式ではない`, params.handoffId, aiMemberId ?? null],
  );
  if (status === "written") await sendWrite(id);
}

// 確認待ちの書き込みをスタッフが確認したとき、または即時書き込みのときに相手のシステムへ送る
export async function sendWrite(writeId: string) {
  const write = await queryOne<{ external_reservation_id: string; content: string; field: string }>(
    "select external_reservation_id, content, field from integration_writes where id = $1",
    [writeId],
  );
  if (!write) return;
  if (write.field === "guest_notes") {
    await callTool("append_guest_note", { reservation_id: write.external_reservation_id, category: "AI引継", body: write.content, written_by: "AIエージェント" });
  } else if (write.field === "request_history") {
    await callTool("append_request_history", { reservation_id: write.external_reservation_id, body: write.content, written_by: "AIエージェント" });
  }
  await query("update integration_writes set status = 'written', written_at = now() where id = $1", [writeId]);
}
