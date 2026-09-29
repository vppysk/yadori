-- 実績の出力口の接続元（docs/007_ai_settings.md）。外部システムのメンバーは、当システムに接続してくる側（実績の出力口のMCP）の実体。
-- 接続元ごとにトークンの環境変数名を持ち、送られてきたトークンで接続元を特定して、その接続元の権限を確認する。
-- 設定は外部連携の「実績の出力口」で行い、メンバーと権限の画面には出さない。権限はグループではなく個別付与で持つ

alter table members add column token_env text;

-- いまグループで持っている権限を個別付与にしてから、プリセットのグループ「外部連携（読み取り）」を削除する
insert into member_permissions (member_id, permission_key)
select distinct m.id, gp.permission_key
from members m
join member_groups mg on mg.member_id = m.id
join group_permissions gp on gp.group_id = mg.group_id
where m.kind = 'external_system';
delete from permission_groups where is_preset and name = '外部連携（読み取り）';

-- デモの接続元は、出ていく側の連携先（予約・客室管理システム）とは別物なので名前と紐づけを直す
update integrations set member_id = null where member_id in (select id from members where kind = 'external_system');
update members set display_name = '既存の管理システム（実績の読み取り）', token_env = 'EXPORT_MCP_TOKEN'
where id = '00000000-0000-0000-0000-00000000a0e1';
update permissions set label = '実績・オーダー状況の読み取り（実績の出力口のMCP）' where key = 'integration.work_events.read';
