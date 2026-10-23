-- ═══════════════════════════════════════════════════════════════════
-- PPF Ops Hub — seed data
-- ═══════════════════════════════════════════════════════════════════
-- Run AFTER schema.sql. Safe to re-run: upserts on natural keys.
--
-- Everyone's starter PIN is 0000. Mike should log in first and rotate
-- each person's PIN from the operator UI (coming in P4). Until that
-- ships, update manually:
--   update public.people set pin_hash = crypt('1234', gen_salt('bf',10))
--   where name = 'Vic';
-- ═══════════════════════════════════════════════════════════════════

-- ─── people ────────────────────────────────────────────────────────
insert into public.people (name, role, pin_hash) values
  ('Mike',     'operator', crypt('0000', gen_salt('bf', 10))),
  ('Vic',      'baker',    crypt('0000', gen_salt('bf', 10))),
  ('Marcos',   'baker',    crypt('0000', gen_salt('bf', 10))),
  ('Tony',     'baker',    crypt('0000', gen_salt('bf', 10))),
  ('Eric',     'driver',   crypt('0000', gen_salt('bf', 10))),
  ('Gary',     'driver',   crypt('0000', gen_salt('bf', 10))),
  ('Reetu',    'driver',   crypt('0000', gen_salt('bf', 10))),
  ('Julianna', 'driver',   crypt('0000', gen_salt('bf', 10))),
  ('Brandon',  'driver',   crypt('0000', gen_salt('bf', 10)))
on conflict (name) do nothing;

-- ─── routes ────────────────────────────────────────────────────────
insert into public.routes (key, label, display_order) values
  ('FSQ', 'Franklin Square', 1),
  ('LYN', 'Lynbrook',        2),
  ('FBW', 'Freeport/Baldwin', 3)
on conflict (key) do update set label = excluded.label, display_order = excluded.display_order;

-- ─── shifts ────────────────────────────────────────────────────────
-- Weekday: 0 Sun · 1 Mon · 2 Tue · 3 Wed · 4 Thu · 5 Fri · 6 Sat
-- Bakers:
--   Vic:    Lynbrook Mon/Wed/Thu/Fri + Franklin Square Sat/Sun
--   Marcos: Lynbrook Tue/Sat/Sun
--   Tony:   Franklin Square Mon-Fri
-- Drivers:
--   Eric:     FSQ route Mon-Fri
--   Gary:     LYN route Mon-Sat
--   Reetu:    FBW route 7 days
--   Julianna: FSQ Sat + LYN Sun
--   Brandon:  FSQ Sun

-- Wipe then re-insert so the seed stays a true snapshot of this plan.
delete from public.shifts;

insert into public.shifts (person_id, role, location, route_key, days)
select p.id, 'baker'::user_role, 'Lynbrook bakery', null, array[1,3,4,5]
  from public.people p where p.name = 'Vic'
union all select p.id, 'baker'::user_role, 'Franklin Square bakery', null, array[6,0]
  from public.people p where p.name = 'Vic'
union all select p.id, 'baker'::user_role, 'Lynbrook bakery', null, array[2,6,0]
  from public.people p where p.name = 'Marcos'
union all select p.id, 'baker'::user_role, 'Franklin Square bakery', null, array[1,2,3,4,5]
  from public.people p where p.name = 'Tony'
union all select p.id, 'driver'::user_role, 'Franklin Square route', 'FSQ', array[1,2,3,4,5]
  from public.people p where p.name = 'Eric'
union all select p.id, 'driver'::user_role, 'Lynbrook route', 'LYN', array[1,2,3,4,5,6]
  from public.people p where p.name = 'Gary'
union all select p.id, 'driver'::user_role, 'Freeport/Baldwin route', 'FBW', array[0,1,2,3,4,5,6]
  from public.people p where p.name = 'Reetu'
union all select p.id, 'driver'::user_role, 'Franklin Square route', 'FSQ', array[6]
  from public.people p where p.name = 'Julianna'
union all select p.id, 'driver'::user_role, 'Lynbrook route', 'LYN', array[0]
  from public.people p where p.name = 'Julianna'
union all select p.id, 'driver'::user_role, 'Franklin Square route', 'FSQ', array[0]
  from public.people p where p.name = 'Brandon';

-- ─── stops ─────────────────────────────────────────────────────────
-- Pulled from the live Google Sheet (gid 1825588771 / 1112663081 /
-- 580731113 / 1308920282) plus the drop counts Chris confirmed in
-- chat. Dead accounts (Red Label IP / ER) are inserted as active=false
-- so they show in reports but not on today's route.

delete from public.stops;

