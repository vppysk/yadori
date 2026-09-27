-- ゲスト自身が求めた引き継ぎ（「スタッフと話す」ボタン・「スタッフと話したい」の発言）を区別し、ゲストの取り消しを記録する
alter table handoffs add column guest_requested boolean not null default false;

alter table handoffs drop constraint handoffs_status_check;
alter table handoffs add constraint handoffs_status_check check (status in ('open', 'accepted', 'closed', 'cancelled'));

-- 1つの会話で対応中のゲストの依頼は1件まで（連打・複数タブで重複させない）
create unique index handoffs_active_guest_request on handoffs (conversation_id)
  where guest_requested and status in ('open', 'accepted');
