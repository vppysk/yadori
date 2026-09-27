-- オーダーの改修（docs/005_order.md）: 品目の分類と取り扱いの状態、担当席、部屋のID、備考と希望日時、ゲストの選択待ち

-- ---------- 品目: 分類と取り扱いの状態（在庫数は持たない） ----------
-- available=取り扱い中 / paused=一時品切れ（ゲストには品切れと伝え、スタッフが確認） / retired=取り扱い終了（存在しない扱い）
alter table order_items
  add column category text not null default 'その他',
  add column status text not null default 'available' check (status in ('available', 'paused', 'retired'));
update order_items set status = 'retired' where not active;
alter table order_items drop column active;

-- ---------- 部屋: 予約・客室管理システムの一意のIDで持ち、エリアは部屋ごと ----------
-- 本館・別館で同じ部屋番号があっても区別できるようにする。表示は label（棟＋部屋番号）
alter table rooms
  add column id text,
  add column building text,
  add column area_id uuid references areas (id) on delete set null;
update rooms set id = room_number;
update rooms r set area_id = a.id from areas a where a.hotel_id = r.hotel_id and r.floor between a.floor_from and a.floor_to;
alter table rooms alter column id set not null;
alter table rooms drop constraint rooms_pkey;
alter table rooms add primary key (hotel_id, id);
alter table rooms add constraint rooms_building_room_number_key unique nulls not distinct (hotel_id, building, room_number);
alter table rooms add column label text generated always as (coalesce(building || ' ', '') || room_number) stored;

alter table areas
  drop column floor_from,
  drop column floor_to,
  add column sort integer not null default 0;

alter table mock_pms.reservations add column room_id text;
update mock_pms.reservations set room_id = room_number;

-- ---------- 担当席: 枠ごとの共有アカウント（人数分を自動で作る） ----------
alter table members
  add column seat_slot_id uuid references slots (id) on delete set null,
  add column seat_no smallint;
create unique index members_seat_key on members (seat_slot_id, seat_no) where seat_slot_id is not null;

-- ---------- チケット: 部屋のID、備考、希望日時 ----------
-- room_number には部屋の表示名（label）を入れる。dispatched_at は割り当てを行った時刻（希望日時のあるチケットは前倒しの時刻まで保留）
alter table tickets
  add column room_id text,
  add column note text,
  add column requested_for timestamptz,
  add column dispatched_at timestamptz;
update tickets set room_id = room_number, dispatched_at = coalesce(assigned_at, created_at);
alter table tickets alter column room_id set not null;
create index on tickets (hotel_id, dispatched_at) where dispatched_at is null;

-- 品目ごとの補足はチケットの備考にまとめる
update tickets t set note = x.note
from (select ticket_id, string_agg(item_name || '：' || note, '／' order by id) note from ticket_lines where note is not null group by ticket_id) x
where x.ticket_id = t.id;
alter table ticket_lines drop column note;

alter table hotels
  add column order_schedule_lead_minutes integer not null default 30 check (order_schedule_lead_minutes between 0 and 240);

-- ---------- ゲストの選択待ち ----------
-- ルーターが読み取った依頼を候補の品目に当て、ゲストが画面で品目・数量・備考・お届け時間を確定するまで保存する
create table order_drafts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  message_id uuid references messages (id) on delete set null, -- きっかけのゲストの発言
  requested jsonb not null default '[]', -- ゲストの言い方 [{label, quantity}]
  lines jsonb not null, -- 候補と初期の数量 [{item_id, quantity}]
  note text,
  requested_for timestamptz,
  status text not null default 'open' check (status in ('open', 'submitted', 'cancelled')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on order_drafts (conversation_id, status);
alter table order_drafts enable row level security;

-- ---------- 引き継ぎ: 取り扱いのない品・品切れの依頼 ----------
alter table handoffs drop constraint handoffs_kind_check;
alter table handoffs add constraint handoffs_kind_check check (kind in (
  'talk_request', 'complaint', 'safety', 'overdue_order', 'unanswerable', 'staff_assigned', 'guardrail_blocked', 'system_error',
  'order_unavailable' -- 取り扱いのない品・品切れの品を頼まれた（スタッフが代わりの品などを連絡する）
));
