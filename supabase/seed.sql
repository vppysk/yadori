-- Demo data (English): Hotel Yukiakari Niseko, a fictional ski-resort hotel in Hokkaido.
-- Loaded by `npm run db:reset`. Run the app with NEXT_PUBLIC_APP_LOCALE=en to match.
-- The Japanese demo data is supabase/seed.ja.sql (`npm run db:reset:ja`).
-- Hourly wages and handling times (hotels.hourly_wage_jpy / handling_minutes) are left empty on purpose:
-- they are entered by the operator on /manage ("Edit assumptions").

insert into hotels (id, name) values ('00000000-0000-0000-0000-000000000001', 'Hotel Yukiakari Niseko');

-- Night follows the statutory night hours in Japan (22:00-5:00). The night premium is hotels.night_premium_rate
insert into time_bands (hotel_id, name, starts_at, ends_at, sort) values
  ('00000000-0000-0000-0000-000000000001', 'Day', '05:00', '17:00', 1),
  ('00000000-0000-0000-0000-000000000001', 'Evening', '17:00', '22:00', 2),
  ('00000000-0000-0000-0000-000000000001', 'Night', '22:00', '05:00', 3);

-- ---------- Permission labels (the migrations create them in Japanese) ----------

update permissions p set label = l.label
from (values
  ('order.create', 'Add orders'),
  ('order.assignable', 'Can be assigned orders'),
  ('order.board.view', 'View the order board'),
  ('order.reassign', 'Assign orders manually'),
  ('knowledge.facility.edit', 'Manage sources and facility info'),
  ('knowledge.notice.edit', 'Edit special notices'),
  ('knowledge.document.register', 'Add guides and manuals'),
  ('knowledge.question.answer', 'Answer unanswered questions'),
  ('handling.consult', 'Ask the staff AI'),
  ('handling.consult.guest', 'Ask the staff AI about guests'),
  ('handling.handoff.accept', 'Handle handoffs'),
  ('handling.handoff.create', 'Create handoffs'),
  ('handling.complaint.view', 'View alerts and complaints'),
  ('handling.integration_write.confirm', 'Confirm writes to connected systems'),
  ('settings.items', 'Items and duties'),
  ('settings.ai_assignment', 'AI model review (approve, trials, satisfaction targets)'),
  ('settings.ai_policy', 'Guest AI instructions'),
  ('settings.integration_rules', 'Connected-system usage rules'),
  ('settings.integrations', 'Integrations'),
  ('settings.masters', 'Cost assumptions (wages, handling times)'),
  ('settings.members', 'Members and permissions'),
  ('integration.web_fetch.read', 'Fetch web pages (Tavily)'),
  ('integration.work_events.read', 'Read work data and order status (export MCP)'),
  ('integration.pms.get_reservation', 'PMS: get reservation'),
  ('integration.pms.search_reservations', 'PMS: search reservations'),
  ('integration.pms.list_guest_notes', 'PMS: list guest notes'),
  ('integration.pms.list_request_history', 'PMS: request history'),
  ('integration.pms.append_guest_note', 'PMS: append guest note'),
  ('integration.pms.append_request_history', 'PMS: append request history')
) as l (key, label)
where p.key = l.key;

-- ---------- Members and permissions ----------

insert into members (id, hotel_id, kind, display_name, job_title) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-000000000001', 'human', 'Aiko Tanaka', 'Supervisor'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000001', 'human', 'Ken Yamamoto', 'Front desk'),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-000000000001', 'human', 'Mia Sato', 'Housekeeping'),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-000000000001', 'human', 'Liam Takahashi', 'Housekeeping'),
  ('00000000-0000-0000-0000-00000000a005', '00000000-0000-0000-0000-000000000001', 'human', 'Yui Ito', 'Housekeeping'),
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-000000000001', 'ai_agent', 'AI agent', null),
  ('00000000-0000-0000-0000-00000000a0e1', '00000000-0000-0000-0000-000000000001', 'external_system', 'Existing management system (reads work data)', null);

