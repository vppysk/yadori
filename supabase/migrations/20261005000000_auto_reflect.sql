-- ============================================================
-- URLの資料に「自動反映」を足す（docs/006_guide_info.md 6章）。運行情報・天気など刻々と変わる情報は承認を待たずに案内に使う。
-- 自動反映は施設・項目・期間の値に読み取らず、取得のたびにAIが要約して取得時刻付きで回答に渡す（旧 外部の情報源と同じ方式）
-- ============================================================

alter table info_sources
  add column reflect_mode text not null default 'approval' check (reflect_mode in ('approval', 'auto')),
  -- 自動反映の最新の要約と、ホテルへの影響・スタッフへの配信文
  add column auto_summary text,
  add column auto_impact text check (auto_impact in ('none', 'notice', 'alert')),
  add column auto_staff_message text,
  add column auto_updated_at timestamptz,
  -- 自動反映で内容が変わり、管理PCでまだ誰も開いていない（サイドバー・資料のバッジ）
  add column unseen_update boolean not null default false;

alter table info_sources add constraint info_sources_auto_url check (reflect_mode = 'approval' or url is not null);
