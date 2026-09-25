-- 初期スキーマ。設計の説明は docs/001_db_schema.md
-- 列挙値はenum型ではなく text + check にしている（ハッカソン中の変更を楽にするため）

create extension if not exists vector with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- ============================================================
-- ホテルと共通
-- ============================================================

create table hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Tokyo',
  -- 4.4 目標値（将来の自動最適化の制約）
  target_satisfaction_min numeric(4, 3),
  target_handoff_rate_max numeric(4, 3),
  -- AI単価はUSD、人件費は円のため換算レートを持つ
  fx_usd_jpy numeric(8, 3) not null default 150,
  infra_monthly_cost_jpy integer not null default 0,
  created_at timestamptz not null default now()
);

-- 問い合わせの5パターン（3章）。各テーブルの pattern 列はこの値を使う
-- info=案内, order=オーダー, external=外部連携, reservation=予約・客室, complaint=クレーム

-- 時間帯（4.3 時間帯別の担当範囲・4.4 時間帯別割増）
create table time_bands (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  starts_at time not null,
  ends_at time not null, -- starts_at > ends_at は日をまたぐ（例: 22:00〜7:00）
  wage_multiplier numeric(4, 2) not null default 1.0,
  sort integer not null default 0,
  unique (hotel_id, name)
);

-- ============================================================
-- メンバーと権限（4.8）: 人・AIエージェント・外部システムを同じメンバーとして扱う
-- ============================================================

create table members (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null check (kind in ('human', 'ai_agent', 'external_system')),
  display_name text not null,
  job_title text, -- 人件費の役職（wage_rates.job_title）
  auth_user_id uuid unique, -- Supabase Auth のユーザー（人のみ）
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 権限の一覧。MCPツール1つ＝権限1つ。scope_kind は範囲指定できる対象
create table permissions (
  key text primary key,
  category text not null check (category in ('order', 'knowledge', 'handling', 'settings', 'integration')),
  label text not null,
  scope_kind text check (scope_kind in ('facility', 'slot'))
);

create table permission_groups (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  is_preset boolean not null default false,
  unique (hotel_id, name)
);

-- scope_ids が null なら範囲の限定なし（全体）
create table group_permissions (
  group_id uuid not null references permission_groups (id) on delete cascade,
  permission_key text not null references permissions (key),
  scope_ids uuid[],
  primary key (group_id, permission_key)
);

create table member_groups (
  member_id uuid not null references members (id) on delete cascade,
  group_id uuid not null references permission_groups (id) on delete cascade,
  primary key (member_id, group_id)
);

-- 個別付与。expires_at を過ぎると無効（期限付きの応援）
create table member_permissions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  permission_key text not null references permissions (key),
  scope_ids uuid[],
  expires_at timestamptz,
  granted_by uuid references members (id),
  granted_at timestamptz not null default now()
);

-- 実効権限 = グループ由来と有効な個別付与の合計（拒否はなし）
create view effective_permissions with (security_invoker = true) as
select mg.member_id, gp.permission_key, gp.scope_ids, null::timestamptz as expires_at, 'group' as source
from member_groups mg
join group_permissions gp on gp.group_id = mg.group_id
union all
select mp.member_id, mp.permission_key, mp.scope_ids, mp.expires_at, 'direct' as source
from member_permissions mp
where mp.expires_at is null or mp.expires_at > now();

-- どれか1つでも許可していれば許可。範囲は広い方（null=全体）が有効
create function has_permission(p_member_id uuid, p_permission_key text, p_target_id uuid default null)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from effective_permissions ep
    join members m on m.id = ep.member_id and m.active
    where ep.member_id = p_member_id
      and ep.permission_key = p_permission_key
      and (ep.scope_ids is null or p_target_id is null or p_target_id = any (ep.scope_ids))
  );
$$;

revoke execute on function has_permission from public, anon, authenticated;

