-- スタッフのAI相談で使う連携先のツールは、AIエージェントと相談しているスタッフの両方に権限が要る（docs/007_ai_settings.md）。
-- いまゲストの情報を見られるグループ（handling.consult.guest）には、予約・客室管理システムの読み取りのツールを付けて動きを保つ
insert into group_permissions (group_id, permission_key)
select distinct gp.group_id, k.key
from group_permissions gp
cross join (values
  ('integration.pms.get_reservation'), ('integration.pms.search_reservations'),
  ('integration.pms.list_guest_notes'), ('integration.pms.list_request_history')
) k (key)
where gp.permission_key = 'handling.consult.guest'
  and exists (select 1 from permissions p where p.key = k.key)
on conflict do nothing;

-- 廃止した担当席（共有アカウント。20261008000000_order_duties で無効にした）を削除する。
-- 参照はグループの所属と個別付与だけ（どちらも on delete cascade）
delete from members
where kind = 'human' and not active and display_name like 'ハウスキーピング %';
