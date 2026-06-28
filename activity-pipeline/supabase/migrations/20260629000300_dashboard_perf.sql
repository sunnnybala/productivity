-- ============================================================================
-- Perf: dashboard_summary computes window ∩ not-afk inside DATE-BOUNDED CTEs.
-- v_laptop_active (from the prior migration) is correct but its range self-join
-- can't be pruned by a `where day between ...` predicate (day is derived after the
-- join), so using it in the hot path would intersect the WHOLE table every call.
-- Here we filter window/afk events to the person's devices AND the date range first,
-- then intersect — same math as v_laptop_active, but only over the relevant slice.
-- v_laptop_active stays as the canonical/analysis view.
-- ============================================================================

create or replace function public.dashboard_summary(p_person text, p_from date, p_to date)
returns json
language sql
stable
as $$
  with dev as (
    select device_id from public.devices where person = p_person
  ),
  -- date-bounded window events for this person
  win as (
    select e.device_id, e.app,
           e.ts                                    as w_start,
           e.ts + e.duration_sec * interval '1 second' as w_end
    from public.laptop_events e join dev on dev.device_id = e.device_id
    where e.source = 'window' and e.duration_sec > 0
      and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  -- date-bounded not-afk periods for this person
  naf as (
    select e.device_id,
           e.ts                                    as a_start,
           e.ts + e.duration_sec * interval '1 second' as a_end
    from public.laptop_events e join dev on dev.device_id = e.device_id
    where e.source = 'afk' and e.data->>'status' = 'not-afk' and e.duration_sec > 0
      and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  -- active = overlap of window with not-afk, per IST day + app (same device only)
  active as (
    select (w.w_start at time zone 'Asia/Kolkata')::date as day,
           coalesce(w.app, '(unknown)') as app,
           sum(extract(epoch from (least(w.w_end, n.a_end) - greatest(w.w_start, n.a_start)))) / 60.0 as minutes
    from win w
    join naf n
      on  n.device_id = w.device_id
      and n.a_start < w.w_end
      and n.a_end   > w.w_start
    group by 1, 2
  ),
  lap as (
    select coalesce(sum(minutes), 0) m from active
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
  lapps as (   -- per-app active minutes
    select coalesce(json_agg(x), '[]'::json) a from (
      select app as name, round(sum(minutes), 1) as minutes
      from active group by 1 order by 2 desc limit 25
    ) x
  ),
  series as (
    select coalesce(json_agg(x order by x.day), '[]'::json) a from (
      select g.day,
        coalesce((select sum(minutes) from active where active.day = g.day), 0) as laptop,
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
