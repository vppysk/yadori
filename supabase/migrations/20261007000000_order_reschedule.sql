-- ご依頼のお届け時間の変更（docs/005_order.md 6章）。ゲストがチャットや「ご依頼の状況」から変えたときの履歴
alter table ticket_events drop constraint ticket_events_type_check;
alter table ticket_events add constraint ticket_events_type_check check (type in (
  'created', 'assigned', 'reassigned', 'declined', 'started', 'done',
  'cancelled', 'escalated', 'guest_notified',
  'check_requested', 'check_replied', 'guest_nudged', 'rescheduled'
));