-- The export client (an external system that connects to us). Its token lives in an environment variable (/manage/integrations)
update members set token_env = 'EXPORT_MCP_TOKEN' where id = '00000000-0000-0000-0000-00000000a0e1';
insert into member_permissions (member_id, permission_key) values ('00000000-0000-0000-0000-00000000a0e1', 'integration.work_events.read');

insert into permission_groups (id, hotel_id, name, is_preset) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000001', 'Field staff', true),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-000000000001', 'Front desk', true),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-000000000001', 'Supervisor', true),
  ('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-000000000001', 'Admin', true);

-- Preset contents (plan 4.8)
insert into group_permissions (group_id, permission_key)
select '00000000-0000-0000-0000-00000000b001'::uuid, k
from unnest(array['order.assignable', 'handling.consult', 'handling.consult.guest', 'handling.handoff.accept']) k
union all
select '00000000-0000-0000-0000-00000000b002', k
from unnest(array[
  'order.create', 'order.board.view', 'knowledge.question.answer', 'handling.handoff.accept', 'handling.complaint.view'
]) k
union all
select '00000000-0000-0000-0000-00000000b003', k
from unnest(array[
  'order.create', 'order.board.view', 'knowledge.question.answer', 'handling.handoff.accept', 'handling.complaint.view',
  'order.reassign', 'knowledge.facility.edit', 'knowledge.notice.edit', 'knowledge.document.register', 'settings.items',
  'settings.ai_policy', 'settings.integration_rules', 'handling.integration_write.confirm'
]) k
union all
select '00000000-0000-0000-0000-00000000b004', key from permissions where category <> 'integration';

insert into member_groups (member_id, group_id) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b003'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b004'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000b002'),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-00000000a005', '00000000-0000-0000-0000-00000000b001');

-- ---------- Orders: roles, areas, duties, items ----------

insert into job_roles (id, hotel_id, name) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000000001', 'Housekeeping'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-000000000001', 'Room service');

insert into areas (id, hotel_id, name, sort) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'Floors 7-11', 1),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-000000000001', 'Floors 12-15', 2),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-000000000001', 'Annex', 3);

-- Room IDs come from the PMS (docs/005_order.md ch.4). Main-building rooms have no building name; annex rooms show as "Annex 105"
insert into rooms (hotel_id, id, building, room_number, floor, area_id)
select '00000000-0000-0000-0000-000000000001'::uuid, 'RM-' || f::text || lpad(n::text, 2, '0'), null::text, f::text || lpad(n::text, 2, '0'), f,
  case when f <= 11 then '00000000-0000-0000-0000-00000000d001'::uuid else '00000000-0000-0000-0000-00000000d002'::uuid end
from generate_series(7, 15) f, generate_series(1, 11) n
union all
select '00000000-0000-0000-0000-000000000001'::uuid, 'RA-' || f::text || lpad(n::text, 2, '0'), 'Annex', f::text || lpad(n::text, 2, '0'), f,
  '00000000-0000-0000-0000-00000000d003'::uuid
from generate_series(1, 2) f, generate_series(1, 5) n;

