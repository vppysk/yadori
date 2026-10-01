-- モデルの最適化（docs/000_plan.md 4.3、2026-09-29 再改訂）: 経営側は満足度の目標だけを決め、システムが提案し、人が承認する

-- 満足度の目標（上限）。答えられなかった率と、AIの応対が原因の「人と話したい」率
alter table hotels add column target_unanswered_rate_max numeric(4, 3) not null default 0.05 check (target_unanswered_rate_max > 0 and target_unanswered_rate_max <= 1);
alter table hotels add column target_ai_talk_rate_max numeric(4, 3) not null default 0.01 check (target_ai_talk_rate_max > 0 and target_ai_talk_rate_max <= 1);

-- 「人と話したい」の理由の分類（会話ログの定期評価で行う）。直前のAIの回答のモデル・業務・時間帯を持ち、モデルごとの品質の比較に使う。
-- demo はダッシュボード用のデモ（引き継ぎを持たない）
create table talk_request_reviews (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid unique references handoffs (id) on delete cascade,
  hotel_id uuid not null references hotels (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  cause text not null check (cause in ('no_info', 'wrong_answer', 'misunderstood', 'tone', 'not_possible', 'initial', 'emotion', 'other')),
  reason text,
  model_id text,
  pattern text check (pattern in ('info', 'order', 'external', 'reservation', 'complaint')),
  time_band_id uuid references time_bands (id) on delete set null,
  requested_at timestamptz not null,
  reviewed_at timestamptz not null default now(),
  demo boolean not null default false
);
alter table talk_request_reviews enable row level security;
create index on talk_request_reviews (hotel_id, requested_at);
