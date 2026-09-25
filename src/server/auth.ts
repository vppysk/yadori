import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query, queryOne } from "./db";

// デモ用のログイン: メンバーを選ぶだけ（パスワードなし）。本番はSupabase Authと members.auth_user_id で紐づける
export const MEMBER_COOKIE = "hotel_agent_member";

export type Member = {
  id: string;
  hotel_id: string;
  display_name: string;
  job_title: string | null;
  groups: string[];
};

const MEMBER_SQL = `
  select m.id, m.hotel_id, m.display_name, m.job_title,
    coalesce(array_agg(g.name order by g.name) filter (where g.name is not null), '{}') groups
  from members m
  left join member_groups mg on mg.member_id = m.id
  left join permission_groups g on g.id = mg.group_id
  where m.kind = 'human' and m.active`;

export async function listLoginMembers(): Promise<Member[]> {
  return query<Member>(`${MEMBER_SQL} group by m.id order by m.created_at`);
}

export async function getCurrentMember(): Promise<Member | undefined> {
  const id = (await cookies()).get(MEMBER_COOKIE)?.value;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return queryOne<Member>(`${MEMBER_SQL} and m.id = $1 group by m.id`, [id]);
}

// 画面用: 未ログインならログイン画面へ
export async function requireMember(next: string): Promise<Member> {
  const member = await getCurrentMember();
  if (!member) redirect(`/staff/login?next=${encodeURIComponent(next)}`);
  return member;
}

export async function can(memberId: string, permissionKey: string, targetId?: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>("select has_permission($1, $2, $3) ok", [memberId, permissionKey, targetId ?? null]);
  return row?.ok ?? false;
}

export class PermissionError extends Error {}

// サーバーアクション用: ログインと権限を確認し、監査ログに残すための情報を返す（plan 4.8）
export async function authorize(permissionKey: string, targetId?: string): Promise<Member> {
  const member = await getCurrentMember();
  if (!member) throw new PermissionError("ログインしてください");
  if (!(await can(member.id, permissionKey, targetId))) throw new PermissionError("この操作の権限がありません");
  return member;
}

export async function audit(member: Member, permissionKey: string | null, action: string, target?: { type: string; id: string }, detail?: unknown) {
  await query(
    `insert into audit_logs (hotel_id, member_id, permission_key, action, target_type, target_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [member.hotel_id, member.id, permissionKey, action, target?.type ?? null, target?.id ?? null, detail ? JSON.stringify(detail) : null],
  );
}

// 画面の出し分け用: メンバーが持つ権限キーの一覧（範囲付きも含む）
export async function permissionKeys(memberId: string): Promise<Set<string>> {
  const rows = await query<{ permission_key: string }>(
    "select distinct permission_key from effective_permissions where member_id = $1",
    [memberId],
  );
  return new Set(rows.map((r) => r.permission_key));
}