-- 権限の一覧（固定の参照データ）。AIエージェント用の権限もMCPツールと1対1で持つ
insert into permissions (key, category, label, scope_kind) values
  ('order.create', 'order', 'オーダーを登録する', null),
  ('order.assignable', 'order', '担当になれる', 'slot'),
  ('order.board.view', 'order', 'ボードを見る', null),
  ('order.reassign', 'order', '付け替える', 'slot'),
  ('knowledge.facility.edit', 'knowledge', '施設・営業情報を編集', 'facility'),
  ('knowledge.notice.edit', 'knowledge', '特記事項を編集', 'facility'),
  ('knowledge.document.register', 'knowledge', '館内案内・マニュアルを登録', null),
  ('knowledge.question.answer', 'knowledge', '未回答の質問に回答', null),
  ('handling.consult', 'handling', 'AIに相談', null),
  ('handling.handoff.accept', 'handling', '引き継ぎに対応', null),
  ('handling.handoff.create', 'handling', '引き継ぎを作成', null),
  ('handling.complaint.view', 'handling', 'クレーム履歴を見る', null),
  ('settings.items', 'settings', '品目・担当設定', null),
  ('settings.ai_assignment', 'settings', 'AIの担当範囲とコスト', null),
  ('settings.ai_policy', 'settings', '指示とガードレール', null),
  ('settings.integrations', 'settings', '外部連携', null),
  ('settings.masters', 'settings', '人件費などのマスタ', null),
  ('settings.members', 'settings', 'メンバーと権限の管理', null),
  ('integration.pms.read', 'integration', '予約・客室管理システムの読み取り', null),
  ('integration.pms.append', 'integration', '予約・客室管理システムへの追記', null),
  ('integration.work_events.read', 'integration', '実績・オーダー状況の読み取り', null);

-- 誰が（人・AI・外部システム）、どの権限で、何をしたか
create table audit_logs (
  id bigint generated always as identity primary key,
  hotel_id uuid not null references hotels (id) on delete cascade,
  member_id uuid references members (id),
  permission_key text references permissions (key),
  action text not null,
  target_type text,
  target_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index on audit_logs (hotel_id, created_at desc);

-- ============================================================
-- 期間付き知識（4.1）: 期間で変わる情報はマスタ、変わらない説明文はRAG
-- ============================================================

-- kind='global' はマスタの「全体」欄（施設に紐づかない特記事項の置き場）。ホテルに1件
create table facilities (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null default 'facility' check (kind in ('facility', 'global')),
  name text not null,
  sort integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references members (id)
);
create unique index facilities_one_global on facilities (hotel_id) where kind = 'global';

-- PDF・画像から読み込んだ元ファイル。下書きの出どころを残す
create table source_files (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  file_name text not null,
  storage_path text not null, -- Supabase Storage
  mime_type text not null,
  uploaded_by uuid references members (id),
  created_at timestamptz not null default now()
);

-- 営業時間。valid は滞在日（ホテル現地の日付）の範囲 [from, to]。
-- 期間の重なりは禁止せず警告するため、除外制約は付けない（facility_period_overlaps で検出）
create table facility_hours (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities (id) on delete cascade,
  label text not null, -- ランチ／ディナーなど
  opens_at time,
  closes_at time,
  closed boolean not null default false, -- 期間中は休業
  days_of_week smallint[], -- 0=日〜6=土。null は毎日
  valid daterange not null,
  note text,
  status text not null default 'published' check (status in ('draft', 'published')),
  source_file_id uuid references source_files (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references members (id)
);
create index on facility_hours using gist (facility_id, valid);

-- メニュー・プラン
create table facility_offerings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities (id) on delete cascade,
  name text not null,
  description text,
  price_jpy integer,
  price_note text,
  valid daterange not null,
  status text not null default 'published' check (status in ('draft', 'published')),
  source_file_id uuid references source_files (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references members (id)
);
create index on facility_offerings using gist (facility_id, valid);

-- 特記事項。有効期間中はその施設の通常の営業情報より優先。期限が過ぎたものは案内に使わない
create table special_notices (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities (id) on delete cascade,
  body text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_by uuid references members (id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on special_notices (facility_id, ends_at);

-- 同じ施設・同じ名前（ラベル）で期間が重なる行。管理PCの警告と「情報の点検」に使う
create view facility_period_overlaps with (security_invoker = true) as
select 'hours' as kind, a.facility_id, a.id as a_id, b.id as b_id, a.label as name
from facility_hours a
join facility_hours b
  on a.facility_id = b.facility_id and a.id < b.id and a.label = b.label and a.valid && b.valid
union all
select 'offerings', a.facility_id, a.id, b.id, a.name
from facility_offerings a
join facility_offerings b
  on a.facility_id = b.facility_id and a.id < b.id and a.valid && b.valid;

-- RAG（日付で変わらない説明文）。登録時の確認はしない
create table documents (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  title text not null,
  source text not null check (source in ('upload', 'answered_question')),
  source_file_id uuid references source_files (id) on delete set null,
  created_by uuid references members (id),
  created_at timestamptz not null default now()
);

-- 埋め込みは Qwen3-Embedding-8B を dimensions=1536 で取得（HNSWの上限2000次元に収めるため）
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(1536),
  embedding_model text not null,
  unique (document_id, chunk_index)
);
create index on document_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- ゲストの未回答質問。同じ質問は count を増やす。回答すると documents に蓄積
create table unanswered_questions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  question text not null,
  ask_count integer not null default 1,
  last_asked_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer text,
  answered_by uuid references members (id),
  answered_at timestamptz,
  document_id uuid references documents (id) on delete set null
);
create index on unanswered_questions (hotel_id, status, ask_count desc);

-- ============================================================
-- 会話と計測（4.3, 4.5）
-- ============================================================

-- ゲスト文脈（予約情報）は予約・客室管理システムからMCPで取得する。ここには会話時点の写しだけ持つ
create table conversations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  channel text not null check (channel in ('guest', 'staff_ask')),
  external_reservation_id text,
  room_number text,
  stay_start date,
  stay_end date,
  staff_member_id uuid references members (id), -- staff_ask のとき
  started_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'staff', 'system')),
  content text not null,
  -- 回答の根拠（施設・特記事項・文書チャンクのID）。スタッフのAI相談で表示
  citations jsonb,
  feedback smallint check (feedback in (-1, 1)), -- 👍👎
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);

