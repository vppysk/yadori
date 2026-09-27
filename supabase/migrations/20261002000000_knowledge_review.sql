-- ============================================================
-- 未回答の質問を、会話ログの定期評価で見つける方式に置き換える（docs/004_knowledge_gap_review.md）
-- 評価の記録 → 追記の提案（同じ意味の質問を1件にまとめる）→ 根拠の会話
-- ============================================================

-- 評価の記録。cursor は今回評価した最後のゲストの発言の時刻で、次回はこれより後を見る
create table knowledge_review_runs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cursor timestamptz,
  conversations integer not null default 0,
  questions integer not null default 0,
  new_gaps integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  error text
);
create index on knowledge_review_runs (hotel_id, started_at desc);

-- 追記の提案（AIが答えられなかった質問）。回答すると、期間のない内容はよくある質問（documents）、期間のある内容は資料（info_sources）になる
create table knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  question text not null,
  embedding extensions.vector(1536),
  embedding_model text,
  ask_count integer not null default 1,
  first_asked_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now(),
  draft_answer text,
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer text,
  answered_by uuid references members (id),
  answered_at timestamptz,
  document_id uuid references documents (id) on delete set null,
  source_id uuid references info_sources (id) on delete set null
);
create index on knowledge_gaps (hotel_id, status, ask_count desc);

-- 根拠: どの会話のどの発言で、なぜ答えられなかったと判定したか
create table knowledge_gap_evidences (
  id uuid primary key default gen_random_uuid(),
  gap_id uuid not null references knowledge_gaps (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete cascade,
  message_id uuid references messages (id) on delete set null,
  review_run_id uuid references knowledge_review_runs (id) on delete set null,
  reason text not null check (reason in ('ai_deferred', 'ai_guessed', 'guest_unsatisfied', 'staff_answered', 'handed_off', 'ai_failed')),
  question text not null,
  staff_answer text,
  asked_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on knowledge_gap_evidences (gap_id, asked_at desc);

alter table knowledge_review_runs enable row level security;
alter table knowledge_gaps enable row level security;
alter table knowledge_gap_evidences enable row level security;

-- 既存の未回答の質問は、根拠なしの提案として移す（回答済み・案内しないも履歴として残す）
insert into knowledge_gaps (hotel_id, question, ask_count, first_asked_at, last_asked_at, status, answer, answered_by, answered_at, document_id)
select hotel_id, question, ask_count, last_asked_at, last_asked_at, status, answer, answered_by, answered_at, document_id
from unanswered_questions;

drop table unanswered_questions;
