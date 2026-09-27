-- ============================================================
-- 館内の情報の出どころを「資料」にする（docs/002_facility_master_design.md）
-- スタッフは資料（PDF・画像・文章）を入れ、AIが読み取った値を確認して承認する。
-- 値の型はなくし、タイトル（任意）＋本文（自由文）＋期間（終了日なし可）の1つの形にする。
-- 期間の重なりは承認時にスタッフが優先する方を選び、priority（大きい方が優先）で持つ
-- ============================================================

-- 資料。読み取った本文を持つ（元ファイルは保存しない）。読み取り結果は facility_values に source_id 付きで入る
create table info_sources (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  title text not null,
  file_name text,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  -- どの施設の項目にも当てはまらなかった内容 [{facility, text}]。確認画面で見せるだけ
  unplaced jsonb not null default '[]',
  created_by uuid references members (id),
  created_at timestamptz not null default now(),
  approved_by uuid references members (id),
  approved_at timestamptz
);
create index on info_sources (hotel_id, created_at desc);

alter table facility_values
  add column source_id uuid references info_sources (id) on delete cascade, -- null は導入時の設定・移行した値
  add column title text,
  add column body text,
  add column priority double precision not null default 0;

-- 旧の型ごとの値を文章にする（時間帯: 「11:30〜14:00（L.O. 20:30）」「休業」、一覧: 「8,800円。説明」、文章: そのまま）
update facility_values v set
  title = case i.value_type when 'text' then null else coalesce(v.value ->> 'label', v.value ->> 'name') end,
  body = case i.value_type
    when 'hours' then case when (v.value ->> 'closed')::boolean then '休業'
      else (v.value ->> 'opens') || '〜' || (v.value ->> 'closes') || coalesce('（' || nullif(v.value ->> 'note', '') || '）', '') end
    when 'list' then concat_ws('。',
      case when v.value ->> 'price_jpy' is not null then to_char((v.value ->> 'price_jpy')::int, 'FM999,999,999') || '円' end,
      nullif(v.value ->> 'description', ''))
    else v.value ->> 'text' end
from info_fields i where i.id = v.field_id;

drop view facility_period_overlaps;

alter table facility_values alter column body set not null;
alter table facility_values drop column value;
alter table facility_values drop column source_file_id;
alter table facility_values drop constraint facility_values_status_check;
update facility_values set status = case status when 'draft' then 'pending' else 'approved' end;
alter table facility_values alter column status set default 'approved';
alter table facility_values add constraint facility_values_status_check check (status in ('pending', 'approved'));
create index on facility_values (source_id);

alter table info_fields drop column value_type;

-- 優先する方が決まっていない期間の重なり（同じ施設・項目・タイトルで、優先度が同じ）。管理PCの「要確認」に使う
create view facility_period_overlaps with (security_invoker = true) as
select a.facility_id, a.field_id, a.id as a_id, b.id as b_id, coalesce(a.title, i.name) as name
from facility_values a
join facility_values b on a.facility_id = b.facility_id and a.field_id = b.field_id and a.id < b.id
  and coalesce(a.title, '') = coalesce(b.title, '') and a.valid && b.valid and a.priority = b.priority
join info_fields i on i.id = a.field_id
where a.status = 'approved' and b.status = 'approved';

alter table info_sources enable row level security;
