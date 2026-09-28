-- 現場スマホの見直し
-- 1. 対応アラート（引き継ぎ）は管理PCだけで受ける。現場スマホに送っていた通知は消す
-- 2. AIに相談を複数の会話（セッション）に分ける。題名は最初の質問から付け、削除は archived_at で隠す（計測の記録は残す）
-- 3. AIに相談で特定のゲストに言及できる。予約・客室管理システムと対応アラートから、そのゲストの情報を取って答える

delete from notifications where kind = 'handoff';

alter table conversations add column title text;
alter table conversations add column archived_at timestamptz;
create index on conversations (staff_member_id, started_at desc) where channel = 'staff_ask';

-- これまでの相談（1人1会話）には最初の質問から題名を付ける
update conversations c set title = left(regexp_replace(m.content, '\s+', ' ', 'g'), 40)
from (select distinct on (conversation_id) conversation_id, content from messages where role = 'user' order by conversation_id, created_at) m
where m.conversation_id = c.id and c.channel = 'staff_ask' and c.title is null;

-- 質問で参照したゲスト（予約番号と表示名の配列）。続けての質問（「その方の…」）で引き継ぐのにも使う
alter table messages add column mentions jsonb;

insert into permissions (key, category, label, scope_kind) values
  ('handling.consult.guest', 'handling', 'AIに相談でゲストの情報を参照', null);

-- 「AIに相談」を持つグループに付ける。シードの前に実行されるときは何もしない
insert into group_permissions (group_id, permission_key)
select group_id, 'handling.consult.guest' from group_permissions where permission_key = 'handling.consult'
on conflict do nothing;
