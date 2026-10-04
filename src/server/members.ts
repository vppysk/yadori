import type { Member } from "./auth";
import { query, transaction } from "./db";
import { tr } from "@/lib/i18n";

// メンバーと権限（plan 4.8）: 機能ごとの権限をグループ（プリセット）と個別付与（期限・範囲付き）で与える。実効権限は合計（拒否はない）。
// 人（スタッフ）だけを扱う。AIに任せる業務とモデルはAIの成果と割り振り、使わせるツールと実績の出力口の接続元は外部連携で決める（docs/007_ai_settings.md）

export type PermissionDef = { key: string; category: string; label: string; scope_kind: "facility" | "area" | null };
export type GroupRow = { id: string; name: string; is_preset: boolean; permissions: { key: string; scope_ids: string[] | null }[] };
export type DirectGrant = { id: string; permission_key: string; scope_ids: string[] | null; expires_at: string | null; granted_by: string | null };
export type MemberRow = { id: string; kind: "human" | "ai_agent" | "external_system"; display_name: string; job_title: string | null; active: boolean; group_ids: string[]; grants: DirectGrant[]; effective: string[] };
export type ScopeOption = { id: string; label: string; kind: "facility" | "area" };

export type MembersData = { permissions: PermissionDef[]; groups: GroupRow[]; members: MemberRow[]; scopes: ScopeOption[] };

export async function getMembersData(hotelId: string): Promise<MembersData> {
  const [permissions, groups, members, scopes] = await Promise.all([
    // Webページの取得・実績の読み取りは人に付ける権限ではないため出さない
    query<PermissionDef>(
      "select key, category, label, scope_kind from permissions where key not in ('integration.web_fetch.read', 'integration.work_events.read') order by category, key",
    ),
    query<GroupRow>(
      `select g.id, g.name, g.is_preset,
         coalesce(json_agg(json_build_object('key', gp.permission_key, 'scope_ids', gp.scope_ids)) filter (where gp.permission_key is not null), '[]') permissions
       from permission_groups g left join group_permissions gp on gp.group_id = g.id
       where g.hotel_id = $1 group by g.id order by g.is_preset desc, g.name`,
      [hotelId],
    ),
    query<MemberRow>(
      `select m.id, m.kind, m.display_name, m.job_title, m.active,
         coalesce((select array_agg(group_id) from member_groups where member_id = m.id), '{}') group_ids,
         coalesce((select json_agg(json_build_object('id', p.id, 'permission_key', p.permission_key, 'scope_ids', p.scope_ids, 'expires_at', p.expires_at, 'granted_by', gm.display_name) order by p.granted_at)
                   from member_permissions p left join members gm on gm.id = p.granted_by
                   where p.member_id = m.id and (p.expires_at is null or p.expires_at > now())), '[]') grants,
         coalesce((select array_agg(distinct permission_key) from effective_permissions where member_id = m.id), '{}') effective
       from members m where m.hotel_id = $1 and m.kind = 'human' order by m.created_at`,
      [hotelId],
    ),
    query<ScopeOption>(
      `select f.id, f.name label, 'facility' kind from facilities f where f.hotel_id = $1 and f.kind = 'facility'
       union all
       select a.id, a.name, 'area' from areas a where a.hotel_id = $1`,
      [hotelId],
    ),
  ]);
  return { permissions, groups, members, scopes };
}

async function assertSameHotel(hotelId: string, table: "members" | "permission_groups", id: string) {
  // この画面で権限を付けるのは人だけ（AIエージェント・外部システムは出していない）
  const extra = table === "members" ? " and kind = 'human'" : "";
  const rows = await query(`select 1 from ${table} where id = $1 and hotel_id = $2${extra}`, [id, hotelId]);
  if (rows.length === 0) throw new Error(tr("対象が見つかりません", "Target not found"));
}

export async function setMemberGroup(actor: Member, memberId: string, groupId: string, on: boolean) {
  await assertSameHotel(actor.hotel_id, "members", memberId);
  await assertSameHotel(actor.hotel_id, "permission_groups", groupId);
  if (on) await query("insert into member_groups (member_id, group_id) values ($1, $2) on conflict do nothing", [memberId, groupId]);
  else await query("delete from member_groups where member_id = $1 and group_id = $2", [memberId, groupId]);
}

// 期限付きの個別付与（例: 応援の日に「担当になれる」を本日21時まで）。期限が来ると自動で外れる
export async function grantPermission(actor: Member, input: { memberId: string; permissionKey: string; scopeIds: string[] | null; expiresAt: string | null }) {
  await assertSameHotel(actor.hotel_id, "members", input.memberId);
  const hotel = await query<{ timezone: string }>("select timezone from hotels where id = $1", [actor.hotel_id]);
  await query(
    `insert into member_permissions (member_id, permission_key, scope_ids, expires_at, granted_by)
     values ($1, $2, $3, case when $4::text is null then null else ($4::timestamp at time zone $5) end, $6)`,
    [input.memberId, input.permissionKey, input.scopeIds?.length ? input.scopeIds : null, input.expiresAt, hotel[0].timezone, actor.id],
  );
}

export async function revokeGrant(actor: Member, grantId: string) {
  await query(
    "delete from member_permissions p using members m where p.id = $1 and m.id = p.member_id and m.hotel_id = $2",
    [grantId, actor.hotel_id],
  );
}

// グループの権限を丸ごと置き換える。自分の「メンバーと権限の管理」を外してしまわないよう確認する
export async function saveGroup(actor: Member, groupId: string | null, input: { name: string; permissions: { key: string; scope_ids: string[] | null }[] }) {
  await transaction(async (client) => {
    let id = groupId;
    if (id) {
      await assertSameHotel(actor.hotel_id, "permission_groups", id);
      await client.query("update permission_groups set name = $2 where id = $1", [id, input.name.trim().slice(0, 40)]);
    } else {
      const { rows } = await client.query<{ id: string }>("insert into permission_groups (hotel_id, name) values ($1, $2) returning id", [actor.hotel_id, input.name.trim().slice(0, 40)]);
      id = rows[0].id;
    }
    await client.query("delete from group_permissions where group_id = $1", [id]);
    for (const p of input.permissions) {
      await client.query("insert into group_permissions (group_id, permission_key, scope_ids) values ($1, $2, $3)", [id, p.key, p.scope_ids?.length ? p.scope_ids : null]);
    }
    const { rows } = await client.query<{ ok: boolean }>("select has_permission($1, 'settings.members') ok", [actor.id]);
    if (!rows[0].ok) throw new Error(tr("自分の「メンバーと権限の管理」がなくなるため保存できません", "You can't remove your own permission to manage members"));
  });
}
