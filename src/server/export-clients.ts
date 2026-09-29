import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import type { Member } from "./auth";
import { query, queryOne } from "./db";

// 実績の出力口の接続元（plan 4.5、docs/007_ai_settings.md）。当システムに接続してくる外部システム（外部システムのメンバー）。
// 接続元ごとにトークンの環境変数名を持ち（秘密はDBに置かない）、送られてきたトークンで接続元を特定して、その接続元の権限を確認する

export const WORK_EVENTS_READ = "integration.work_events.read";

export type ExportClient = { id: string; display_name: string; token_env: string | null; active: boolean; can_read: boolean; token_set: boolean; last_used: string | null };

export async function listExportClients(hotelId: string): Promise<ExportClient[]> {
  const rows = await query<Omit<ExportClient, "token_set">>(
    `select m.id, m.display_name, m.token_env, m.active,
       exists (select 1 from member_permissions p where p.member_id = m.id and p.permission_key = $2) can_read,
       (select to_char(max(l.created_at) at time zone h.timezone, 'FMMM/FMDD HH24:MI') from audit_logs l where l.member_id = m.id) last_used
     from members m join hotels h on h.id = m.hotel_id
     where m.hotel_id = $1 and m.kind = 'external_system' order by m.created_at`,
    [hotelId, WORK_EVENTS_READ],
  );
  return rows.map((r) => ({ ...r, token_set: Boolean(r.token_env && process.env[r.token_env]) }));
}

export type ExportClientInput = { name: string; tokenEnv: string; active: boolean; canRead: boolean };

function validate(input: ExportClientInput) {
  if (!input.name.trim()) throw new Error("接続元の名前を入力してください");
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.tokenEnv.trim())) throw new Error("トークンの環境変数は英大文字・数字・_ で入力してください");
}

export async function addExportClient(actor: Member, input: ExportClientInput): Promise<string> {
  validate(input);
  const [{ id }] = await query<{ id: string }>(
    "insert into members (hotel_id, kind, display_name, token_env, active) values ($1, 'external_system', $2, $3, $4) returning id",
    [actor.hotel_id, input.name.trim(), input.tokenEnv.trim(), input.active],
  );
  await setCanRead(actor, id, input.canRead);
  return id;
}

export async function saveExportClient(actor: Member, id: string, input: ExportClientInput) {
  validate(input);
  const row = await queryOne<{ id: string }>(
    "update members set display_name = $3, token_env = $4, active = $5 where id = $1 and hotel_id = $2 and kind = 'external_system' returning id",
    [id, actor.hotel_id, input.name.trim(), input.tokenEnv.trim(), input.active],
  );
  if (!row) throw new Error("接続元が見つかりません");
  await setCanRead(actor, id, input.canRead);
}

async function setCanRead(actor: Member, id: string, on: boolean) {
  await query("delete from member_permissions where member_id = $1 and permission_key = $2", [id, WORK_EVENTS_READ]);
  if (on) await query("insert into member_permissions (member_id, permission_key, granted_by) values ($1, $2, $3)", [id, WORK_EVENTS_READ, actor.id]);
}

export async function deleteExportClient(actor: Member, id: string) {
  await query("delete from members where id = $1 and hotel_id = $2 and kind = 'external_system'", [id, actor.hotel_id]);
}

// ---------- 接続の確認（/api/mcp/work-events） ----------

export type ConnectedClient = { memberId: string; hotelId: string };

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Bearerトークンから接続元を特定する（有効な接続元の環境変数のトークンと比べる）
export async function authenticateExportClient(authorization: string | null): Promise<ConnectedClient | undefined> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return undefined;
  const clients = await query<{ id: string; hotel_id: string; token_env: string }>(
    "select id, hotel_id, token_env from members where kind = 'external_system' and active and token_env is not null order by created_at",
  );
  const found = clients.find((c) => {
    const expected = process.env[c.token_env];
    return Boolean(expected) && sameToken(expected!, token);
  });
  return found ? { memberId: found.id, hotelId: found.hotel_id } : undefined;
}

// リクエストの間、接続元をツールの実行に渡す
export const exportClientContext = new AsyncLocalStorage<ConnectedClient>();

// ツールの実行時: 接続元の権限を確かめ、監査ログに残してからホテルを返す
export async function authorizeExportCall(tool: string, detail: Record<string, unknown>): Promise<string> {
  const client = exportClientContext.getStore();
  if (!client) throw new Error("接続元が特定できません");
  const ok = await queryOne<{ ok: boolean }>("select has_permission($1, $2) ok", [client.memberId, WORK_EVENTS_READ]);
  await query(
    `insert into audit_logs (hotel_id, member_id, permission_key, action, detail) values ($1, $2, $3, 'work_events.read', $4)`,
    [client.hotelId, client.memberId, WORK_EVENTS_READ, JSON.stringify({ tool, ...detail, ok: Boolean(ok?.ok) })],
  );
  if (!ok?.ok) throw new Error("この接続元には実績の読み取りの権限がありません");
  return client.hotelId;
}