-- LLM呼び出し1回ごとの記録。コスト計算と、精密見積もり（過去ログの再生）の元データ
create table llm_calls (
  id bigint generated always as identity primary key,
  hotel_id uuid not null references hotels (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  message_id uuid references messages (id) on delete set null,
  purpose text not null, -- router / extract / answer / summarize / guardrail など
  pattern text check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  model_id text not null,
  thinking boolean not null default false,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  duration_ms integer not null default 0,
  cost_usd numeric(12, 8),
  request jsonb, -- 再生用（システムプロンプト・メッセージ・ツール定義）
  created_at timestamptz not null default now()
);
create index on llm_calls (hotel_id, created_at);

-- 実績イベント（4.5）: 業務1件ごとの結果。CSV/JSON・Webhook・MCPで出力する外部との契約
create table work_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  ticket_id uuid, -- tickets への参照（下で外部キーを追加）
  pattern text not null check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  time_band_id uuid references time_bands (id),
  handler_kind text not null check (handler_kind in ('ai', 'human')),
  handler text not null, -- AIはモデルID、人は役職
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  duration_ms integer not null default 0,
  cost_jpy numeric(12, 3) not null default 0,
  outcome text not null check (outcome in ('resolved', 'handed_off', 'escalated_complaint', 'unanswered')),
  -- 満足度の代理指標（聞き直し、「人と話したい」、期限内対応、感情スコアなど）
  signals jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index on work_events (hotel_id, occurred_at);
create index on work_events (hotel_id, pattern, time_band_id);

-- ============================================================
-- オーダーチケット（4.2）
-- ============================================================

create table job_roles (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null, -- ハウスキーピング／ルームサービスなど
  unique (hotel_id, name)
);

-- 担当エリア（フロアの範囲）
create table areas (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  floor_from integer not null,
  floor_to integer not null,
  check (floor_from <= floor_to)
);

create table rooms (
  hotel_id uuid not null references hotels (id) on delete cascade,
  room_number text not null,
  floor integer not null,
  primary key (hotel_id, room_number)
);

-- 枠 = 役割 × エリア。area_id が null の枠は全館担当（例: ルームサービス）
create table slots (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  job_role_id uuid not null references job_roles (id) on delete cascade,
  area_id uuid references areas (id) on delete cascade,
  unique nulls not distinct (job_role_id, area_id)
);

-- 品目。weight: 1=軽 2=中 3=重
create table order_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}', -- LLMの読み取り補助（バスタオル→タオル類など）
  job_role_id uuid not null references job_roles (id),
  weight smallint not null check (weight between 1 and 3),
  due_minutes integer not null,
  active boolean not null default true,
  sort integer not null default 0,
  unique (hotel_id, name)
);

