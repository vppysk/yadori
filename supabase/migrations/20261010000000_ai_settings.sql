-- ゲスト対応AIと外部連携の設定の整理（docs/007_ai_settings.md）
-- 指示は1本に、ガードレールの画面設定は廃止して回答後のチェック項目（reply_checks）に、
-- 外部連携は項目ごとの権限をやめてツールごとの権限（integration_tools）にする

-- ---------- 指示: 業務ごとの指示を共通の指示に条件付きで足し、1本にする ----------

with p as (
  select hotel_id, string_agg(
    case pattern
      when 'info' then '館内の案内'
      when 'order' then 'お届けの依頼'
      when 'external' then '周辺の案内・外部の予約'
      when 'reservation' then '予約・客室の変更'
      when 'complaint' then '苦情・不満'
    end || 'のときは:' || E'\n' || body, E'\n\n' order by pattern) body
  from ai_instructions where scope = 'pattern' and btrim(body) <> ''
  group by hotel_id
)
update ai_instructions c set body = c.body || E'\n\n' || p.body
from p where c.hotel_id = p.hotel_id and c.scope = 'common';

insert into ai_instructions (hotel_id, scope, body)
select hotel_id, 'common', string_agg(body, E'\n\n' order by pattern)
from ai_instructions a
where scope = 'pattern' and btrim(body) <> ''
  and not exists (select 1 from ai_instructions c where c.hotel_id = a.hotel_id and c.scope = 'common')
group by hotel_id;

-- 確定前の確認と、固定の項目にない禁止事項は、指示の文章に移す（保存のたびに回答後のチェック項目として抜き出す）
with g as (
  select hotel_id, string_agg(line, E'\n' order by kind, sort) body
  from (
    select hotel_id, kind, sort, '・' || body line from guardrails
    where enabled and kind = 'forbidden'
      and body not in ('値引き・補償・返金を約束しない', '他のお客様の情報（部屋番号・氏名など）を話さない', '体調に関する助言をせず、フロントへつなぐ')
    union all
    select hotel_id, kind, sort, '・' || body || 'は、確定する前に必ずお客様に確認する' from guardrails where enabled and kind = 'confirm_before'
  ) x
  group by hotel_id
)
update ai_instructions c set body = c.body || E'\n\n' || g.body
from g where c.hotel_id = g.hotel_id and c.scope = 'common';

-- 連携先ごとの読み取り・書き込みルールは「利用ルール」1本にする
alter table ai_instructions drop constraint ai_instructions_scope_check;
insert into ai_instructions (hotel_id, scope, integration_id, body)
select a.hotel_id, 'integration', a.integration_id, string_agg(a.body, E'\n' order by a.scope)
from ai_instructions a join integrations i on i.id = a.integration_id
where a.scope in ('integration_read', 'integration_write') and i.kind = 'mcp'
group by a.hotel_id, a.integration_id;

-- 形式（【AI引継】）はシステムが付けるため、デモの予約・客室管理システムの利用ルールは本文の書き方だけにする
update ai_instructions set body = E'・予約内容（部屋番号、滞在日、人数、プラン）と滞在中の依頼履歴を参照する\n・お客様メモのうち「記念日」「お好み」の項目は、案内を個別に合わせるために使ってよい\n・お客様メモにある内容を、お客様本人に「記録されています」と伝えない\n・スタッフに引き継いだ案件は、お客様メモに「ご要望の要約／AIが案内した内容／引き継ぎ先」を1行で追記する\n・次回以降のご滞在でも役立つ情報（記念日、枕や室温のお好みなど）は、お客様メモに追記する\n・クレームは事実と経過のみを書き、スタッフ個人を評価する表現は使わない'
where scope = 'integration' and integration_id = '00000000-0000-0000-0000-000000009001';

delete from ai_instructions where scope in ('pattern', 'integration_read', 'integration_write');

drop index ai_instructions_scope_key;
alter table ai_instructions drop column pattern;
alter table ai_instructions add constraint ai_instructions_scope_check check (scope in ('common', 'integration'));
create unique index ai_instructions_scope_key
  on ai_instructions (hotel_id, scope, coalesce(integration_id, '00000000-0000-0000-0000-000000000000'));

-- ---------- 回答後のチェック項目（指示・利用ルールから上位モデルで抜き出す） ----------

