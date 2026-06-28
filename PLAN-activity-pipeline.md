# Plan: Centralized Activity Tracking → Supabase

**Scope (Phase 1 only):** Get *all* laptop ActivityWatch data and *all* phone app-usage
data into one centralized Supabase Postgres DB. Reliable, idempotent, hands-off.

**Out of scope now, but designed for:** Phase 2 = OpenClaw daily cron reads Supabase →
builds summary → writes to gbrain. We do NOT build Phase 2 now, but the schema and a
rollup view are shaped so Phase 2 plugs in without rework.

---

## Step 0 — Scope challenge (what we are NOT rebuilding)

**What already exists (reuse, don't rebuild):**
- **ActivityWatch local server + SQLite** — already the laptop's raw time-series store.
  We do NOT build a raw store; we mirror its data out.
- **AW REST API** `GET /api/0/buckets/<id>/events?start=&end=` — already supports
  incremental reads. This IS our extract mechanism.
- **AW categories engine** — reuse later to fill a `category` column.
- **Android `UsageStatsManager`** — the OS already records per-app daily usage (same
  source Digital Wellbeing uses). We read it, we don't track separately.
- **Supabase CLI (v2.99.0, installed)** — use for schema migrations.
- **JDK 21 (installed)** — to build the phone app headlessly.
- **gbrain** — the Phase 2 target. Exists.

**Minimum change set:** one Supabase project + 2 ingest tables + 1 laptop pusher
(scheduled) + 1 phone app. Four moving parts. No backend service to host (PostgREST
is Supabase's auto API). No streaming. No dashboards.

---

## Architecture

```
┌──────────────────────┐                      ┌───────────────────────────────┐
│  LAPTOP (Windows)    │                      │      SUPABASE (cloud)          │
│                      │   HTTPS POST          │   Postgres + PostgREST + RLS   │
│  ActivityWatch :5600 │   (bulk upsert,       │                               │
│        │ REST        │    merge-duplicates)  │   TABLES                       │
│        ▼             │ ───────────────────▶  │    laptop_events   (raw)      │
│  pusher script       │                       │    phone_app_usage (daily)    │
│  (Task Scheduler:    │                       │    sync_state      (cursor)   │
│   daily + catch-up   │                       │    daily_summary   (Phase 2)  │
│   + logon)           │                       │                               │
│  reads sync_state    │                       │                               │
└──────────────────────┘                      │   VIEW                        │
                                               │    v_daily_rollup  (P2 feeds  │
┌──────────────────────┐                      │     OpenClaw)                  │
│  PHONE (Android)     │   HTTPS POST          │                               │
│                      │   (bulk upsert)       │                               │
│  Kotlin app:         │ ───────────────────▶  │   Phase 2 ──▶ OpenClaw cron   │
│   UsageStatsManager  │                       │     reads v_daily_rollup,     │
│   + WorkManager      │                       │     writes daily_summary      │
│   (daily ~23:55)     │                       │     + gbrain logs/daily/      │
└──────────────────────┘                      └───────────────────────────────┘
```

**Boundary rule (protects Phase 2):** ingest (laptop + phone) only ever WRITES the two
ingest tables. Summarization (OpenClaw, Phase 2) only READS the rollup view and WRITES
`daily_summary` + gbrain. The two halves never touch each other's tables. This is what
lets us build Phase 1 now and bolt on Phase 2 later with zero changes to ingest.

---

## Schema

Two ingest tables because the data is two different grains: laptop = per-event
(thousands/day), phone = per-app daily totals (dozens/day). Forcing them into one table
means mostly-null columns and mixed semantics. They converge later at the summary layer.

```sql
-- High-frequency laptop events (one row per AW event)
create table laptop_events (
  id            text primary key,         -- deterministic: device|bucket|event_id|ts
  device_id     text not null,
  source        text not null,            -- 'window' | 'afk' | 'web-chrome' | 'web-brave'
  bucket        text not null,
  ts            timestamptz not null,      -- event start (UTC)
  duration_sec  numeric not null default 0,
  app           text,
  title         text,                      -- nullable (privacy: can be stripped)
  url           text,                      -- nullable
  category      text,                      -- nullable, filled later from AW categories
  data          jsonb,                     -- raw catch-all
  inserted_at   timestamptz not null default now()
);
create index on laptop_events (device_id, ts);
create index on laptop_events (source, ts);

-- Low-frequency phone usage (one row per app per day)
create table phone_app_usage (
  id           text primary key,           -- deterministic: device|usage_date|package
  device_id    text not null,
  usage_date   date not null,
  package      text not null,
  app_label    text,
  minutes      numeric not null,
  captured_at  timestamptz not null default now()
);

-- Incremental cursor for the laptop pusher (per bucket)
create table sync_state (
  device_id      text not null,
  bucket         text not null,
  last_event_ts  timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (device_id, bucket)
);

-- Phase 2 target (created now, written later by OpenClaw)
create table daily_summary (
  summary_date  date primary key,
  active_min    numeric,
  build_min     numeric,
  comms_min     numeric,
  distraction_min numeric,
  phone_min     numeric,
  peak_window   text,
  sleep_window  text,
  payload       jsonb,                      -- full structured rollup
  written_at    timestamptz default now()
);

-- Phase 2 feed: one clean per-local-day rollup OpenClaw reads (define now)
create view v_daily_rollup as
  -- laptop active minutes by local day + source, plus phone minutes by day
  -- (exact SQL finalized in build; shape: date, source, app, minutes)
  select 1; -- placeholder, finalized during implementation
```

**Idempotency:** deterministic primary keys + PostgREST upsert
(`Prefer: resolution=merge-duplicates`). Re-runs, overlapping time windows, and same-day
phone re-pushes all converge — last write wins, no duplicates.

---

## Component B — Laptop pusher

**Runtime:** Windows Task Scheduler → **once-daily trigger** + *at logon*, both with "run
as soon as possible after a missed start." In practice it runs once when you next wake the
laptop each day. Negligible cost (a few HTTP calls, seconds — not a daemon).

**Why this has no permanent gaps:** the pusher is incremental (cursor) and AW retains full
history locally (no auto-prune). Every run pushes *everything* since the last successful
run, so cadence affects only freshness (~24h stale max), never completeness. A day is never
lost even if the laptop is off for it — the next run backfills it.

**Logic per run:**
```
for each bucket in [window, afk, web-chrome, web-brave]:
    cursor = sync_state.last_event_ts (default: AW install time)
    events = GET /api/0/buckets/<bucket>/events?start=cursor-5min&end=now   # 5min overlap
    rows   = [ transform(e) for e in events ]                                # deterministic id
    upsert rows -> Supabase (batches of 500, merge-duplicates)
    if all batches 2xx:  sync_state.last_event_ts = max(ts in rows)
    else:                leave cursor (retry next run)
```

**Why it's safe:**
- AW down / not started yet → connection refused → skip bucket, retry next run. No loss
  (AW keeps data locally).
- Supabase unreachable → batch fails → cursor NOT advanced → next run catches up.
- Laptop asleep at trigger → Task Scheduler catch-up on wake.
- 5-min overlap re-reads recent events (which may have grown in duration); upsert dedups.
- All timestamps UTC (AW emits ISO-8601 UTC; column is `timestamptz`).

**Language:** PowerShell (zero new dependencies; `Invoke-RestMethod` does JSON POST). Node
or Python are alternatives if we want richer batching, but PowerShell keeps it dependency-free.

---

## Component C — Phone Kotlin app

- Requests `PACKAGE_USAGE_STATS` (Usage Access — one-time manual grant in Settings).
- `UsageStatsManager.queryAndAggregateUsageStats(startOfLocalDay, now)` → per-package
  foreground minutes for the day.
- `WorkManager` periodic job (~daily, near 23:55 local) → builds JSON array → POST to
  `phone_app_usage` (merge-duplicates upsert, so intra-day re-runs just refresh totals).
- Survives reboot/Doze via WorkManager. Needs battery-optimization exemption on
  aggressive OEMs (Samsung/Xiaomi).
- Built headlessly here (`gradlew assembleDebug`) → I hand over `app-debug.apk`.
- User does ~3 one-time taps: install unknown apps, install APK, grant Usage Access.

---

## Test plan (coverage targets)

**Laptop pusher**
- `transform(event)` → row mapping: window/afk/web variants, missing title/url. [unit]
- Deterministic id stability (same event → same id across runs). [unit]
- Cursor advance: advances on full success; does NOT advance on any batch failure. [unit]
- Idempotency: run pusher twice over same window → row count unchanged. [integration]
- AW-down: connection refused → no crash, no cursor advance. [unit, mocked]
- Supabase 4xx/5xx → no cursor advance, logged. [unit, mocked]

**Phone app**
- UsageStats → JSON mapping, seconds→minutes, local-day bounds. [unit]
- Upsert idempotency: two pushes same day → totals refreshed, no dup rows. [integration]
- WorkManager scheduling via `WorkManagerTestInitHelper`. [instrumented]
- POST retry/backoff on network failure. [unit, mocked]
- Permission-not-granted path → graceful no-op + user prompt. [instrumented]

**E2E:** one real day — both devices push → query Supabase → verify laptop_events and
phone_app_usage populated, no duplicates, timestamps sane.

---

## Failure modes (each: test? error-handled? silent?)

| Failure | Test | Handled | User-visible? |
|---|---|---|---|
| Laptop offline at push | yes | cursor not advanced, retry | silent (correct) |
| AW not running | yes | skip + retry | silent (correct) |
| Supabase down | yes | no cursor advance | silent (correct) |
| Phone off > 7 days | n/a | UsageStats retention gap | silent gap (accepted) |
| OEM kills WorkManager | manual | battery exemption | silent gap → **mitigate w/ exemption** |
| Duplicate pushes | yes | upsert merge | none |
| Clock/timezone skew | yes | UTC storage | none |

No failure mode is both silent AND unhandled AND data-losing within normal operation.

---

## Phasing

- **Phase 0:** Supabase project + schema + RLS. *(me, needs your signup + token)*
- **Phase 1a:** Laptop pusher + Task Scheduler. *(me, buildable + testable now)*
- **Phase 1b:** Phone Kotlin app → APK. *(me builds; you install + grant)*
- **Phase 2 (future, design-only here):** `v_daily_rollup` finalized + OpenClaw cron →
  `daily_summary` + gbrain `logs/daily/`. Ingest untouched.

---

## NOT in scope (Phase 1)

- OpenClaw cron + gbrain writing — Phase 2.
- Dashboards / Grafana — not needed for ingest.
- Real-time streaming — batch is sufficient.
- Historical backfill before AW install — no data exists.
- iOS, multi-user — not applicable.
- Data retention/pruning — fine for 18+ months at this volume (user confirmed).
- AW category sync into `category` column — column exists, fill later.

---

## Decisions (resolved)

1. **Schema:** two tables (`laptop_events` + `phone_app_usage`). ✓
2. **Pusher cadence:** once-daily trigger + logon, both with missed-start catch-up.
   Cursor + AW retention guarantee no permanent gaps; ~24h max staleness; minimal battery. ✓
3. **Pusher language:** PowerShell (zero new dependencies). ✓
4. **Phone method:** custom Kotlin app (UsageStatsManager + WorkManager). ✓

## Build order / parallelization

```
Phase 0 (Supabase schema)  ─┬─▶  Phase 1a (laptop pusher)   [Lane A]
   gates both               └─▶  Phase 1b (phone Kotlin app) [Lane B]
```
- Lane A and Lane B are fully independent (different modules, different machines) → can be
  built in parallel once Phase 0 exists.
- Phase 2 (OpenClaw) is deferred; reads `v_daily_rollup`, writes `daily_summary` + gbrain.