-- その日の枠と担当者（出勤時にスマホで選ぶ）
create table slot_shifts (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  work_date date not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (slot_id, member_id, work_date)
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  room_number text not null,
  source text not null check (source in ('ai_chat', 'phone', 'front_desk', 'other')),
  raw_text text, -- 受付時の原文（電話・来訪はフロントが入力）
  conversation_id uuid references conversations (id) on delete set null,
  slot_id uuid references slots (id),
  assignee_id uuid references members (id),
  weight smallint not null check (weight between 1 and 3), -- 含まれる品目の最大段階
  status text not null default 'new' check (status in ('new', 'doing', 'done', 'cancelled')),
  due_at timestamptz not null,
  assigned_at timestamptz,
  started_at timestamptz,
  done_at timestamptz,
  escalated_at timestamptz, -- 期限切れでクレーム予兆に昇格した時刻
  created_by uuid references members (id),
  created_at timestamptz not null default now()
);
create index on tickets (hotel_id, status, due_at);
create index on tickets (assignee_id, status);

create table ticket_lines (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets (id) on delete cascade,
  order_item_id uuid references order_items (id),
  item_name text not null, -- ゲストの言い方（バスタオルなど）。品目マスタとは order_item_id でつなぐ
  quantity integer not null check (quantity > 0),
  note text -- 「低め」「設置まで」など
);

-- 割り当て・再割り当て・対応できない・着手・完了・昇格の履歴。偏りの説明と実測時間の元データ
create table ticket_events (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references tickets (id) on delete cascade,
  type text not null check (type in (
    'created', 'assigned', 'reassigned', 'declined', 'started', 'done',
    'cancelled', 'escalated', 'guest_notified'
  )),
  member_id uuid references members (id), -- 対象の担当者
  actor_id uuid references members (id), -- 操作した人・AI（自動割り当てはAIエージェント）
  reason text,
  created_at timestamptz not null default now()
);
create index on ticket_events (ticket_id, created_at);

alter table work_events
  add constraint work_events_ticket_id_fkey foreign key (ticket_id) references tickets (id) on delete set null;

-- 担当者ごとの本日の担当量（累計pt＋未完了pt）。割り当ての均等化とスマホの表示に使う
create view member_daily_load with (security_invoker = true) as
select
  s.slot_id,
  s.member_id,
  s.work_date,
  coalesce(sum(t.weight) filter (where t.status = 'done'), 0) as done_points,
  coalesce(sum(t.weight) filter (where t.status in ('new', 'doing')), 0) as open_points,
  max(t.assigned_at) as last_assigned_at
from slot_shifts s
join slots sl on sl.id = s.slot_id
join hotels h on h.id = sl.hotel_id
left join tickets t
  on t.assignee_id = s.member_id
  and t.slot_id = s.slot_id
  and (t.assigned_at at time zone h.timezone)::date = s.work_date
where s.ended_at is null
group by s.slot_id, s.member_id, s.work_date;

-- ============================================================
-- 引き継ぎ・クレーム予兆・通知
-- ============================================================

create table handoffs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null check (kind in ('talk_request', 'complaint', 'overdue_order', 'unanswerable', 'safety')),
  conversation_id uuid references conversations (id) on delete set null,
  ticket_id uuid references tickets (id) on delete set null,
  room_number text,
  summary text not null, -- 会話・予約情報・AIが試したことの要約
  status text not null default 'open' check (status in ('open', 'accepted', 'closed')),
  accepted_by uuid references members (id),
  accepted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on handoffs (hotel_id, status, created_at desc);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  kind text not null, -- ticket_assigned / ticket_overdue / handoff など
  title text not null,
  body text,
  ref_type text,
  ref_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications (member_id, read_at, created_at desc);

-- ============================================================
-- AIの担当範囲・指示・ガードレール・外部連携（4.3, 4.7）
-- ============================================================

-- パターン × 時間帯ごとの担当。handler='human' は人に直接回す
create table ai_assignments (
  hotel_id uuid not null references hotels (id) on delete cascade,
  pattern text not null check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  time_band_id uuid not null references time_bands (id) on delete cascade,
  handler text not null check (handler in ('human', 'small', 'medium', 'large')),
  thinking boolean not null default false,
  handoff_threshold numeric(3, 2), -- 確信度がこれ未満なら人へ
  locked boolean not null default false, -- クレームは常に大型＋人で固定
  primary key (hotel_id, pattern, time_band_id)
);

-- 指示（自然文）。scope: common / pattern / integration_read / integration_write
create table ai_instructions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  scope text not null check (scope in ('common', 'pattern', 'integration_read', 'integration_write')),
  pattern text check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  integration_id uuid, -- integrations への参照（下で外部キーを追加）
  body text not null,
  updated_by uuid references members (id),
  updated_at timestamptz not null default now()
);
create unique index ai_instructions_scope_key
  on ai_instructions (hotel_id, scope, coalesce(pattern, ''), coalesce(integration_id, '00000000-0000-0000-0000-000000000000'));