create table reply_checks (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  -- instruction: ゲスト対応AIの指示 ／ integration: 連携先の利用ルール
  source_type text not null check (source_type in ('instruction', 'integration')),
  integration_id uuid references integrations (id) on delete cascade,
  body text not null,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
alter table reply_checks enable row level security;
create index on reply_checks (hotel_id, source_type);

-- いまの確定前の確認は、抜き出しの結果として入れておく（次に指示を保存したときに抜き出し直す）
insert into reply_checks (hotel_id, source_type, body, sort)
select hotel_id, 'instruction', body || 'を、お客様の確認なしに確定したと伝えない', sort
from guardrails where enabled and kind = 'confirm_before';

-- ガードレールの画面設定は廃止（必ず人に引き継ぐ条件は常に判定する）
drop table guardrails;
update config_revisions set kind = 'ai_instructions' where kind = 'guardrails';
alter table config_revisions drop constraint config_revisions_kind_check;
alter table config_revisions add constraint config_revisions_kind_check check (kind in ('ai_assignments', 'ai_instructions', 'integrations'));

-- ---------- 外部連携: ツールごとの権限 ----------

-- slug はツールの権限キー（integration.<slug>.<ツール名>）に使う。接続先とトークンは環境変数の名前で持つ（秘密をDBに置かない）
alter table integrations add column slug text;
alter table integrations add column endpoint_env text;
alter table integrations add column token_env text;
update integrations set slug = 'pms', endpoint_env = 'PMS_MCP_URL', token_env = 'PMS_MCP_TOKEN' where id = '00000000-0000-0000-0000-000000009001';
update integrations set slug = 'web' where kind = 'web_fetch';
update integrations set slug = 'mcp' || left(replace(id::text, '-', ''), 8) where slug is null;
alter table integrations alter column slug set not null;
create unique index integrations_slug_key on integrations (hotel_id, slug);

-- MCPから取得したツール。AIに使わせるかは権限（permission_key をAIエージェントに付けるか）で決める
create table integration_tools (
  integration_id uuid not null references integrations (id) on delete cascade,
  name text not null,
  description text not null default '',
  -- 入力スキーマ（MCPのJSON Schema）。予約番号などの引数をサーバーの値で固定するのに使う（未取得なら連携係に渡す前に取り直す）
  input_schema jsonb,
  -- read: 読み取り ／ write: 書き込み（MCPの readOnlyHint から初期値を決める）
  access text not null default 'write' check (access in ('read', 'write')),
  -- システムが決まった場面で呼ぶツール。reservation: ゲストの予約の取得（変換層）／search: 予約の検索（スタッフのAI相談）／
  -- preload: ゲストの情報として会話のたびに読む。null は連携係が選んで使う
  role text check (role in ('reservation', 'search', 'preload')),
  require_staff_confirm boolean not null default false,
  permission_key text not null references permissions (key),
  synced_at timestamptz not null default now(),
  primary key (integration_id, name)
);
alter table integration_tools enable row level security;

insert into permissions (key, category, label, scope_kind) values
  ('integration.pms.get_reservation', 'integration', '予約・客室管理システム: 予約内容の取得', null),
  ('integration.pms.search_reservations', 'integration', '予約・客室管理システム: 予約の検索', null),
  ('integration.pms.list_guest_notes', 'integration', '予約・客室管理システム: お客様メモの一覧', null),
  ('integration.pms.list_request_history', 'integration', '予約・客室管理システム: 滞在中の依頼履歴', null),
  ('integration.pms.append_guest_note', 'integration', '予約・客室管理システム: お客様メモに追記', null),
  ('integration.pms.append_request_history', 'integration', '予約・客室管理システム: 依頼履歴に追記', null);

insert into integration_tools (integration_id, name, description, access, role, require_staff_confirm, permission_key)
select i.id, t.name, t.description, t.access, t.role, t.confirm, 'integration.pms.' || t.name
from integrations i, (values
  ('get_reservation', '予約内容（客室ID・部屋番号・滞在日・人数・プラン・料金）を取得する', 'read', 'reservation', false),
  ('search_reservations', '期間に滞在がかかる予約を探す。query を渡すと、お名前（空白は無視）か部屋番号で絞る', 'read', 'search', false),
  ('list_guest_notes', 'お客様メモ（記念日・お好み・引き継ぎなど）の一覧', 'read', 'preload', false),
  ('list_request_history', '滞在中の依頼履歴', 'read', 'preload', false),
  ('append_guest_note', 'お客様メモに追記する（既存の記載は変更できない）', 'write', null, false),
  ('append_request_history', '依頼履歴に追記する', 'write', null, false)
) as t (name, description, access, role, confirm)
where i.slug = 'pms';

-- AIエージェントの権限をツールごとに付け替える（旧: 読み取り・追記の2つ）
insert into member_permissions (member_id, permission_key)
select m.id, k.key
from members m
join effective_permissions e on e.member_id = m.id and e.permission_key = 'integration.pms.read'
cross join (values ('integration.pms.get_reservation'), ('integration.pms.search_reservations'), ('integration.pms.list_guest_notes'), ('integration.pms.list_request_history')) k (key)
where m.kind = 'ai_agent';
insert into member_permissions (member_id, permission_key)
select m.id, k.key
from members m
join effective_permissions e on e.member_id = m.id and e.permission_key = 'integration.pms.append'
cross join (values ('integration.pms.append_guest_note'), ('integration.pms.append_request_history')) k (key)
where m.kind = 'ai_agent';

update audit_logs set permission_key = null where permission_key in ('integration.pms.read', 'integration.pms.append');
delete from group_permissions where permission_key in ('integration.pms.read', 'integration.pms.append');
delete from member_permissions where permission_key in ('integration.pms.read', 'integration.pms.append');
delete from permissions where key in ('integration.pms.read', 'integration.pms.append');

-- 項目ごとの読み書き権限はツールごとの権限に置き換えた
drop table integration_field_rules;

-- 書き込みは連携係が選んだツールと引数で送る。保留は送信の失敗だけ（形式のチェックは廃止）
alter table integration_writes add column tool_name text;
alter table integration_writes add column args jsonb;
alter table integration_writes alter column field drop not null;
update integration_writes set tool_name = case field when 'guest_notes' then 'append_guest_note' when 'request_history' then 'append_request_history' end
where tool_name is null;

-- ---------- 人の権限 ----------

update permissions set label = 'ゲスト対応AIの指示' where key = 'settings.ai_policy';
update permissions set label = '外部連携の接続（連携先・AIに使わせるツール）' where key = 'settings.integrations';
update permissions set label = 'Webページの取得' where key = 'integration.web_fetch.read';
insert into permissions (key, category, label, scope_kind) values
  ('settings.integration_rules', 'settings', '連携の利用ルール', null),
  ('handling.integration_write.confirm', 'handling', '連携先への書き込みを確認', null);

insert into group_permissions (group_id, permission_key)
select g.id, k.key
from permission_groups g
cross join (values ('settings.ai_policy'), ('settings.integration_rules'), ('handling.integration_write.confirm')) k (key)
where g.is_preset and g.name in ('上長', '管理者')
on conflict do nothing;
