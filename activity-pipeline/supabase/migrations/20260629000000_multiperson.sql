-- Multi-person support + dashboard views (review-hardened).

create table if not exists public.devices (
  device_id  text primary key,
  person     text not null check (person in ('dhruv','cofounder')),
  kind       text check (kind in ('laptop','phone')),
  os         text,
  created_at timestamptz not null default now()
);
create index if not exists devices_person_idx on public.devices (person);

-- Active minutes per person/day: laptop = window source only (no double-count); phone as-is.
-- LEFT JOIN so unmapped/reinstalled devices show as 'unmapped:<id>' instead of vanishing.
create or replace view public.v_person_daily as
  select coalesce(d.person, 'unmapped:'||r.device_id) as person,
         r.day, r.surface, sum(r.minutes) as minutes
  from public.v_daily_rollup r
  left join public.devices d on d.device_id = r.device_id
  where r.surface = 'phone'
     or (r.surface = 'laptop' and r.source = 'window')
  group by 1,2,3;

-- Devices seen pushing data but not yet registered (dashboard shows a "register me" banner).
create or replace view public.v_unmapped_devices as
  select distinct e.device_id
  from public.laptop_events e
  left join public.devices d on d.device_id = e.device_id
  where d.device_id is null;

-- Per-person web time by domain (laptop URLs).
create or replace view public.v_person_web as
  select coalesce(d.person, 'unmapped:'||e.device_id) as person,
         (e.ts at time zone 'Asia/Kolkata')::date as day,
         split_part(regexp_replace(e.url, '^https?://', ''), '/', 1) as domain,
         round(sum(e.duration_sec)/60.0, 1) as minutes
  from public.laptop_events e
  left join public.devices d on d.device_id = e.device_id
  where e.source like 'web-%' and e.url is not null
  group by 1,2,3;

-- These views are read ONLY by the dashboard server (secret/service key). Block anon/authenticated.
revoke all on public.v_person_daily      from anon, authenticated;
revoke all on public.v_unmapped_devices  from anon, authenticated;
revoke all on public.v_person_web        from anon, authenticated;

-- Register dhruv's known devices now (co-founder's added after her devices first push).
insert into public.devices (device_id, person, kind, os) values
  ('af768f5a-9e90-4142-b0fd-85f1251f7522', 'dhruv', 'laptop', 'windows'),
  ('0f4d9b4e48c2f2a7',                     'dhruv', 'phone',  'android')
on conflict (device_id) do update
  set person = excluded.person, kind = excluded.kind, os = excluded.os;
