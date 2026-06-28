# Plan: 2-person shared tracking + web dashboard

**Goal:** Onboard the co-founder (Linux laptop + Android phone) into the **same** Supabase
project, then build a **Next.js dashboard on Vercel** where both founders see each other's
laptop + phone activity (apps + sites), side by side.

**Locked decisions (from user):** single shared DB; mirror the existing architecture for her;
no privacy toggle / no granularity limits / full mutual data; symmetry by default.

---

## Step 0 — scope challenge (what exists vs. what's new)

**Reuse, unchanged:**
- Supabase project `activity-tracker` + tables `laptop_events`, `phone_app_usage`,
  `sync_state`, `daily_summary`, view `v_daily_rollup`, and the anon-key ingest/RLS posture.
- The Android APK (generic — creds entered in-app) and the Windows pusher.
- **Key insight: no schema change to event tables and NO app changes.** Every row already
  carries a unique `device_id`; that's the per-person dimension. We only add a `device_id →
  person` mapping.

**Net-new (3 things):**
1. A tiny `devices` table + person-aware views (DB).
2. Her device onboarding: Linux AW + the **Python pusher** (already written in
   `CO-FOUNDER-SETUP.md`) + the phone APK.
3. A **Next.js dashboard** on Vercel reading the shared DB.

**Minimum change set:** 1 table + 2 views + 1 web app + her onboarding. No edits to existing
ingest code. ~1 small migration + a dashboard app.

---

## Architecture

```
 His Windows laptop  (PowerShell pusher) ─┐
 His Android (APK)                        ─┤
 Her Linux laptop    (Python pusher)      ─┼─►  Supabase  activity-tracker  (SHARED)
 Her Android (APK)                        ─┘      laptop_events / phone_app_usage
                                                  tagged by device_id
                                                  + devices(device_id → person)
                                                  + v_person_daily / v_person_web views
                                                        │  (service_role, server-side only)
                                                        ▼
                                                  Next.js dashboard on Vercel
                                                   - Supabase Auth: only the 2 founders log in
                                                   - server reads ALL rows, joins devices→person
                                                   - side-by-side views (you vs co-founder)
```

**Read/auth model (the one real design choice):** the dashboard reads with the **service_role
key kept server-side on Vercel** (never shipped to the browser), and the whole app is gated
behind **Supabase Auth limited to the 2 founders' emails**. This keeps ingest exactly as-is
(anon writes) while giving the website a secure, login-gated read path. We do NOT rely on the
open anon-SELECT for the website (that key in a public site would expose everything).

---

## Data model (additive migration)

```sql
create table if not exists public.devices (
  device_id  text primary key,
  person     text not null check (person in ('dhruv','cofounder')),  -- enum-guard typos
  kind       text check (kind in ('laptop','phone')),
  os         text,
  created_at timestamptz not null default now()
);
create index if not exists devices_person_idx on public.devices (person);

-- Person-aware daily rollup. FIXES from review:
--  * LEFT JOIN + coalesce so an unmapped/reinstalled device shows as 'unmapped:<id>'
--    instead of silently vanishing (inner join would drop it).
--  * Laptop "active minutes" = source='window' ONLY. Summing window+afk+web double-counts
--    (web events overlap window time; afk is a separate axis). Web is its own dimension.
create or replace view public.v_person_daily as
  select coalesce(d.person, 'unmapped:'||r.device_id) as person,
         r.day, r.surface, sum(r.minutes) as minutes
  from public.v_daily_rollup r
  left join public.devices d on d.device_id = r.device_id
  where r.surface = 'phone'
     or (r.surface = 'laptop' and r.source = 'window')
  group by 1,2,3;

-- Dashboard surfaces this as an "unmapped devices" banner so new device_ids get registered.
create or replace view public.v_unmapped_devices as
  select distinct e.device_id
  from public.laptop_events e
  left join public.devices d on d.device_id = e.device_id
  where d.device_id is null;
```
Also define up front (the dashboard promises domains + categories):
```sql
-- Per-person web time by domain (laptop URLs). Phone web stays a black box for now.
create or replace view public.v_person_web as
  select coalesce(d.person,'unmapped:'||e.device_id) as person,
         (e.ts at time zone 'Asia/Kolkata')::date as day,
         split_part(regexp_replace(e.url,'^https?://',''),'/',1) as domain,
         round(sum(e.duration_sec)/60.0,1) as minutes
  from public.laptop_events e
  left join public.devices d on d.device_id = e.device_id
  where e.source like 'web-%' and e.url is not null
  group by 1,2,3;
