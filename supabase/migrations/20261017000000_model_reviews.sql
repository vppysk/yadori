-- モデルの見直し（docs/000_plan.md 4.3、2026-09-29 改訂）: 業務×時間帯の担当をやめ、仕事ごとのモデルを定期評価 → 提案レポート → 承認（全部適用か試験運用）で見直す

-- 仕事ごとのモデル。見直しの対象は、ゲストへの回答（業務ごと。クレームはUltra固定でここには持たない）とAI相談。pattern はAI相談では ''
create table ai_models (
  hotel_id uuid not null references hotels (id) on delete cascade,
  job text not null check (job in ('answer', 'staff_ask')),
  pattern text not null default '' check (pattern in ('', 'info', 'order', 'external', 'reservation')),
  tier text not null check (tier in ('small', 'medium', 'large')),
  primary key (hotel_id, job, pattern),
  check ((job = 'answer') = (pattern <> ''))
);
alter table ai_models enable row level security;

insert into ai_models (hotel_id, job, pattern, tier)
select h.id, j.job, j.pattern, 'medium'
from hotels h cross join (values ('answer', 'info'), ('answer', 'order'), ('answer', 'external'), ('answer', 'reservation'), ('staff_ask', '')) j (job, pattern);

-- 人が直接受ける設定・時間帯ごとの担当は廃止（人とAIの分担はルールと連携の権限で決める）
drop table ai_assignments;
drop table ai_job_models;

-- 提案レポート（定期評価が作る）。detail に根拠の実測と期待する効果を持つ
create table model_reports (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  job text not null check (job in ('answer', 'staff_ask')),
  pattern text not null default '',
  kind text not null check (kind in ('switch', 'trial')),
  from_tier text not null check (from_tier in ('small', 'medium', 'large')),
  to_tier text not null check (to_tier in ('small', 'medium', 'large')),
  reason text not null,
  detail jsonb not null,
  status text not null default 'open' check (status in ('open', 'applied', 'trialing', 'dismissed', 'withdrawn')),
  decided_by uuid references members (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table model_reports enable row level security;
create index on model_reports (hotel_id, status, created_at desc);

-- 試験運用: 仕事ごとに一部（share）を別のモデルで処理する。目標を外れたら自動で中断する（stop_reason）
drop table model_trials;
create table model_trials (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  job text not null check (job in ('answer', 'staff_ask')),
  pattern text not null default '',
  report_id uuid references model_reports (id) on delete set null,
  from_tier text not null check (from_tier in ('small', 'medium', 'large')),
  tier text not null check (tier in ('small', 'medium', 'large')),
  share numeric(3, 2) not null check (share > 0 and share <= 0.5),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  stopped_at timestamptz,
  stop_reason text,
  created_by uuid references members (id),
  demo boolean not null default false,
  created_at timestamptz not null default now()
);
alter table model_trials enable row level security;
create index on model_trials (hotel_id, job, pattern);

update permissions set label = 'AIのモデルの見直し（承認・試験運用・満足度の目標）' where key = 'settings.ai_assignment';
