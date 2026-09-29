-- 外部連携のツールの整理（docs/007_ai_settings.md）
-- ・ツールの種類（読み取り／書き込み）は廃止。MCPは読み書きとも同じエンドポイントへの tools/call で、種類は相手の自己申告（readOnlyHint）しかないため。
--   ツールごとに「AIに使わせるか」「スタッフの確認後に送るか」だけを選び、呼び出しはすべて監査ログに残す
-- ・AIに使わせるかは、AIエージェントへの権限ではなく integration_tools.ai_enabled で持つ（設定場所を外部連携の画面1つにする）。
--   メンバーと権限の画面からAIエージェントを外し、プリセットのグループ「AIエージェント」は削除する（確認していない権限しかなかった）

alter table integration_tools add column ai_enabled boolean not null default false;
update integration_tools t set ai_enabled = true
where exists (select 1 from members m where m.kind = 'ai_agent' and m.active and has_permission(m.id, t.permission_key));
alter table integration_tools drop column access;

delete from member_permissions p using members m where m.id = p.member_id and m.kind = 'ai_agent';
delete from permission_groups where is_preset and name = 'AIエージェント';

-- 確認待ちの呼び出し（スタッフの確認後に送るツール）だけを積む
comment on table integration_writes is 'スタッフの確認後に送る連携先のツールの呼び出し。呼び出しそのものは audit_logs（action = integration.tool_call）に残す';
