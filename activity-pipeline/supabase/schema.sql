-- ============================================================================
-- Activity Pipeline — Supabase schema (Phase 1 ingest + Phase 2 stubs)
-- Apply with: supabase db push   (or paste into the Supabase SQL editor)
-- ============================================================================

-- ---------- INGEST TABLES (written by devices) ------------------------------

-- High-frequency laptop events: one row per ActivityWatch event.
create table if not exists public.laptop_events (
  id            text primary key,            -- deterministic: device|bucket|event_id|ts
  device_id     text not null,
  source        text not null,               -- 'window' | 'afk' | 'web-chrome' | 'web-brave'
  bucket        text not null,
  ts            timestamptz not null,         -- event start (UTC)
  duration_sec  numeric not null default 0,
  app           text,
  title         text,                         -- nullable (privacy: can be stripped)
  url           text,                         -- nullable
  category      text,                         -- nullable, filled later from AW categories
  data          jsonb,                        -- raw catch-all
  inserted_at   timestamptz not null default now()
);
create index if not exists laptop_events_device_ts_idx on public.laptop_events (device_id, ts);
create index if not exists laptop_events_source_ts_idx  on public.laptop_events (source, ts);

-- Low-frequency phone usage: one row per app per local day.
create table if not exists public.phone_app_usage (
  id           text primary key,              -- deterministic: device|usage_date|package
  device_id    text not null,
  usage_date   date not null,
  package      text not null,
  app_label    text,
  minutes      numeric not null,
  captured_at  timestamptz not null default now()
);
create index if not exists phone_usage_date_idx on public.phone_app_usage (usage_date);

-- Incremental cursor for the laptop pusher (one row per device+bucket).
create table if not exists public.sync_state (
  device_id      text not null,
  bucket         text not null,
  last_event_ts  timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (device_id, bucket)
);

-- ---------- PHASE 2 TARGET (created now, written later by OpenClaw) ----------
create table if not exists public.daily_summary (
  summary_date    date primary key,
  active_min      numeric,
  build_min       numeric,
  comms_min       numeric,
  distraction_min numeric,
  phone_min       numeric,
  peak_window     text,
  sleep_window    text,
  payload         jsonb,
  written_at      timestamptz default now()
);

-- ---------- PHASE 2 FEED: clean per-local-day rollup (read by OpenClaw) ------
-- Local day = Asia/Kolkata. Laptop minutes by source/app + phone minutes by app,
-- unioned into one shape: (day, device_id, surface, source, app, minutes).
create or replace view public.v_daily_rollup as
  select
    (e.ts at time zone 'Asia/Kolkata')::date            as day,
    e.device_id,
    'laptop'                                             as surface,
    e.source,
    coalesce(e.app, '(unknown)')                         as app,
    round(sum(e.duration_sec) / 60.0, 1)                as minutes
  from public.laptop_events e
  group by 1, 2, 3, 4, 5
  union all
  select
    p.usage_date                                        as day,
    p.device_id,
    'phone'                                             as surface,
    'app-usage'                                         as source,
    coalesce(p.app_label, p.package)                    as app,
    round(sum(p.minutes), 1)                            as minutes
  from public.phone_app_usage p
  group by 1, 2, 3, 4, 5;

-- ---------- ROW LEVEL SECURITY ---------------------------------------------
-- Devices use the anon API key. They may WRITE ingest tables but not READ them.
-- sync_state is readable by devices (it's just cursors). daily_summary is locked
-- to the service role (Phase 2 / OpenClaw reads & writes it server-side).

alter table public.laptop_events  enable row level security;
alter table public.phone_app_usage enable row level security;
alter table public.sync_state      enable row level security;
alter table public.daily_summary   enable row level security;

-- laptop_events: insert + update + select. SELECT is required because the
-- merge-duplicates upsert compiles to INSERT ... ON CONFLICT DO UPDATE, which
-- must read the table to detect conflicts (without it: 42501 RLS violation).
drop policy if exists le_ins on public.laptop_events;
drop policy if exists le_upd on public.laptop_events;
drop policy if exists le_sel on public.laptop_events;
create policy le_ins on public.laptop_events for insert to anon with check (true);
create policy le_upd on public.laptop_events for update to anon using (true) with check (true);
create policy le_sel on public.laptop_events for select to anon using (true);

-- phone_app_usage: insert + update + select (same upsert reason as above)
drop policy if exists pu_ins on public.phone_app_usage;
drop policy if exists pu_upd on public.phone_app_usage;
drop policy if exists pu_sel on public.phone_app_usage;
create policy pu_ins on public.phone_app_usage for insert to anon with check (true);
create policy pu_upd on public.phone_app_usage for update to anon using (true) with check (true);
create policy pu_sel on public.phone_app_usage for select to anon using (true);

-- sync_state: device needs read (cursor) + write
drop policy if exists ss_sel on public.sync_state;
drop policy if exists ss_ins on public.sync_state;
drop policy if exists ss_upd on public.sync_state;
create policy ss_sel on public.sync_state for select to anon using (true);
create policy ss_ins on public.sync_state for insert to anon with check (true);
create policy ss_upd on public.sync_state for update to anon using (true) with check (true);

-- daily_summary: no anon policy => only service_role can touch it (Phase 2).
