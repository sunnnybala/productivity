-- ============================================================================
-- Dashboard shows BOTH laptop numbers:
--   laptop_min        = focused time (raw window in foreground) — the HEADLINE
--   laptop_active_min = active time  (window ∩ not-afk)         — secondary
-- The gap between them = reading / calls / watching / thinking (low-input work).
-- Per-app + sites + daily chart track FOCUSED (the headline). days[] also carries
-- laptop_active for an optional overlay/tooltip.
-- ============================================================================

create or replace function public.dashboard_summary(p_person text, p_from date, p_to date)
returns json
language sql
stable
as $$
  with dev as (
    select device_id from public.devices where person = p_person
  ),
  win as (   -- date-bounded window (focused) events
    select e.device_id, e.app,
           e.ts                                    as w_start,
           e.ts + e.duration_sec * interval '1 second' as w_end,
           e.duration_sec
    from public.laptop_events e join dev on dev.device_id = e.device_id
    where e.source = 'window' and e.duration_sec > 0
      and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  naf as (   -- date-bounded not-afk periods
    select e.device_id,
           e.ts                                    as a_start,
           e.ts + e.duration_sec * interval '1 second' as a_end
    from public.laptop_events e join dev on dev.device_id = e.device_id
    where e.source = 'afk' and e.data->>'status' = 'not-afk' and e.duration_sec > 0
      and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  foc as (   -- focused minutes per IST day + app
    select (w.w_start at time zone 'Asia/Kolkata')::date as day,
           coalesce(w.app, '(unknown)') as app,
           sum(w.duration_sec) / 60.0 as minutes
    from win w group by 1, 2
  ),
  act as (   -- active minutes per IST day = overlap of window with not-afk (same device)
    select (w.w_start at time zone 'Asia/Kolkata')::date as day,
           sum(extract(epoch from (least(w.w_end, n.a_end) - greatest(w.w_start, n.a_start)))) / 60.0 as minutes
    from win w
    join naf n
      on  n.device_id = w.device_id
      and n.a_start < w.w_end
      and n.a_end   > w.w_start
    group by 1
  ),
  ph as (
    select coalesce(sum(p.minutes), 0) m
    from public.phone_app_usage p join dev on dev.device_id = p.device_id
    where p.usage_date between p_from and p_to
  ),
  sites as (
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
  lapps as (   -- per-app FOCUSED minutes (matches the headline)
    select coalesce(json_agg(x), '[]'::json) a from (
      select app as name, round(sum(minutes), 1) as minutes
      from foc group by app order by 2 desc limit 25
    ) x
  ),
  series as (
    select coalesce(json_agg(x order by x.day), '[]'::json) a from (
      select g.day,
        coalesce((select sum(minutes) from foc where foc.day = g.day), 0) as laptop,
        coalesce((select sum(minutes) from act where act.day = g.day), 0) as laptop_active,
        coalesce((select sum(p.minutes) from public.phone_app_usage p join dev on dev.device_id=p.device_id
                  where p.usage_date = g.day), 0) as phone
      from (select generate_series(p_from, p_to, interval '1 day')::date as day) g
    ) x
  )
  select json_build_object(
    'laptop_min',        (select round(coalesce(sum(minutes),0),1) from foc),  -- headline: focused
    'laptop_active_min', (select round(coalesce(sum(minutes),0),1) from act),  -- secondary: hands-on
    'phone_min',  (select round(m,1) from ph),
    'sites',       (select a from sites),
    'phone_apps',  (select a from papps),
    'laptop_apps', (select a from lapps),
    'days',        (select a from series)
  );
$$;

revoke all on function public.dashboard_summary(text, date, date) from anon, authenticated;
