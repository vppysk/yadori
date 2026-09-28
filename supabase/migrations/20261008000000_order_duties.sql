-- オーダーの担当を「枠」から「スタッフごとの担当（役割×エリア）」に変える（docs/005_order.md 2章）
-- 担当席（枠ごとの共有アカウント）は廃止し、アカウントは個人だけにする。出勤は枠を選ばずオン／オフだけ

-- ---------- スタッフの担当（固定の担当表） ----------
-- area_id が null は全館担当。管理PCで設定する
create table member_duties (
  member_id uuid not null references members (id) on delete cascade,
  job_role_id uuid not null references job_roles (id) on delete cascade,
  area_id uuid references areas (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique nulls not distinct (member_id, job_role_id, area_id)
);
alter table member_duties enable row level security;

-- 今までの出勤と「担当になれる」の範囲から担当表を作る（担当席は除く）
insert into member_duties (member_id, job_role_id, area_id)
select distinct m.id, s.job_role_id, s.area_id
from members m
join slots s on s.id in (
  select ss.slot_id from slot_shifts ss where ss.member_id = m.id
  union
  select unnest(mp.scope_ids) from member_permissions mp where mp.member_id = m.id and mp.permission_key = 'order.assignable'
)
where m.seat_slot_id is null
on conflict do nothing;

-- ---------- 出勤: 人ごと・日ごと ----------
create table member_shifts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  work_date date not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (member_id, work_date)
);
alter table member_shifts enable row level security;

insert into member_shifts (member_id, work_date, started_at, ended_at)
select ss.member_id, ss.work_date, min(ss.started_at), case when bool_or(ss.ended_at is null) then null else max(ss.ended_at) end
from slot_shifts ss join members m on m.id = ss.member_id
where m.seat_slot_id is null
group by ss.member_id, ss.work_date;

-- ---------- チケット: 枠の代わりに役割とエリアを持つ ----------
alter table tickets
  add column job_role_id uuid references job_roles (id),
  add column area_id uuid references areas (id) on delete set null;
update tickets t set job_role_id = s.job_role_id from slots s where s.id = t.slot_id;
update tickets t set job_role_id = x.job_role_id
from (select distinct on (l.ticket_id) l.ticket_id, i.job_role_id from ticket_lines l join order_items i on i.id = l.order_item_id order by l.ticket_id, l.id) x
where x.ticket_id = t.id and t.job_role_id is null;
update tickets t set area_id = r.area_id from rooms r where r.hotel_id = t.hotel_id and r.id = t.room_id;

-- ---------- 権限: 「担当になれる」は範囲なし、「付け替える」はエリアの範囲 ----------
alter table permissions drop constraint permissions_scope_kind_check;
update permissions set scope_kind = null where key = 'order.assignable';
update permissions set scope_kind = 'area' where key = 'order.reassign';
alter table permissions add constraint permissions_scope_kind_check check (scope_kind in ('facility', 'area'));

update member_permissions set scope_ids = null where permission_key = 'order.assignable';
update group_permissions set scope_ids = null where permission_key = 'order.assignable';
-- 枠の範囲をエリアの範囲に置き換える。全館の枠が含まれていれば範囲なし
update member_permissions mp set scope_ids = x.areas
from (
  select p.id, case when bool_or(s.area_id is null) then null else array_agg(distinct s.area_id) end areas
  from member_permissions p join slots s on s.id = any (p.scope_ids) where p.permission_key = 'order.reassign' group by p.id
) x where x.id = mp.id;
update group_permissions gp set scope_ids = x.areas
from (
  select p.group_id, case when bool_or(s.area_id is null) then null else array_agg(distinct s.area_id) end areas
  from group_permissions p join slots s on s.id = any (p.scope_ids) where p.permission_key = 'order.reassign' group by p.group_id
) x where x.group_id = gp.group_id and gp.permission_key = 'order.reassign';

-- ---------- 担当席の廃止 ----------
-- チケットの履歴から参照されるため、消さずに無効にする
update members set active = false where seat_slot_id is not null;
drop index members_seat_key;
alter table members drop column seat_slot_id, drop column seat_no;

-- ---------- 担当量: 人ごとの1日の合計 ----------
drop view member_daily_load;
alter table tickets drop column slot_id;
drop table slot_shifts;
drop table slots;

create index on tickets (hotel_id, job_role_id, status);

-- 担当者ごとの本日の担当量（累計pt＋未完了pt）。役割をまたいで合計する。割り当ての均等化とスマホの表示に使う
create view member_daily_load with (security_invoker = true) as
select
  s.member_id,
  s.work_date,
  coalesce(sum(t.weight) filter (where t.status = 'done'), 0) as done_points,
  coalesce(sum(t.weight) filter (where t.status in ('new', 'doing')), 0) as open_points,
  max(t.assigned_at) as last_assigned_at
from member_shifts s
join members m on m.id = s.member_id
join hotels h on h.id = m.hotel_id
left join tickets t
  on t.assignee_id = s.member_id
  and (t.assigned_at at time zone h.timezone)::date = s.work_date
where s.ended_at is null
group by s.member_id, s.work_date;
