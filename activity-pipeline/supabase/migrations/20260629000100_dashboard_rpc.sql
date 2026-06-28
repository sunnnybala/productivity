-- Read-only aggregation function for the dashboard. One call returns everything for a
-- person + date range (avoids PostgREST's 1000-row cap; all summing done in SQL).
-- No changes to tables/data; only adds a function. Read by the dashboard server (service key).

create or replace function public.dashboard_summary(p_person text, p_from date, p_to date)
returns json
language sql
stable
as $$
  with dev as (
    select device_id from public.devices where person = p_person
  ),
  lap as (
    select coalesce(sum(e.duration_sec)/60.0, 0) m
    from public.laptop_events e join dev on dev.device_id = e.device_id
    where e.source = 'window'
      and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
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
  lapps as (
    select coalesce(json_agg(x), '[]'::json) a from (
      select coalesce(e.app, '(unknown)') as name, round(sum(e.duration_sec)/60.0, 1) as minutes
      from public.laptop_events e join dev on dev.device_id = e.device_id
      where e.source = 'window'
        and (e.ts at time zone 'Asia/Kolkata')::date between p_from and p_to
      group by 1 order by 2 desc limit 25
    ) x
  ),
  series as (
    select coalesce(json_agg(x order by x.day), '[]'::json) a from (
      select g.day,
        coalesce((select sum(e.duration_sec)/60.0 from public.laptop_events e join dev on dev.device_id=e.device_id
                  where e.source='window' and (e.ts at time zone 'Asia/Kolkata')::date = g.day), 0) as laptop,
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
