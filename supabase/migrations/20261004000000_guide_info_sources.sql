-- ============================================================
-- 案内情報: 館内の情報（資料）と外部の情報源を統合する（docs/006_guide_info.md）
-- URLも資料の1つにし、登録時・更新時とも読み取り → 承認を経てから案内に使う。管理主体が外部の資料には is_external を付ける
-- ============================================================

alter table info_sources
  add column url text,
  add column is_external boolean not null default false,
  -- URLで見る内容（読み取りのヒント）
  add column purpose text not null default '',
  add column fetch_interval_minutes integer check (fetch_interval_minutes between 10 and 1440),
  add column active boolean not null default true,
  add column last_fetched_at timestamptz,
  add column last_success_at timestamptz,
  add column last_status text check (last_status in ('ok', 'error')),
  add column last_error text,
  -- body（今の版）のハッシュ。定期取得で内容が変わったかを見る
  add column content_hash text,
  -- 更新の確認待ちの版（承認で body と差し替える）と、見送った版
  add column pending_body text,
  add column pending_hash text,
  add column dismissed_hash text;

alter table info_sources drop constraint info_sources_status_check;
alter table info_sources add constraint info_sources_status_check check (status in ('pending', 'approved', 'update_pending'));
alter table info_sources add constraint info_sources_url_interval check (url is null or fetch_interval_minutes is not null);

-- 旧 外部の情報源を、確認待ち・本文なしのURL資料として移す（IDはそのまま）。次の定期取得で読み取られる
insert into info_sources (id, hotel_id, title, file_name, body, status, url, is_external, purpose, fetch_interval_minutes, active,
  last_fetched_at, last_success_at, last_status, last_error, created_by, created_at)
select id, hotel_id, name, null, '', 'pending', url, true, purpose, interval_minutes, active,
  null, last_success_at, last_status, last_error, created_by, created_at
from external_sources;

-- 期間を限定して取得の頻度を上げる設定は、URL資料に付け替える
alter table external_source_boosts rename to info_source_boosts;
alter table info_source_boosts drop constraint external_source_boosts_source_id_fkey;
alter table info_source_boosts add constraint info_source_boosts_source_id_fkey foreign key (source_id) references info_sources (id) on delete cascade;

drop table external_snapshots;
drop table external_sources;

-- 資料全般を同じ権限にする: 旧「外部の情報源を登録」を持っていた人・グループには「施設・営業情報の編集」を付ける
insert into group_permissions (group_id, permission_key, scope_ids)
select group_id, 'knowledge.facility.edit', null from group_permissions where permission_key = 'knowledge.source.edit'
on conflict do nothing;
insert into member_permissions (member_id, permission_key, expires_at, granted_by, granted_at)
select member_id, 'knowledge.facility.edit', expires_at, granted_by, granted_at from member_permissions p
where permission_key = 'knowledge.source.edit'
  and not exists (select 1 from member_permissions q where q.member_id = p.member_id and q.permission_key = 'knowledge.facility.edit');
delete from group_permissions where permission_key = 'knowledge.source.edit';
delete from member_permissions where permission_key = 'knowledge.source.edit';
delete from permissions where key = 'knowledge.source.edit';

-- Web取得の連携の名前と、指示の初期値（外部情報の値の案内のしかた）
update integrations set name = 'Webページの取得（Tavily）' where kind = 'web_fetch' and name = '外部の情報源（Tavily）';
update ai_instructions set body = E'・「（外部情報: ○○）」と付いた内容は、ホテル以外が管理する情報。「○○によると」のように出どころを添えて案内する\n・運休や荒天のときは、代わりの手段や時間に余裕を持つことを提案し、詳しくはフロントにおつなぎすると伝える'
where scope = 'integration_read' and integration_id in (select id from integrations where kind = 'web_fetch')
  and body like '・運行情報・天気・イベントなど%';
update permissions set label = 'Webページの取得（Tavily）' where key = 'integration.web_fetch.read';
