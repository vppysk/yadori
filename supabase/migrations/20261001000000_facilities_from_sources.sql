-- ============================================================
-- 施設と項目を資料から作る（docs/002_facility_master_design.md）
-- カテゴリを削除する。資料の読み取り結果（確認待ち）は info_sources.draft に持ち、
-- 承認したときに施設・項目名・値を作る（新しい施設や項目は承認までIDがないため）
-- ============================================================

-- 読み取り結果 {rows: [{key, facility, field, title, body, from, to}]}。facility は "id:<施設ID>" か "name:<資料での名前>"
alter table info_sources add column draft jsonb;
alter table info_sources drop column unplaced;

-- 確認待ちの値は facility_values に入れない（承認済みだけを持つ）
delete from facility_values where status = 'pending';

-- 資料のない値（導入時の設定・移行した値）は「導入時の設定」の資料に紐づける（出どころの表示と、資料の削除で消せるように）
insert into info_sources (hotel_id, title, body, status, approved_at)
select distinct f.hotel_id, '導入時の設定', '（導入時に登録した内容）', 'approved', now()
from facility_values v join facilities f on f.id = v.facility_id
where v.source_id is null;

update facility_values v set source_id = s.id
from facilities f, info_sources s
where f.id = v.facility_id and s.hotel_id = f.hotel_id and s.title = '導入時の設定' and v.source_id is null;

alter table facility_values alter column source_id set not null;

-- カテゴリを削除（LLMの案内の精度にほとんど効かないため。2026-09-28 検証）
alter table facilities drop column category_id;
drop table category_fields;
drop table facility_categories;

-- 項目名はホテル全体で1つの一覧（資料の承認で作る）
create index on facilities (hotel_id, sort);
