-- ============================================================================
-- Fix afk/idle event duplication.
-- Root cause: row id was `device|bucket|event_id|ts`, but ActivityWatch reassigns
-- the event id on every read of a still-growing idle (afk) event. Each read created
-- a NEW row instead of updating, so one idle period became many overlapping rows
-- (e.g. 139h of "afk" in a 24h day). Window events were unaffected (stable ids).
-- Fix: the stable natural key is `device|bucket|ts`. Pushers now emit that. This
-- migration rewrites existing ids to the new format, collapsing duplicates by
-- keeping the MAX duration per (device, bucket, ts), and adds a monotonic guard.
-- ============================================================================

-- 1) Collapse duplicates: among rows that map to the same device|bucket|ts, keep
--    the one with the largest duration (most complete read); delete the rest.
with ranked as (
  select id,
    row_number() over (
      partition by split_part(id,'|',1) || '|' || split_part(id,'|',2) || '|' || split_part(id,'|',4)
      order by duration_sec desc, id
    ) rn
  from public.laptop_events
  where split_part(id,'|',4) <> ''   -- only 4-field legacy ids (device|bucket|event_id|ts)
)
delete from public.laptop_events le
using ranked r
where le.id = r.id and r.rn > 1;

-- 2) Rewrite surviving legacy ids to the new natural-key format device|bucket|ts.
--    (field 4 is the original timestamp string the pusher used, so this matches
--    exactly what new pushes will produce -> they upsert in place, no new dupes.)
update public.laptop_events
set id = split_part(id,'|',1) || '|' || split_part(id,'|',2) || '|' || split_part(id,'|',4)
where split_part(id,'|',4) <> '';

-- 3) Monotonic duration guard: a re-read of an event must never SHRINK its stored
--    duration (durations only grow via heartbeat merge). Defends against out-of-order
--    upserts the same way the phone trigger does.
create or replace function public.laptop_event_keep_max_dur()
returns trigger language plpgsql as $$
begin
  if new.duration_sec < old.duration_sec then
    new.duration_sec := old.duration_sec;
  end if;
  return new;
end;
$$;

drop trigger if exists laptop_event_keep_max_dur_trg on public.laptop_events;
create trigger laptop_event_keep_max_dur_trg
  before update on public.laptop_events
  for each row execute function public.laptop_event_keep_max_dur();
