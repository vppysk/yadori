-- 経営ダッシュボードの作り直し（docs/000_plan.md 4.3、2026-09-29 改訂）
-- AIの仕事ごとのモデル、試験運用、前提の値（時給はホテル全体で1つ）

-- ゲストの回答以外で、モデルを選べるAIの仕事（回答は ai_assignments の業務×時間帯）
create table ai_job_models (
  hotel_id uuid not null references hotels (id) on delete cascade,
  job text not null check (job in ('staff_ask', 'source_extract', 'knowledge_review')),
  tier text not null check (tier in ('small', 'medium', 'large')),
  primary key (hotel_id, job)
);
alter table ai_job_models enable row level security;

insert into ai_job_models (hotel_id, job, tier)
select h.id, j.job, 'medium' from hotels h cross join (values ('staff_ask'), ('source_extract'), ('knowledge_review')) j (job);

-- 試験運用: 一部（share）を別のモデルで処理して実測を集める。回答は業務×時間帯ごと（pattern・time_band_id を指定）
create table model_trials (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  job text not null check (job in ('answer', 'staff_ask', 'source_extract', 'knowledge_review')),
  pattern text check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  time_band_id uuid references time_bands (id) on delete cascade,
  tier text not null check (tier in ('small', 'medium', 'large')),
  share numeric(3, 2) not null default 0.1 check (share > 0 and share <= 0.5),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  stopped_at timestamptz,
  created_by uuid references members (id),
  created_at timestamptz not null default now(),
  check ((job = 'answer') = (pattern is not null and time_band_id is not null))
);
alter table model_trials enable row level security;
create index on model_trials (hotel_id, job);

-- AI相談の「答えられなかった」を記録する（モデルごとの品質の比較に使う）。demo はダッシュボード用のデモ実績
alter table llm_calls add column unanswered boolean;
alter table llm_calls add column demo boolean not null default false;
create index on llm_calls (hotel_id, purpose, created_at);

-- 時給はホテル全体で1つ（役職別は廃止）。既存の役職別の平均を移す
alter table hotels add column hourly_wage_jpy integer check (hourly_wage_jpy > 0);
update hotels h set hourly_wage_jpy = w.avg from (select hotel_id, round(avg(hourly_wage_jpy))::int avg from wage_rates group by hotel_id) w where w.hotel_id = h.id;
drop table wage_rates;

-- 目標値とインフラ月額は使っていないため廃止（AIの費用は llm_calls の実費で見る）
alter table hotels drop column target_satisfaction_min;
alter table hotels drop column target_handoff_rate_max;
alter table hotels drop column infra_monthly_cost_jpy;

update permissions set label = 'AIの仕事の割り振りの前提の値（時給・対応時間）' where key = 'settings.masters';
update permissions set label = 'AIの仕事の割り振りと試験運用' where key = 'settings.ai_assignment';
