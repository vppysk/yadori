import type { Member } from "./auth";
import { query } from "./db";
import { getHotel, localNow } from "./hotel";
import { assignUnassigned } from "./orders";

// 担当設定（docs/005_order.md 2章）: スタッフごとに担当する役割×エリアを決める固定の担当表。area_id が null は全館
// 出勤は現場スマホでオン／オフするだけで、割り当ての候補はこの担当表で決まる

export type DutyStaff = {
  id: string;
  name: string;
  job_title: string | null;
  assignable: boolean; // 「担当になれる」権限があるか（なければ担当を決めても割り当てられない）
  on_shift: boolean;
  duties: { job_role_id: string; area_id: string | null }[];
};

export type DutySettings = {
  staff: DutyStaff[];
  roles: { id: string; name: string }[];
  areas: { id: string; name: string }[];
};

export async function getDutySettings(hotelId: string): Promise<DutySettings> {
  const hotel = await getHotel(hotelId);
  const [staff, roles, areas] = await Promise.all([
    query<DutyStaff>(
      `select m.id, m.display_name name, m.job_title, has_permission(m.id, 'order.assignable') assignable,
         exists (select 1 from member_shifts sh where sh.member_id = m.id and sh.work_date = $2 and sh.ended_at is null) on_shift,
         coalesce((select json_agg(json_build_object('job_role_id', d.job_role_id, 'area_id', d.area_id)) from member_duties d where d.member_id = m.id), '[]') duties
       from members m where m.hotel_id = $1 and m.kind = 'human' and m.active
       order by has_permission(m.id, 'order.assignable') desc, m.created_at`,
      [hotelId, localNow(hotel.timezone).date],
    ),
    query<{ id: string; name: string }>("select id, name from job_roles where hotel_id = $1 order by name", [hotelId]),
    query<{ id: string; name: string }>("select id, name from areas where hotel_id = $1 order by sort, name", [hotelId]),
  ]);
  return { staff, roles, areas };
}

// 担当の1つを付ける・外す。付けたときは、担当者なしで待っているチケットをすぐ割り当て直す
export async function setDuty(actor: Member, memberId: string, jobRoleId: string, areaId: string | null, on: boolean) {
  const [ok] = await query<{ member: boolean; role: boolean; area: boolean }>(
    `select exists (select 1 from members where id = $1 and hotel_id = $4 and kind = 'human') member,
       exists (select 1 from job_roles where id = $2 and hotel_id = $4) role,
       $3::uuid is null or exists (select 1 from areas where id = $3 and hotel_id = $4) area`,
    [memberId, jobRoleId, areaId, actor.hotel_id],
  );
  if (!ok.member || !ok.role || !ok.area) throw new Error("スタッフ・役割・エリアが見つかりません");
  if (on) {
    await query("insert into member_duties (member_id, job_role_id, area_id) values ($1, $2, $3) on conflict do nothing", [memberId, jobRoleId, areaId]);
    await assignUnassigned(await getHotel(actor.hotel_id), actor.id);
  } else {
    await query("delete from member_duties where member_id = $1 and job_role_id = $2 and area_id is not distinct from $3", [memberId, jobRoleId, areaId]);
  }
}
