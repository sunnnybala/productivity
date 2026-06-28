-- ============================================================================
-- Time-correctness fixes (audit-driven). Additive + redefinitions only; no data loss.
--   P4: laptop "active" = window ∩ not-afk  (was raw window = focused time)
--   P1: phone monotonic merge — a retention-edge re-read can never LOWER a value
--   P3: v_daily_rollup footgun — document that summing across source triple-counts
-- ============================================================================

-- ---------- P4: canonical laptop active time (window ∩ not-afk) --------------
-- aw-watcher-window records the focused window even while you're idle; the real
-- "active" metric (ActivityWatch's own) intersects window events with the afk
-- watcher's not-afk periods. We already store afk events — now we use them.
-- Output: one row per (device_id, IST day, app) with the OVERLAP minutes only.
-- Bucketed by the window event's start day (consistent with the rest of the pipeline).
create or replace view public.v_laptop_active as
  with win as (
    select device_id, app,
           ts                                   as w_start,
           ts + duration_sec * interval '1 second' as w_end
    from public.laptop_events
    where source = 'window' and duration_sec > 0
  ),
  naf as (   -- not-afk periods (tile the timeline, never overlap each other)
    select device_id,
           ts                                   as a_start,
           ts + duration_sec * interval '1 second' as a_end
    from public.laptop_events
    where source = 'afk' and data->>'status' = 'not-afk' and duration_sec > 0
  )
  select
    w.device_id,
    (w.w_start at time zone 'Asia/Kolkata')::date as day,
    coalesce(w.app, '(unknown)')                  as app,
    sum(extract(epoch from (least(w.w_end, n.a_end) - greatest(w.w_start, n.a_start)))) / 60.0 as minutes
  from win w
  join naf n
    on  n.device_id = w.device_id
    and n.a_start <  w.w_end       -- interval overlap test
    and n.a_end   >  w.w_start
  group by 1, 2, 3;

revoke all on public.v_laptop_active from anon, authenticated;

-- Per-person daily: laptop now = v_laptop_active (window ∩ not-afk), phone unchanged.
create or replace view public.v_person_daily as
  select person, day, surface, sum(minutes) as minutes
  from (
    select coalesce(d.person, 'unmapped:'||la.device_id) as person,
           la.day, 'laptop'::text as surface, la.minutes
    from public.v_laptop_active la
    left join public.devices d on d.device_id = la.device_id
    union all
    select coalesce(d.person, 'unmapped:'||r.device_id) as person,
           r.day, r.surface, r.minutes
    from public.v_daily_rollup r
    left join public.devices d on d.device_id = r.device_id
    where r.surface = 'phone'
  ) u
  group by 1, 2, 3;

revoke all on public.v_person_daily from anon, authenticated;

-- ---------- P3: mark v_daily_rollup as raw / never-sum-across-source ----------
comment on view public.v_daily_rollup is
  'RAW per-source rollup. DO NOT sum across source for laptop: window+afk+web ≈ triple-count. '
  'Laptop active time = v_laptop_active (window ∩ not-afk). Web = source like ''web-%''. '
  'afk rows exist only to feed the intersection — never add them to a total.';

-- ---------- P1: phone monotonic merge (keep MAX minutes on re-read) -----------
-- The phone worker re-uploads 7 days every run. A date read fresh (accurate) can be
-- re-read later near Android's retention edge (under-counted). Last-write-wins would
-- let the bad read overwrite the good one. This trigger keeps the larger value, so
-- a re-read can heal a gap upward but never decay a known-good day downward.
create or replace function public.phone_usage_keep_max()
returns trigger language plpgsql as $$
begin
  if new.minutes < old.minutes then
    new.minutes := old.minutes;   -- monotonic: never lower a recorded value
  end if;
  return new;
end;
$$;

drop trigger if exists phone_usage_keep_max_trg on public.phone_app_usage;
create trigger phone_usage_keep_max_trg
  before update on public.phone_app_usage
  for each row execute function public.phone_usage_keep_max();

-- ---------- dashboard_summary: laptop now uses v_laptop_active ----------------
create or replace function public.dashboard_summary(p_person text, p_from date, p_to date)
returns json
language sql
stable
as $$
  with dev as (
    select device_id from public.devices where person = p_person
  ),
  lap as (   -- window ∩ not-afk
    select coalesce(sum(la.minutes), 0) m
    from public.v_laptop_active la join dev on dev.device_id = la.device_id
    where la.day between p_from and p_to
  ),
  ph as (
    select coalesce(sum(p.minutes), 0) m
    from public.phone_app_usage p join dev on dev.device_id = p.device_id
    where p.usage_date between p_from and p_to
  ),
  sites as (   -- browsing drill-down (raw web time; never added to the total)
    select coalesce(json_agg(x), '[]'::json) a from (
      select split_part(regexp_replace(e.url, '^https?://', ''), '/', 1) as name,
             round(sum(e.duration_sec)/60.0, 1) as minutes
      from public.laptop_events e join dev on dev.device_id = e.device_id
      where e.source like 'web-%' and e.url is not null
        and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
      group by 1 order by 2 desc limit 25
    ) x
  ),
  papps as (
    select coalesce(json_agg(x), '[]'::json) a from (
      select coalesce(p.app_label, p.package) as name, round(sum(p.minutes), 1) as minutes
      from public.phone_app_usage p join dev on dev.device_id = p.device_id
      where p.usage_date between p_from and p_to
      group by 1 order by 2 desc limit 25
    ) x
  ),
  lapps as (   -- per-app active (window ∩ not-afk)
    select coalesce(json_agg(x), '[]'::json) a from (
      select la.app as name, round(sum(la.minutes), 1) as minutes
      from public.v_laptop_active la join dev on dev.device_id = la.device_id
      where la.day between p_from and p_to
      group by 1 order by 2 desc limit 25
    ) x
  ),
  series as (
    select coalesce(json_agg(x order by x.day), '[]'::json) a from (
      select g.day,
        coalesce((select sum(la.minutes) from public.v_laptop_active la join dev on dev.device_id=la.device_id
                  where la.day = g.day), 0) as laptop,
        coalesce((select sum(p.minutes) from public.phone_app_usage p join dev on dev.device_id=p.device_id
                  where p.usage_date = g.day), 0) as phone
      from (select generate_series(p_from, p_to, interval '1 day')::date as day) g
    ) x
  )
  select json_build_object(
    'laptop_min', (select round(m,1) from lap),
    'phone_min',  (select round(m,1) from ph),
    'sites',       (select a from sites),
    'phone_apps',  (select a from papps),
    'laptop_apps', (select a from lapps),
    'days',        (select a from series)
  );
$$;

revoke all on function public.dashboard_summary(text, date, date) from anon, authenticated;