-- ガードレール（指示より優先、応答の前後で自動チェック）
create table guardrails (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null check (kind in ('forbidden', 'handoff_condition', 'confirm_before')),
  body text not null,
  enabled boolean not null default true,
  sort integer not null default 0
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('mcp', 'web_search')),
  endpoint text,
  member_id uuid references members (id), -- MCPで接続する外部システムとしてのメンバー
  active boolean not null default true
);

alter table ai_instructions
  add constraint ai_instructions_integration_id_fkey foreign key (integration_id) references integrations (id) on delete cascade;

-- 項目ごとの読み書き権限（プロンプトでは越えられない固定の制限）
create table integration_field_rules (
  integration_id uuid not null references integrations (id) on delete cascade,
  field text not null, -- reservation / request_history / guest_notes / billing など
  can_read boolean not null default false,
  write_mode text not null default 'none' check (write_mode in ('none', 'append', 'write')),
  require_staff_confirm boolean not null default false,
  primary key (integration_id, field)
);

-- 外部システムへの書き込み。クレーム関連は確認待ち、形式不一致は保留
create table integration_writes (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations (id) on delete cascade,
  field text not null,
  external_reservation_id text,
  room_number text,
  content text not null,
  status text not null default 'pending_confirm' check (status in ('pending_confirm', 'held', 'written', 'rejected')),
  hold_reason text,
  handoff_id uuid references handoffs (id) on delete set null,
  created_by uuid references members (id),
  confirmed_by uuid references members (id),
  written_at timestamptz,
  created_at timestamptz not null default now()
);
create index on integration_writes (integration_id, created_at desc);

-- 設定の変更履歴（担当範囲・指示・ガードレール・外部連携）。変更前後の全体を保存し、元に戻せるようにする
create table config_revisions (
  id bigint generated always as identity primary key,
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null check (kind in ('ai_assignments', 'ai_instructions', 'guardrails', 'integrations')),
  snapshot jsonb not null,
  note text,
  created_by uuid references members (id),
  created_at timestamptz not null default now()
);

-- ============================================================
-- ホテル別マスタ（4.4）
-- ============================================================

create table wage_rates (
  hotel_id uuid not null references hotels (id) on delete cascade,
  job_title text not null,
  hourly_wage_jpy integer not null,
  primary key (hotel_id, job_title)
);

-- パターン別の想定対応時間。オーダーは受付と配達を分ける
create table handling_times (
  hotel_id uuid not null references hotels (id) on delete cascade,
  pattern text not null check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  phase text not null default 'all' check (phase in ('all', 'intake', 'delivery')),
  minutes numeric(6, 2) not null,
  primary key (hotel_id, pattern, phase)
);

-- モデル単価（USD / 100万トークン）。effective_from で改定履歴を持つ
create table model_prices (
  model_id text not null,
  effective_from date not null default current_date,
  input_usd_per_mtok numeric(10, 4) not null,
  output_usd_per_mtok numeric(10, 4) not null,
  primary key (model_id, effective_from)
);

-- 実績の出力口（Webhook）
create table webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{work_event.created}',
  active boolean not null default true
);

-- ============================================================
-- 予約・客室管理システムのモック（MCPサーバーの裏側）
-- 本来は既存システム側のデータ。自前テーブルと混ぜないよう別スキーマに置く
-- ============================================================

create schema mock_pms;

create table mock_pms.reservations (
  id text primary key,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  guest_name text not null,
  room_number text not null,
  check_in date not null,
  check_out date not null,
  adults integer not null default 1,
  plan_name text,
  total_amount_jpy integer -- 料金・支払い（AIは読み取りも不可）
);

create table mock_pms.guest_notes (
  id bigint generated always as identity primary key,
  reservation_id text not null references mock_pms.reservations (id) on delete cascade,
  category text not null, -- 記念日 / お好み / AI引継 など
  body text not null,
  written_by text not null,
  created_at timestamptz not null default now()
);

create table mock_pms.request_history (
  id bigint generated always as identity primary key,
  reservation_id text not null references mock_pms.reservations (id) on delete cascade,
  body text not null,
  written_by text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- アクセス制御: DBへはNext.jsのサーバー側（service role）からのみ接続する。
-- anon / authenticated からの直接アクセスはRLSで全て拒否（ポリシーを作らない）
-- ============================================================

do $$
declare
  t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('public', 'mock_pms') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end $$;
