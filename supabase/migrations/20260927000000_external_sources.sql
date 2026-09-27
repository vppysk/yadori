-- 外部の情報源（plan 4.1）: 管理者が登録したURL（運行情報・天気予報・イベントの公式サイトなど）を
-- Tavily Extract で定期的に取得し、AIが要約してゲストの案内とスタッフへの配信に使う。
-- 検索はしない。情報源の信頼性は登録する管理者が確認する

-- 外部連携の種類: 予約・客室管理システム（MCP）と、外部の情報源の取得（Tavily）
alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check check (kind in ('mcp', 'web_fetch'));

insert into permissions (key, category, label, scope_kind) values
  ('knowledge.source.edit', 'knowledge', '外部の情報源を登録', null),
  ('integration.web_fetch.read', 'integration', '外部の情報源の取得（Tavily）', null)
on conflict (key) do nothing;

create table external_sources (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  url text not null,
  -- このページで何を見るか（AIが要約・影響の判断に使う）。例: 千歳線の運休・遅延
  purpose text not null default '',
  -- 基本の取得間隔（分）。期間限定の頻度（external_source_boosts）があればそちらが優先
  interval_minutes integer not null default 60 check (interval_minutes between 10 and 1440),
  active boolean not null default true,
  -- 最後に取得を試みた時刻と、最後に取得できた時刻（古い情報をゲストに出さないために使う）
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_error text,
  created_by uuid references members (id),
  created_at timestamptz not null default now()
);
create index on external_sources (hotel_id);

-- 期間を限定して取得の頻度を上げる（台風の接近など）。期間が重なるときは短い間隔が有効
create table external_source_boosts (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references external_sources (id) on delete cascade,
  interval_minutes integer not null check (interval_minutes between 10 and 1440),
  during tstzrange not null check (not isempty(during)),
  reason text not null,
  created_by uuid references members (id),
  created_at timestamptz not null default now()
);
create index on external_source_boosts (source_id);

-- 取得の結果。本文が前回と同じなら要約しない（changed = false で記録だけ残す）
create table external_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references external_sources (id) on delete cascade,
  fetched_at timestamptz not null default now(),
  content_hash text not null,
  content text not null,
  changed boolean not null,
  -- AIの要約（ゲストへの案内・AI相談に使う）と、ホテルへの影響
  summary text,
  impact text check (impact in ('none', 'notice', 'alert')),
  staff_message text
);
create index on external_snapshots (source_id, fetched_at desc);

alter table external_sources enable row level security;
alter table external_source_boosts enable row level security;
alter table external_snapshots enable row level security;

-- 以下はデモホテルがある環境（シード適用済みのクラウド）だけに入る。
-- db reset ではマイグレーションがシードより先に走るため、同じ内容を seed.sql にも書いている
insert into group_permissions (group_id, permission_key)
select g.id, k.key from permission_groups g
join (values
  ('00000000-0000-0000-0000-00000000b003'::uuid, 'knowledge.source.edit'),
  ('00000000-0000-0000-0000-00000000b004'::uuid, 'knowledge.source.edit'),
  ('00000000-0000-0000-0000-00000000b005'::uuid, 'integration.web_fetch.read')
) k (group_id, key) on k.group_id = g.id
on conflict do nothing;

insert into integrations (id, hotel_id, name, kind)
select '00000000-0000-0000-0000-000000009002', id, '外部の情報源（Tavily）', 'web_fetch'
from hotels where id = '00000000-0000-0000-0000-000000000001'
on conflict (id) do nothing;

insert into integration_field_rules (integration_id, field, can_read, write_mode, require_staff_confirm)
select id, 'external_updates', true, 'none', false from integrations where id = '00000000-0000-0000-0000-000000009002'
on conflict do nothing;

insert into ai_instructions (hotel_id, scope, integration_id, body)
select hotel_id, 'integration_read', id,
  E'・運行情報・天気・イベントなど、ご案内に関係するときだけ使う\n・「○時○分時点の○○の情報では」のように、取得した時刻と情報源を添える\n・運休や荒天のときは、代わりの手段や時間に余裕を持つことを提案し、詳しくはフロントにおつなぎすると伝える'
from integrations where id = '00000000-0000-0000-0000-000000009002'
  and not exists (select 1 from ai_instructions where integration_id = '00000000-0000-0000-0000-000000009002');
