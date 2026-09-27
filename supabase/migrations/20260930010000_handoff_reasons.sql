-- 引き継ぎの種類をきっかけごとに分け、システムの不具合の原因と、引き継いだ時点のメッセージを残す
alter table handoffs drop constraint handoffs_kind_check;
alter table handoffs add constraint handoffs_kind_check check (kind in (
  'talk_request',      -- ゲスト自身が求めた（ボタン・「スタッフと話したい」）
  'complaint',         -- クレーム・強い不満
  'safety',            -- 急病・けが・火事など
  'overdue_order',     -- オーダーの期限切れ（管理PCではオーダーボードだけに出す）
  'unanswerable',      -- 同じ会話で2回答えられなかった
  'staff_assigned',    -- 業務の担当が「人」に設定されている
  'guardrail_blocked', -- 回答が禁止事項に反したため止めた
  'system_error'       -- 回答の生成や禁止事項のチェックが失敗した
));

-- システムの不具合の中身（failure_stage: answer=回答の生成 / guardrail=禁止事項のチェック）
alter table handoffs add column failure_stage text check (failure_stage in ('answer', 'guardrail'));
alter table handoffs add column failure_cause text check (failure_cause in ('timeout', 'api_error', 'invalid_output', 'unknown'));
alter table handoffs add column failure_detail text;
alter table handoffs add column model_id text;

-- 引き継いだ時点のメッセージ（管理PCの会話パネルでここまでスクロールする）
alter table handoffs add column message_id uuid references messages (id) on delete set null;

-- 既存の行を新しい種類へ移す。禁止事項は要約の書き出しで見分け、判定できなかったものは不具合とする。
-- 担当が「人」は確実には見分けられないため、ゲストの依頼でない talk_request をまとめて寄せる
update handoffs set kind = 'system_error', failure_stage = 'guardrail', failure_cause = 'unknown'
  where kind = 'talk_request' and summary like 'AIの回答が決まり「判定できなかった」%';
update handoffs set kind = 'guardrail_blocked'
  where kind = 'talk_request' and summary like 'AIの回答が決まり%';
update handoffs set kind = 'system_error', failure_stage = 'answer', failure_cause = 'unknown'
  where kind = 'unanswerable' and summary like 'AIが回答を作れなかった質問%';
update handoffs set kind = 'staff_assigned'
  where kind = 'talk_request' and not guest_requested and summary <> 'ゲストが画面の「スタッフと話す」を押した';
