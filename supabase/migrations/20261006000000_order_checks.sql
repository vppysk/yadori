-- オーダーの状況確認と催促（docs/005_order.md 6章）。期限切れ・ゲストの催促・上長の依頼で担当者に状況を確認し、
-- 担当者は定型の返事（向かっています／対応できない）と任意の一言で答える。オーダー遅延の引き継ぎ（overdue_order）は作らない

alter table tickets
  -- manual: 上長が手動で割り当てた（未着手のままでも自動の再割り当てをしない）
  add column assignment_mode text not null default 'auto' check (assignment_mode in ('auto', 'manual')),
  -- 今の状況確認。返事が来るまで check_replied_at は空
  add column check_requested_at timestamptz,
  add column check_source text check (check_source in ('overdue', 'guest', 'supervisor')),
  add column check_requested_by uuid references members (id),
  add column check_message text, -- 上長の一言
  add column check_replied_at timestamptz,
  add column check_reply text check (check_reply in ('on_the_way', 'cannot')),
  add column check_eta_at timestamptz, -- 「向かっています」の到着の目安
  add column check_reply_note text, -- 担当者の一言（ゲストには見せない）
  -- ゲストの「状況を確認する」
  add column guest_nudges integer not null default 0,
  add column last_nudged_at timestamptz;

alter table ticket_events drop constraint ticket_events_type_check;
alter table ticket_events add constraint ticket_events_type_check check (type in (
  'created', 'assigned', 'reassigned', 'declined', 'started', 'done',
  'cancelled', 'escalated', 'guest_notified',
  'check_requested', 'check_replied', 'guest_nudged'
));