-- FSQ route ────────────────────────────────────────────────────────
insert into public.stops (route_key, stop_order, name, town, singles_drop, doubles_drop, singles_drop_wknd, doubles_drop_wknd, basket, note) values
  ('FSQ', 1,  'Brock''s Deli',      'Franklin Square',  5,  5, null, null, null, null),
  ('FSQ', 2,  '711 FSQ',            'Franklin Square', 10, 10, null, null, null, null),
  ('FSQ', 3,  '711 VS',             'Valley Stream',    5,  5, null, null, null, null),
  ('FSQ', 4,  'Malverne Deli',      'Malverne',        10, 10, null, null, null, null),
  ('FSQ', 5,  'Kooka Malverne',     'Malverne',         5,  5, null, null, null, null),
  ('FSQ', 6,  'Eastern Meat Farms', 'Garden City',      6,  6, null, null, null, null),
  ('FSQ', 7,  'IVB',                'Garden City',     15, 15,   20,   20, null, 'Weekday 15/15, weekend 20/20'),
  ('FSQ', 8,  '711 HMP',            'Franklin Square', 10, 10, null, null, null, null),
  ('FSQ', 9,  '711 HF',             'Franklin Square', 10, 10, null, null, null, 'Holiday Farms');

-- LYN route (Routes 2 + 3 combined) ────────────────────────────────
insert into public.stops (route_key, stop_order, name, town, singles_drop, doubles_drop, singles_drop_wknd, doubles_drop_wknd, basket, note) values
  ('LYN', 1,  '711 Broadway',  'Hewlett',          7,  4, null, null, null, null),
  ('LYN', 2,  '711 SR',        'Valley Stream',    5,  5, null, null, null, 'Sunrise Hwy'),
  ('LYN', 3,  '711 NCA',       'Valley Stream',    5,  5, null, null, null, 'N Central Ave'),
  ('LYN', 4,  '711 M2',        'Valley Stream',    5,  5, null, null, null, 'E Merrick Rd'),
  ('LYN', 5,  '711 M1',        'Lynbrook',         5,  5, null, null, null, 'Merrick Rd'),
  ('LYN', 6,  'Kooka RVC',     'Rockville Centre', 5,  5, null, null, null, null),
  ('LYN', 7,  '711 RVC',       'Rockville Centre', 5,  5, null, null, null, null),
  ('LYN', 8,  '711 ATL',       'Lynbrook',         6,  6, null, null, null, 'Atlantic Ave'),
  ('LYN', 9,  'Bagel Gourmet', 'East Rockaway',   12,  0, null, null, null, '12 singles, no doubles'),
  ('LYN', 10, '711 LAW',       'Oceanside',       10,  5, null, null, null, 'Lawson Blvd'),
  ('LYN', 11, '711 OS',        'Oceanside',       10, 10, null, null, null, 'Long Beach Rd'),
  ('LYN', 12, '711 LBR',       'Long Beach',       5,  5, null, null, null, 'Long Beach Blvd'),
  ('LYN', 13, '711 AU',        'Island Park',      5,  5, null, null, null, 'Austin Blvd');

-- FBW route ────────────────────────────────────────────────────────
insert into public.stops (route_key, stop_order, name, town, singles_drop, doubles_drop, singles_drop_wknd, doubles_drop_wknd, basket, note) values
  ('FBW', 1,  '711 SRRVC', 'Rockville Centre', 5, 5, null, null, null, 'Sunrise Hwy'),
  ('FBW', 2,  '711 BK',    'Freeport',         5, 5, null, null, null, 'Brooklyn Ave'),
  ('FBW', 3,  '711 EM',    'Freeport',         5, 5, null, null, null, 'E Merrick Rd'),
  ('FBW', 4,  '711 GL',    'Freeport',         5, 5, null, null, null, 'Guy Lombardo Ave'),
  ('FBW', 5,  '711 ATLF',  'Freeport',         5, 5, null, null, null, 'Atlantic Ave'),
  ('FBW', 6,  '711 ATLB',  'Baldwin',          5, 5, null, null, null, 'Atlantic Ave'),
  ('FBW', 7,  '711 GA',    'Baldwin',          5, 5, null, null, null, 'Grand Ave'),
  ('FBW', 8,  '711 NR',    'Roosevelt',        5, 5, null, null, null, 'Nassau Rd'),
  ('FBW', 9,  '711 SRF',   'Freeport',         5, 5, null, null, null, 'Sunrise Hwy');

-- Dead accounts kept for reference, hidden from today's view ───────
insert into public.stops (route_key, stop_order, name, town, singles_drop, doubles_drop, basket, note, active) values
  ('LYN', 90, 'Red Label IP', 'Island Park',     5,  5, null, 'Dead account, kept for reference', false),
  ('LYN', 91, 'Red Label ER', 'East Rockaway',  10, 10, null, 'Dead account, kept for reference', false);