```
Categories: `laptop_events.category` is unpopulated, so v1 derives build/comms/AI/distraction
in the dashboard from a domain/app map (or scope-cut categories from v1).

**Retention:** `laptop_events` is thousands of rows/day × 2 laptops. Add a job to delete raw
events older than ~90 days once rolled into daily summaries (free tier = 500 MB). Low urgency
per your earlier call, but wire it before it's a problem.

`devices` is populated once with the 4 device_ids after each device first pushes.

---

## Dashboard (Next.js on Vercel) — v1 scope

- **Auth (hardened — both reviewers: the default is unsafe):** Supabase magic-link
  *auto-creates a user for any email*, so "is logged in" is NOT a gate. Enforce 3 ways:
  (1) **disable open signups** in the Supabase project; (2) **pre-create/invite exactly the
  2 founders** (invite-only); (3) a **server-side email-allowlist check on every read/action**
  (`session.user.email ∈ {A,B}` → else 403), not just at the layout. Optional belt:
  a Before-User-Created hook rejecting non-allowlisted emails.
- **Server-side reads, locked down:** one dedicated `lib/supabase/admin.ts` that imports
  `server-only`, holds the **secret key** (`SUPABASE_SECRET_KEY` / `sb_secret_…`, not
  `NEXT_PUBLIC_*`), `runtime='nodejs'`. Never imported by any `"use client"` file or Server
  Action without a session check first (service/secret key bypasses ALL RLS → one stray import
  = total leak). Add a **CI grep** that fails the build if the key name appears in the client bundle.
- **Caching (App Router leaks by default):** every authed route → `export const dynamic =
  'force-dynamic'`, data fetches `cache:'no-store'`, response `Cache-Control: private, no-store`.
  Never a shared cache key for per-user data (would serve one founder's dash to the other / a CDN).
- **View safety:** person-aware views are created by `postgres` and **bypass RLS**; put them in
  a private schema OR `revoke all on … from anon, authenticated` so they're only reachable via
  the server's secret key.
- **Screens:**
  1. **Side-by-side (you vs co-founder)** — today + this-week: active hours, top apps, top
     domains, category split (build/comms/AI/distraction). The exact rollups already proven
     in analysis become the queries.
  2. **Trends** — per person over time (stacked categories).
  3. **Combined "team week"** — parallel, not ranked (avoid leaderboard dynamics).
- **Charts:** Recharts/visx. Data via the person-aware views.

---

## Failure modes

| Failure | Handling |
|---|---|
| Device pushes before being registered in `devices` | rows show under "unknown" until you add the mapping; dashboard surfaces an "unmapped device" hint |
| Her Linux is Wayland | `aw-watcher-window` gives no titles → use `awatcher` (flagged in setup guide) |
| service_role key leak | NEVER in client bundle / NEXT_PUBLIC; server-only env on Vercel; rotate if exposed |
| Non-founder hits the site | blocked by Supabase Auth email allowlist |
| Co-founder in a different timezone | `v_daily_rollup` hardcodes Asia/Kolkata; if she's elsewhere, day boundaries skew — confirm her TZ |
| Two people, same app/site | distinguished by device_id→person; no collision |
| Phone browser = "Chrome" black box | same limitation for her; app-level only until URL feature decided |

---

## Tests

- **Linux pusher:** transform/idempotency/cursor-advance-only-on-success/AW-down (mirror the
  PowerShell tests); run twice → no dup rows.
- **devices join:** rows map to correct person; unmapped device handled gracefully.
- **Dashboard auth:** non-allowlisted user cannot read; service_role absent from client bundle
  (grep the build output); per-person aggregates correct (her rows never appear under his name).
- **E2E:** both people's laptop+phone data appears correctly separated in the side-by-side view.

---

## NOT in scope (per user / deferral)

- Privacy toggle, granularity limits, redaction — explicitly skipped.
- Separate per-person DBs — rejected for shared.
- Phone browser-URL capture — separate pending decision (applies to both).
- OpenClaw/gbrain daily summaries — later phase.
- Real-time/streaming, native mobile dashboard app — batch + responsive web is enough.
- Tightening the anon-SELECT ingest posture — **re-reviewed (both reviewers rated it Critical
  for a 2-person DB); user explicitly re-accepted world-read** to avoid re-touching the working
  pipeline. Residual risk: anyone with the anon key (in the APK) can read both founders' data.
  The *dashboard* itself remains properly gated (service-role + auth); this only concerns the
  raw ingest tables. Revisit if the project ever goes beyond the two of you.

---

## Phasing / parallelization

```
Lane A (DB): devices table + person views          ── do first (small; gates dashboard person split)
Lane B (her onboarding): Linux AW + Py pusher + APK ── independent; parallel with A/C
Lane C (dashboard): Next.js on Vercel              ── needs Lane A; can be built on YOUR data first,
                                                      her data flows in once Lane B lands
```
Order: **A** (minutes) → then **B** and **C** in parallel.

## Decisions (resolved)
1. **Dashboard read/auth:** Supabase Auth (2 founder emails) + **service_role read server-side
   on Vercel** (never in client bundle). Ingest stays anon as-is. ✓
2. **Dashboard location:** new standalone folder + its own Vercel project/URL. ✓
3. **Co-founder timezone:** IST (same as you) — `v_daily_rollup` Asia/Kolkata stays. ✓