-- Duties (role x area; no area = hotel-wide). Set on the admin console under Orders > Duties (docs/005_order.md ch.2)
-- Ken (front desk) has no "can be assigned" permission; `npm run dev:shifts` grants it temporarily (plan 4.8 helping-out example)
insert into member_duties (member_id, job_role_id, area_id) values
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d002'),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d002'),
  ('00000000-0000-0000-0000-00000000a005', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000a005', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d002'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000c002', null);

-- Items are the units guests can choose, grouped by category (docs/005_order.md ch.1). The hair iron is out of stock for the demo
insert into order_items (hotel_id, category, name, aliases, job_role_id, weight, due_minutes, status, sort) values
  ('00000000-0000-0000-0000-000000000001', 'Towels', 'Face towel', '{hand towel}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 1),
  ('00000000-0000-0000-0000-000000000001', 'Towels', 'Bath towel', '{big towel}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 2),
  ('00000000-0000-0000-0000-000000000001', 'Towels', 'Bath mat', '{}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 3),
  ('00000000-0000-0000-0000-000000000001', 'Amenities', 'Toothbrush', '{tooth brush,toothpaste,dental kit}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 4),
  ('00000000-0000-0000-0000-000000000001', 'Amenities', 'Razor', '{shaver,shaving kit}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 5),
  ('00000000-0000-0000-0000-000000000001', 'Amenities', 'Hairbrush', '{comb,hair brush}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 6),
  ('00000000-0000-0000-0000-000000000001', 'Amenities', 'Hanger', '{coat hanger}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'available', 7),
  ('00000000-0000-0000-0000-000000000001', 'Bedding', 'Pillow', '{}', '00000000-0000-0000-0000-00000000c001', 2, 30, 'available', 8),
  ('00000000-0000-0000-0000-000000000001', 'Bedding', 'Blanket', '{duvet,throw}', '00000000-0000-0000-0000-00000000c001', 2, 30, 'available', 9),
  ('00000000-0000-0000-0000-000000000001', 'Appliances', 'Air purifier', '{}', '00000000-0000-0000-0000-00000000c001', 2, 45, 'available', 10),
  ('00000000-0000-0000-0000-000000000001', 'Appliances', 'Humidifier', '{}', '00000000-0000-0000-0000-00000000c001', 3, 45, 'available', 11),
  ('00000000-0000-0000-0000-000000000001', 'Appliances', 'Hair iron', '{curling iron,straightener}', '00000000-0000-0000-0000-00000000c001', 1, 30, 'paused', 12),
  ('00000000-0000-0000-0000-000000000001', 'Baby', 'Baby cot', '{crib,baby bed}', '00000000-0000-0000-0000-00000000c001', 3, 60, 'available', 13),
  ('00000000-0000-0000-0000-000000000001', 'Drinks', 'Mineral water', '{water,bottled water}', '00000000-0000-0000-0000-00000000c002', 1, 20, 'available', 14),
  ('00000000-0000-0000-0000-000000000001', 'Other', 'Lighter', '{matches}', '00000000-0000-0000-0000-00000000c002', 1, 20, 'available', 15);

-- ---------- Facilities and hours (green season; winter comes from docs/demo/winter-notice.pdf) ----------

-- Hotel information (docs/002_facility_master_design.md): facilities and items are created when a source is approved.
-- The demo starts with the "Hotel guide" source already approved. The "Hotel-wide" row is owned by the system
insert into facilities (id, hotel_id, kind, name, sort) values
  ('00000000-0000-0000-0000-00000000f000', '00000000-0000-0000-0000-000000000001', 'global', 'Hotel-wide', 0),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'facility', 'Restaurant Kaze', 1),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-000000000001', 'facility', 'Breakfast Lounge', 2),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-000000000001', 'facility', 'Outdoor Pool', 3),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-000000000001', 'facility', 'Yukimi Onsen', 4),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-000000000001', 'facility', 'Shirakaba Spa', 5),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-000000000001', 'facility', 'Activity Desk', 6);

insert into info_fields (id, hotel_id, name, sort) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'Hours', 1),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'Menu & plans', 2),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000000000001', 'Check-in / check-out', 3),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000001', 'Parking', 4),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-000000000001', 'Wi-Fi', 5);

insert into info_sources (id, hotel_id, title, body, status, approved_at) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'Hotel guide (green season)',
   E'Check-in from 15:00 / Check-out by 11:00\nParking: ¥1,000 per night\nFree Wi-Fi throughout the hotel (network: YUKIAKARI-GUEST)\n\nRestaurant Kaze\nLunch 11:30-14:00 / Dinner 17:30-21:30\nAutumn Harvest Dinner ¥6,800 (Sep 1 - Nov 30)\n\nBreakfast Lounge\nBreakfast buffet 7:00-10:00\n\nOutdoor Pool\nSummer season Jul 1 - Sep 30, 9:00-18:00. Closed Oct 1 - Jun 30.\n\nYukimi Onsen (hot spring)\n6:00-24:00\n\nShirakaba Spa\n10:00-22:00 (last booking 21:00)\n\nActivity Desk\nRafting and guided hikes, May 1 - Oct 31, 9:00-17:00',
   'approved', now());

-- Regular hours have no end date, so the winter notice overlaps them and the approval screen asks which one wins
insert into facility_values (facility_id, field_id, source_id, title, body, valid) values
  ('00000000-0000-0000-0000-00000000f000', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000d001', null, 'Check-in from 15:00 / Check-out by 11:00', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f000', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000d001', null, '¥1,000 per night', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f000', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-00000000d001', null, 'Free throughout the hotel (network: YUKIAKARI-GUEST)', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', 'Lunch', '11:30-14:00', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', 'Dinner', '17:30-21:30', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000d001', 'Autumn Harvest Dinner', '¥6,800', '[2026-09-01,2026-11-30]'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', 'Breakfast', '7:00-10:00 (buffet)', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', null, '9:00-18:00', '[2026-07-01,2026-09-30]'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', null, 'Closed', '[2026-10-01,2027-06-30]'),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', null, '6:00-24:00', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', null, '10:00-22:00 (last booking 21:00)', '[2026-04-01,)'),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000d001', 'Rafting & guided hikes', '9:00-17:00', '[2026-05-01,2026-10-31]');

-- ---------- AI models, instructions, guardrails ----------
-- Every job starts on Super and is re-evaluated daily (docs/000_plan.md 4.3). Complaints are fixed to Ultra in code.
-- Lightning sometimes guessed items with no data (verified 2026-09-25)

insert into ai_models (hotel_id, job, pattern, tier)
select h.id, j.job, j.pattern, 'medium'
from hotels h cross join (values ('answer', 'info'), ('answer', 'order'), ('answer', 'external'), ('answer', 'reservation'), ('staff_ask', '')) j (job, pattern);

-- Guest AI instructions (one text). Reply checks (reply_checks) are extracted by a larger model when saved on the admin console
insert into ai_instructions (hotel_id, scope, body) values
  ('00000000-0000-0000-0000-000000000001', 'common',
   E'- Be warm and polite but not stiff. Lead with the answer and keep it short.\n- Answer for the guest''s stay dates. If you don''t know, don''t guess; say you will check with the staff.\n- Use the official facility names (e.g. "Yukimi Onsen").\n\nFor complaints:\n- Apologize first and restate the inconvenience in your own words.\n- Don''t speculate about causes or make excuses.\n- Don''t mention compensation or refunds; say "A staff member will contact you shortly."\n\n- Always confirm with the guest before finalizing restaurant bookings, paid services or room changes.');

insert into reply_checks (hotel_id, source_type, body, sort) values
  ('00000000-0000-0000-0000-000000000001', 'instruction', 'Never say a restaurant booking, paid service or room change is confirmed without the guest''s confirmation', 1);

-- ---------- Integrations (mock PMS over MCP) ----------
-- Endpoints and tokens are stored as environment variable names. Tools can be re-fetched from MCP on /manage/integrations

insert into integrations (id, hotel_id, name, kind, slug, endpoint_env, token_env) values
  ('00000000-0000-0000-0000-000000009001', '00000000-0000-0000-0000-000000000001', 'Property management system', 'mcp', 'pms', 'PMS_MCP_URL', 'PMS_MCP_TOKEN');

-- ai_enabled: whether the AI may use it (/manage/integrations). Appending to request history is not allowed
insert into integration_tools (integration_id, name, description, role, ai_enabled, require_staff_confirm, permission_key)
select '00000000-0000-0000-0000-000000009001'::uuid, t.name, t.description, t.role, t.enabled, false, 'integration.pms.' || t.name
from (values
  ('get_reservation', 'Get reservation details (room ID, room number, stay dates, guests, plan, rate)', 'reservation', true),
  ('search_reservations', 'Find reservations overlapping a date range. Pass query to filter by name (spaces ignored) or room number', 'search', true),
  ('list_guest_notes', 'List guest notes (anniversaries, preferences, handoffs, etc.)', 'preload', true),
  ('list_request_history', 'Request history during the stay', 'preload', true),
  ('append_guest_note', 'Append to guest notes (existing notes can''t be changed)', null, true),
  ('append_request_history', 'Append to request history', null, false)
) as t (name, description, role, enabled);

-- Tools used by the staff AI also require the asking staff member to have the permission
insert into group_permissions (group_id, permission_key)
select g, 'integration.pms.' || t
from unnest(array['00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b004']::uuid[]) g,
  unnest(array['get_reservation', 'search_reservations', 'list_guest_notes', 'list_request_history']) t;

insert into ai_instructions (hotel_id, scope, integration_id, body) values
  ('00000000-0000-0000-0000-000000000001', 'integration', '00000000-0000-0000-0000-000000009001',
   E'- Use the reservation (room number, stay dates, guests, plan) and the request history during the stay.\n- The "Anniversary" and "Preference" guest notes may be used to personalize answers.\n- Never tell the guest that something "is recorded" in their guest notes.\n- For cases handed off to staff, append one line to the guest notes: "request summary / what the AI told the guest / handed off to".\n- Append information useful for future stays (anniversaries, pillow or room temperature preferences) to the guest notes.\n- For complaints, write only the facts and timeline; never evaluate individual staff members.');

-- ---------- Web page fetching (Tavily) ----------
-- Not shown in the UI (part of the service). URLs are registered as sources on the admin console (docs/006_guide_info.md)

insert into integrations (id, hotel_id, name, kind, slug) values
  ('00000000-0000-0000-0000-000000009002', '00000000-0000-0000-0000-000000000001', 'Web page fetching', 'web_fetch', 'web');

-- room_id is the unique room ID; room_number is what guests see (can repeat across the main building and the annex).
-- Stays are relative to today (hotel time) so the demo works on any recording date. R-1503 arrives in the winter season
insert into mock_pms.reservations (id, hotel_id, guest_name, room_id, room_number, check_in, check_out, adults, plan_name, total_amount_jpy)
select r.id, '00000000-0000-0000-0000-000000000001', r.guest_name, r.room_id, r.room_number, r.check_in, r.check_out, r.adults, r.plan_name, r.total
from (select (now() at time zone 'Asia/Tokyo')::date d) t,
  lateral (values
    ('R-1203', 'Sarah Miller', 'RM-1203', '1203', t.d - 1, t.d + 2, 2, 'Breakfast included', 96000),
    ('R-0711', 'James Chen', 'RM-711', '711', t.d - 1, t.d + 1, 1, 'Room only', 28000),
    ('R-1503', 'Daniel Brooks', 'RM-1503', '1503', date '2026-12-18', date '2026-12-21', 2, 'Anniversary plan', 186000),
    ('R-A105', 'Olivia Park', 'RA-105', '105', t.d, t.d + 3, 2, 'Room only', 54000)
  ) as r (id, guest_name, room_id, room_number, check_in, check_out, adults, plan_name, total);

insert into mock_pms.guest_notes (reservation_id, category, body, written_by) values
  ('R-1503', 'Anniversary', '12/19 wedding anniversary', 'Front desk'),
  ('R-1203', 'Preference', 'Prefers a firm, low pillow', 'Front desk');

-- ---------- Model prices (Token Factory /v1/models, as of 2026-09-25) ----------

insert into model_prices (model_id, effective_from, input_usd_per_mtok, output_usd_per_mtok) values
  ('nvidia/Nemotron-3_5-Lightning', '2026-09-25', 0.06, 0.24),
  ('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', '2026-09-25', 0.06, 0.24),
  ('nvidia/nemotron-3-super-120b-a12b', '2026-09-25', 0.30, 0.90),
  ('nvidia/Nemotron-3-Ultra-550b-a55b', '2026-09-25', 1.00, 3.00),
  ('Qwen/Qwen3-Embedding-8B', '2026-09-25', 0.01, 0),
  ('zai-org/GLM-5.3-Flash', '2026-09-25', 0.15, 0.50);
