-- P2 seed — a handful of starter updates so the feed renders with
-- real content before the operator posts their own via P4. Safe to
-- re-run thanks to the WHERE NOT EXISTS guard on title+body.

insert into public.updates (title, body, audience, effective_date, requires_ack)
select 'Welcome to the Ops Hub',
       'This is where every change to the operation lands. Tap "Got it" when you''ve read one so Mike knows the whole team is on the same page.',
       '{}'::text[], null, true
where not exists (select 1 from public.updates where title = 'Welcome to the Ops Hub');

insert into public.updates (title, body, audience, effective_date, requires_ack)
select 'Bakers: double-check the Franklin Square tray count',
       'FSQ route bakes out of Franklin Square. Lynbrook bakes for LYN and FBW routes. The totals at the top of the Baker page already split them out for you.',
       ARRAY['bakers'], current_date, true
where not exists (select 1 from public.updates where title = 'Bakers: double-check the Franklin Square tray count');

insert into public.updates (title, body, audience, effective_date, requires_ack)
select 'Drivers: log returns at every stop',
       'When the returns page ships you''ll enter singles + doubles back per stop. The bill calculates itself and syncs to the sales sheet, so no retyping.',
       ARRAY['drivers'], current_date, true
where not exists (select 1 from public.updates where title = 'Drivers: log returns at every stop');
