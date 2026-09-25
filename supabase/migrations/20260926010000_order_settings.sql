-- オーダーの割り当て設定（品目・担当設定の画面で編集。plan 4.2）
alter table hotels
  add column order_reassign_minutes integer not null default 10 check (order_reassign_minutes between 1 and 120),
  add column order_bundle_enabled boolean not null default true,
  add column order_decline_reason_required boolean not null default true;
