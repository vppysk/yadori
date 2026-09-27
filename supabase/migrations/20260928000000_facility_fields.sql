-- ============================================================
-- 館内の情報のマスタ化（docs/002_facility_master_design.md）
-- 項目（営業時間・メニューなど）とカテゴリ（食事・温浴など）をデータで持ち、値は「施設 × 項目 × 期間」の行にする。
-- 項目・カテゴリ・施設は導入時に設定する（画面からの編集は対象外）
-- ============================================================

-- カテゴリ（食事、温浴、アクティビティ…）。「全体」欄（kind='global'）はカテゴリに属さない
create table facility_categories (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  unique (hotel_id, name)
);

-- 項目。型（value_type）ごとの値の形・入力欄・AIへの文章はアプリ側（src/server/facility-fields.ts）で持つ
create table info_fields (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  value_type text not null check (value_type in ('hours', 'list', 'text')),
  sort integer not null default 0,
  unique (hotel_id, name)
);

-- カテゴリで使う項目と並び順（施設の画面とAIに渡す文章の順番）
create table category_fields (
  category_id uuid not null references facility_categories (id) on delete cascade,
  field_id uuid not null references info_fields (id) on delete restrict,
  sort integer not null default 0,
  primary key (category_id, field_id)
);

alter table facilities add column category_id uuid references facility_categories (id) on delete restrict;

-- 値。valid は滞在日（ホテル現地の日付）の範囲 [from, to]。value の形は型ごとにアプリ側（Zod）で検証する
--   hours: {label, opens, closes, closed, note} / list: {name, price_jpy, description} / text: {text}
create table facility_values (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities (id) on delete cascade,
  field_id uuid not null references info_fields (id) on delete restrict,
  valid daterange not null,
  value jsonb not null,
  status text not null default 'published' check (status in ('draft', 'published')),
  source_file_id uuid references source_files (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references members (id)
);
create index on facility_values using gist (facility_id, valid);
create index on facility_values (field_id);

-- ---------- 既存データの移行: 営業時間（hours）とメニュー・プラン（list）の2項目、カテゴリは「施設」1つにまとめる ----------

insert into info_fields (hotel_id, name, value_type, sort)
select h.id, x.name, x.value_type, x.sort
from hotels h cross join (values ('営業時間', 'hours', 1), ('メニュー・プラン', 'list', 2)) as x (name, value_type, sort)
where exists (select 1 from facilities f where f.hotel_id = h.id);

insert into facility_categories (hotel_id, name, sort)
select distinct hotel_id, '施設', 1 from facilities where kind = 'facility';

insert into category_fields (category_id, field_id, sort)
select c.id, f.id, f.sort from facility_categories c join info_fields f on f.hotel_id = c.hotel_id;

update facilities f set category_id = c.id
from facility_categories c where c.hotel_id = f.hotel_id and f.kind = 'facility';

insert into facility_values (facility_id, field_id, valid, value, status, source_file_id, updated_at, updated_by)
select h.facility_id, i.id, h.valid,
  jsonb_build_object('label', h.label, 'opens', to_char(h.opens_at, 'HH24:MI'), 'closes', to_char(h.closes_at, 'HH24:MI'), 'closed', h.closed, 'note', h.note),
  h.status, h.source_file_id, h.updated_at, h.updated_by
from facility_hours h join facilities f on f.id = h.facility_id join info_fields i on i.hotel_id = f.hotel_id and i.name = '営業時間';

insert into facility_values (facility_id, field_id, valid, value, status, source_file_id, updated_at, updated_by)
select o.facility_id, i.id, o.valid,
  jsonb_build_object('name', o.name, 'price_jpy', o.price_jpy, 'description', o.description),
  o.status, o.source_file_id, o.updated_at, o.updated_by
from facility_offerings o join facilities f on f.id = o.facility_id join info_fields i on i.hotel_id = f.hotel_id and i.name = 'メニュー・プラン';

-- 写し漏れがあれば止める（旧テーブルを消す前に確認）
do $$
begin
  if (select count(*) from facility_values) <> (select count(*) from facility_hours) + (select count(*) from facility_offerings) then
    raise exception '営業時間・メニューの移行で件数が一致しません';
  end if;
end $$;

drop view facility_period_overlaps;
drop table facility_hours;
drop table facility_offerings;

-- 期間の重なり（禁止せず警告）。時間帯は同じ時間帯名、一覧は同じ名称、文章は同じ項目で比べる
create view facility_period_overlaps with (security_invoker = true) as
select a.facility_id, a.field_id, a.id as a_id, b.id as b_id, coalesce(a.value ->> 'label', a.value ->> 'name', i.name) as name
from facility_values a
join facility_values b on a.facility_id = b.facility_id and a.field_id = b.field_id and a.id < b.id and a.valid && b.valid
join info_fields i on i.id = a.field_id
where coalesce(a.value ->> 'label', a.value ->> 'name', '') = coalesce(b.value ->> 'label', b.value ->> 'name', '');

alter table facility_categories enable row level security;
alter table info_fields enable row level security;
alter table category_fields enable row level security;
alter table facility_values enable row level security;
