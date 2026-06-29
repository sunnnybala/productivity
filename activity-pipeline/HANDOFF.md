# Activity Tracking — Project Handoff

A complete record of what was built, why, current state, known issues, and how to continue.
Written for a fresh agent/session with no prior context. **No secret values are in this file**
(see "Secrets & access" for where they live).

---

## 1. What this is

A two-person (founders) **activity-tracking system**. Each person's **laptop + phone**
activity is captured and pushed to one shared **Supabase** database; a **Next.js dashboard
on Vercel** shows both people side by side (time on laptop vs phone, top websites, top apps),
filterable by person and date range.

It grew out of a conversation about "how much time people actually spend working." The owner
is **Dhruv** (GitHub `sunnnybala`, Vercel team `firstflys-projects`); the co-founder is **Ria**
(stored in the DB as `person='cofounder'`, displayed as "Ria").

Repo (public): **https://github.com/sunnnybala/productivity**

---

## 2. Current live state (all working)

| Piece | Status | Where |
|---|---|---|
| Dhruv laptop → Supabase | ✅ live, scheduled | Windows Task "ActivityWatch Supabase Pusher" (daily 21:00 + logon) |
| Dhruv phone → Supabase | ✅ live | OnePlus 11R, ActivityPusher app, daily WorkManager |
| Ria laptop → Supabase | ✅ live | EndeavourOS (host `ukiyo`), systemd timer (set up by her agent) |
| Ria phone → Supabase | ✅ live | realme narzo 60, ActivityPusher app |
| Dashboard | ✅ live | https://dashboard-firstflys-projects.vercel.app (password-gated) |
| Public repo | ✅ pushed | github.com/sunnnybala/productivity |

---

## 3. Architecture

```
 Dhruv Windows laptop ─ ActivityWatch ─ push-activity.ps1 (Task Scheduler) ┐
 Dhruv Android (OnePlus) ─ ActivityPusher app (WorkManager daily)          │
 Ria Linux laptop ─ ActivityWatch ─ push-activity.py (systemd timer)       ├─► Supabase (Postgres)
 Ria Android (realme) ─ ActivityPusher app                                 ┘     project: activity-tracker
                                                                                 ref: myyfhbmydhkkqpqchcka
                                                                                 region: Mumbai (ap-south-1)
                                                                                       │
        Next.js dashboard on Vercel  ◄──────────────────────────────────────────────┘
          - password gate (cookie) ; service_role read server-side only
          - /api/data -> RPC dashboard_summary(person, from, to)
```

Every event row carries a unique `device_id`. A `devices` table maps `device_id → person`,
so multi-person needs **no app changes** — devices show up "unmapped" until registered.

---

## 4. Supabase (project `activity-tracker`, ref `myyfhbmydhkkqpqchcka`)

URL: `https://myyfhbmydhkkqpqchcka.supabase.co` · org "sunnnybala's Org" · region ap-south-1.
Schema/migrations are in `activity-pipeline/supabase/`.

**Tables**
- `laptop_events` — one row per ActivityWatch event. Columns: `id` (deterministic
  `device|bucket|ts` — NOT event_id; see §13/§14), `device_id`, `source` ∈ {`window`,`afk`,`web-<browser>`},
  `bucket`, `ts` (UTC), `duration_sec`, `app`, `title`, `url`, `category`(unused), `data`(jsonb).
- `phone_app_usage` — one row per app per local day. `id` (`device|date|package`), `device_id`,
  `usage_date`, `package`, `app_label`, `minutes`.
- `sync_state` — per `(device_id,bucket)` incremental cursor (`last_event_ts`).
- `devices` — `device_id`, `person` (CHECK in `('dhruv','cofounder')`), `kind`, `os`.
- `daily_summary` — Phase-2 stub (unused, for future OpenClaw summaries).

**Views** (read by the dashboard server only; revoked from anon/authenticated)
- `v_daily_rollup` — per (day [Asia/Kolkata], device_id, surface, source, app) minutes.
- `v_person_daily` — per person/day/surface; **laptop = source `window` only**; phone as-is.
  LEFT JOIN devices → unmapped devices show as `unmapped:<id>`.
- `v_person_web` — per person/day/domain (laptop `web-%` URLs).
- `v_unmapped_devices` — devices pushing but not in `devices`.

**RPC** `dashboard_summary(p_person, p_from, p_to)` → JSON {laptop_min, phone_min, sites[],
phone_apps[], laptop_apps[], days[]}. All aggregation server-side (avoids 1000-row cap).

**RLS posture (IMPORTANT, deliberate decision):** device ingest uses the **anon key**, which
has INSERT/UPDATE/SELECT on `laptop_events`/`phone_app_usage`/`sync_state`. This means anyone
with the anon key (it ships in the APK/configs) can READ all activity. Two independent reviews
rated this a real exposure; **the owner explicitly accepted it** (didn't want to re-touch the
working pipeline). The *dashboard* is separately gated (login + service_role). See §8.

---

## 5. Devices (registered)

| person | kind | os | device_id |
|---|---|---|---|
| dhruv | laptop | windows (host FirstFly) | `af768f5a-9e90-4142-b0fd-85f1251f7522` |
| dhruv | phone | android (OnePlus 11R) | `0f4d9b4e48c2f2a7` |
| cofounder (Ria) | laptop | linux (EndeavourOS, host ukiyo) | `221db3a0-dc7a-4c47-a325-c3ee783e9553` |
| cofounder (Ria) | phone | android (realme narzo 60) | `d613ea8b0f68f0c2` |

To register a new device after it first pushes (it'll appear in `v_unmapped_devices`):
```sql
insert into public.devices (device_id, person, kind, os)
values ('<id>','dhruv'|'cofounder','laptop'|'phone','<os>')
on conflict (device_id) do update set person=excluded.person, kind=excluded.kind, os=excluded.os;
```

---

## 6. Components

**Laptop pushers** (`laptop-pusher/push-activity.ps1` Windows; `co-founder/push-activity.py`
Linux/macOS — these are the canonical, identical-logic pushers). Read AW `/api/0`, incremental
via `sync_state` cursor (with 5-min overlap re-read), idempotent upsert (deterministic id +
`resolution=merge-duplicates`). Push window/afk/web-* (and `awatcher` for Wayland). Windows runs
via Task Scheduler (daily 21:00 + logon + catch-up); Linux via systemd user timer + `loginctl
enable-linger`. No permanent gaps (AW retains history; cursor backfills).

**Phone app** (`phone-app/`, Kotlin; built APK = `activity-pipeline/ActivityPusher.apk`).
Reads Android `UsageStatsManager.queryEvents` (NOT the aggregate API — see §7), sums real
foreground intervals per app, **last 7 local days** each run, days bucketed in **Asia/Kolkata**.
WorkManager daily job (`KEEP` policy). Creds (Supabase URL + anon key) entered in-app, stored in
SharedPreferences. Needs `PACKAGE_USAGE_STATS` (manual "Usage Access" toggle) + `QUERY_ALL_PACKAGES`
(for app names) + `INTERNET`. Phone captures **app-level only** (not which websites).

**Dashboard** (`dashboard/`, Next.js App Router, deployed to Vercel team `firstflys-projects`,
project `dashboard`). Stable URL **https://dashboard-firstflys-projects.vercel.app**.
- Auth: shared-password gate. `/api/login` checks `DASH_PASSWORD`, sets httpOnly+Secure+SameSite=strict
  cookie `auth=DASH_TOKEN` (1-year). `middleware.js` gates all routes; pages/route re-check the
  cookie (defense in depth). Vercel "Deployment Protection" is **disabled** so the app's own gate
  is the access control.
- Data: server components / `/api/data` read with the **service_role key (server-only, never in
  client bundle)** via `lib/db.js`; `force-dynamic` + `no-store` (no CDN caching of personal data).
- UI (`app/dashboard.js`, client): person tabs (Dhruv/Ria), date presets + custom range, KPI cards
  (laptop/phone/total), daily laptop+phone chart, breakdown panels (websites, laptop apps, phone apps).
  Display names map `cofounder→Ria`, `dhruv→Dhruv` (display only; DB value stays `cofounder`).

---

## 7. Bugs found & fixed (with cause)

1. **PowerShell 5.1 mangled non-ASCII titles** (®, em-dash) → Postgres 400. PS sends string
   bodies as Latin-1. Fix: send UTF-8 bytes (`[Text.Encoding]::UTF8.GetBytes`).
2. **Upsert failed with 42501 (RLS)** until SELECT policies added. `INSERT ... ON CONFLICT DO
   UPDATE` (merge-duplicates) needs SELECT under RLS even with `return=minimal`. A reviewer
   wrongly said "drop the SELECT policies" — that BREAKS ingest; verified empirically. Keep them.
3. **Phone over-counted ~2× (Jun 22 showed 62h/day).** `queryAndAggregateUsageStats` sums
   overlapping interval buckets. Fix: switched to `queryEvents` (sum real foreground intervals).
   This corrected EVERY day, not just the boundary day.
4. **Phone app names blank** (`com.whatsapp` not "WhatsApp"). Android 11+ package visibility.
   Fix: `QUERY_ALL_PACKAGES`.
5. **App crash on Android 8–9** — `unsafeCheckOpNoThrow` is API 29+. Fix: SDK-guarded
   (`checkOpNoThrow` below API 29).
6. **Next.js CVE-2025-29927** (middleware auth bypass) — was on 15.1.6. Fix: bumped to 15.5.x
   + re-check auth at the data layer (middleware alone is not a security boundary).
7. **Dashboard hardening:** Secure cookie flag, `Promise.allSettled` + error boundary, person
   from union of sources, exact public-path match, constant-time password compare.
8. **Date-range race condition** — clicking a preset then a custom date could let the slower
   (week) response overwrite the custom one ("28→29 showed 60h"). Server was correct. Fix:
   last-request-wins guard (`reqId` ref) discards stale responses.

---

## 8. Reviews done

Dual-model (Codex + independent Claude subagent), repeatedly:
- **Phone app review:** found the crash (C1) + wrong-day/idle timing + world-readable data.
- **Dashboard plan + code review:** found the CVE, auth-allowlist gaps, service_role handling,
  caching leaks, view RLS bypass — all fixed.
- Pattern that recurred: reviewers sometimes disagreed; **empirical verification settled it**
  (e.g., the "SELECT policy is unnecessary" claim was wrong — proven by a live 42501).

---

## 9. Known issues / open items / parked

1. **Laptop "active" time definition — UNRESOLVED.** Dashboard sums raw `window` foreground
   durations. This is HIGHER than ActivityWatch's AFK-intersected "active" time (one day measured
   293m raw vs 263m AFK-intersected vs 323m flooded). A **time-correctness audit sub-agent was
   started and then interrupted** — this question is NOT finished. Decide: is "active" raw-window,
   AFK-intersected, or flooded? Then make the view/RPC consistent. **Also verify no double-count**
   between `window` and `web-<browser>` durations (web events likely overlap window time; the
   dashboard currently keeps them as separate dimensions, which is probably correct, but confirm).
2. **`INGESTION-RULES.md` for Ria's agent — NOT written.** Was meant to be informed by the
   interrupted audit. Should capture: use AW's own device_id (don't generate), never write to
   `devices` from the pusher, tag web as `web-<browser>`, first run = full history, Asia/Kolkata
   day bucketing, events-not-aggregate for phone, idempotent deterministic ids. (Ria's agent
   already corrected itself to match the repo's canonical pusher — see its self-audit.)
3. **Dashboard password is a weak dictionary word + no rate limiting.** A Vercel Firewall
   rate-limit rule on `/api/login` was recommended but NOT added. Either strengthen the password
   (in Vercel env `DASH_PASSWORD`) or add the rule. (Actual password is shared out-of-band.)
4. **Freshness lag:** once-daily push means the current day is partial until the next run. Could
   bump pushers to hourly for a more "live" dashboard. (Owner chose once-daily.)
5. **Phone browser URLs — PARKED.** Phone captures app-level only ("Chrome 90m", not sites).
   Full URLs need an Android AccessibilityService (researched: doable but invasive/fragile, and
   per-URL minutes are only approximate). Domain-level alternative = a local VPN logger. Owner
   has not decided; left parked.
6. **OEM battery killers:** OnePlus (OxygenOS) + realme (ColorOS) aggressively kill background
   jobs and can revert battery exemptions. adb-set doze-whitelist/standby-bucket can be undone;
   recommend each person also set App → Battery → Unrestricted + lock in Recents in the UI.
   Self-healing (7-day phone window, cursor backfill) absorbs occasional misses.
7. **Anon-read exposure** (accepted) — see §4. Revisit if this ever goes beyond the two of them.

---

## 10. Secrets & access (values NOT here)

- **Supabase DB password:** `activity-pipeline/SECRETS.local.txt` (gitignored).
- **Supabase anon key:** in `laptop-pusher/config.json` / `co-founder/config.json` (gitignored)
  and baked into the APK at runtime via the app's settings.
- **Supabase service_role key:** not stored in a file. Retrieve via the logged-in CLI:
  `supabase projects api-keys --project-ref myyfhbmydhkkqpqchcka`, or the Supabase dashboard.
- **Dashboard password / token:** Vercel project env `DASH_PASSWORD` / `DASH_TOKEN` (and the
  password is shared with Ria out-of-band).
- **Tooling auth (all logged in on Dhruv's machine):** `supabase` CLI, `gh` (sunnnybala),
  `vercel` (scope firstflys-projects). JDK 21 + Android SDK at `~/android-sdk` for APK builds.

---

## 11. How to do common tasks (future agent)

- **Apply a DB migration:** add a file to `supabase/migrations/`, then
  `cd activity-pipeline && supabase db push --password <DB_PASSWORD from SECRETS.local.txt>`.
  (PostgREST may need ~30s to expose new functions/views — retry on 404.)
- **Query/verify data:** REST with the service_role key, e.g.
  `GET https://myyfhbmydhkkqpqchcka.supabase.co/rest/v1/<table>` with `apikey`+`Authorization`
  headers. Remember PostgREST caps responses at 1000 rows — aggregate via views/RPC.
- **Rebuild + redeploy dashboard:** `cd dashboard && npm run build` then
  `vercel deploy --prod --yes --scope firstflys-projects`. Env vars live in the Vercel project.
- **Rebuild the APK:** `cd phone-app && ~/gradle/gradle-8.9/bin/gradle assembleDebug`
  (needs `ANDROID_HOME=~/android-sdk`); output `app/build/outputs/apk/debug/app-debug.apk`.
- **Configure an Android phone over adb** (debug APK): install via `adb install`; on ColorOS/
  realme `appops set` and `run-as` writes are blocked, so configure creds by driving the UI
  (`uiautomator dump` for coords + `input tap`/`input text`) and grant Usage Access via the
  Settings toggle. Use `MSYS_NO_PATHCONV=1` in Git Bash so `/sdcard/...` isn't path-mangled.
- **PowerShell gotchas seen:** `&`/`|` in double-quoted strings break PS 5.1 (use `-f` with
  single-quoted templates); `$var:` needs `${var}`; no `??`; `Invoke-WebRequest` needs
  `-UseBasicParsing` headless.

---

## 12. File map (`activity-pipeline/`)

- `PLAN-activity-pipeline.md` / `.html` — original Phase-1 plan (+ simple HTML version).
- `PLAN-phone-web-tracking.md` — phone browser-URL (accessibility) plan (parked).
- `PLAN-cofounder-shared-dashboard.md` — multi-person + dashboard plan (built).
- `CO-FOUNDER-SETUP.md` / `co-founder-setup.html` — Ria's onboarding guide.
- `laptop-pusher/` — Windows PowerShell pusher + config example.
- `co-founder/` — Linux Python pusher + config (for Ria).
- `phone-app/` — Android app source; `ActivityPusher.apk` (built).
- `supabase/` — schema.sql + migrations.
- `dashboard/` — Next.js dashboard app.
- `SECRETS.local.txt` — DB password (gitignored).
- `INGESTION-RULES.md` — correctness contract for any agent/script pushing events.
- `HANDOFF.md` — this file.

---

## 13. Time-correctness audit (2026-06-29) — fixes applied

Ran two sub-agents (AW event semantics + pipeline audit) plus direct DB verification.

- **afk duplication bug (FIXED).** Row id was `device|bucket|event_id|ts`. ActivityWatch
  reassigns `event_id` on every read of a still-growing idle event, so each read inserted a
  NEW row → one idle period became dozens of overlapping rows (saw 139h of "afk" in a 24h
  day). Window events were unaffected (stable ids). Fix: id is now `device|bucket|ts` in both
  pushers; migration `...000400` deduped history (kept MAX duration per natural key, 0 dupes
  left) and added a monotonic-duration guard trigger. See `INGESTION-RULES.md` rule 4.
- **Laptop metric is now BOTH numbers.** Headline = **focused** (raw window foreground);
  secondary = **active** (`window ∩ not-afk`). On real data, active ≈ 50% of focused (range
  15-83%/day) because AW's afk is keyboard/mouse only — reading/calls/watching show as the
  gap. RPC `dashboard_summary` returns `laptop_min` (focused) + `laptop_active_min`; the
  dashboard shows both (KPI sub-line + split daily bar). Migrations `...000200/000300/000500`.
- **`v_daily_rollup` footgun documented.** Summing across `source` triple-counts
  (window+afk+web). Use `v_laptop_active` for active; comment added on the view.
- **Phone monotonic merge (FIXED).** Trigger keeps `GREATEST(old,new)` minutes per
  (device,date,package) so a retention-edge re-read can't lower a good day. Migration `...000200`.
- **Verified clean:** no window+web or window+afk double-count in any shipped surface;
  timezones aligned IST end-to-end; laptop dedup idempotent; both numbers verified against
  day-clipped merged-interval ground truth.

---

## 14. Token spend tracking (2026-06-29) — Claude Code + Codex

Plan: `PLAN-token-spend.md` (eng-reviewed + Claude outside-voice review; Codex kept stalling).

- **What:** per-person AI token usage in the dashboard's new **Tokens** view (day/week/month/
  all-time), sourced from `ccusage` on each laptop. Reuses the activity rails.
- **DB:** `token_usage` table (migration `...000600`) + `token_summary(person,from,to,bucket)`
  RPC + `tu_sel` policy (`...000700`, the same ON-CONFLICT-needs-SELECT lesson). `v_unmapped_devices`
  extended to cover token-only devices. Monotonic-max trigger guards partial re-reads.
- **Pusher:** `token-pusher/push-tokens.ps1` (Windows) + `co-founder/push-tokens.py` (Linux).
  Runs `ccusage daily --json --timezone Asia/Kolkata --offline`; allowlist tags tool
  (openclaw/synthetic/unknown dropped); id = `device|usage_date|model`; reuses the activity
  `config.json` + device_id. `-Full`/`--full` backfills; default = trailing 45-day window.
  Windows Task Scheduler job "Token Spend Pusher" daily 21:05.
- **Dashboard:** `app/ui.js` (shared primitives: generic `RankList`, `fmtTokens`/`fmtUSD`),
  `app/tokens.js` (Tokens view), `app/api/tokens/route.js`, `app/view-switch.js` (Activity|Tokens
  toggle). Activity view refactored onto the shared UI (DRY).
- **Decisions:** track Claude Code + Codex (OpenClaw excluded — dormant); tokens headline, $
  shown as labeled **notional**. ccusage `--live` is gone (v18); `claude-monitor` is the live tool.
- **Verified:** backfill pushed 76 rows; claude-code 1.73B/$2,169, codex 667M/$457, all-time
  2.40B/$2,626; RPC + auth confirmed; both numbers track the manual ccusage run.
- **Gotcha logged:** `& npx @array` splatting breaks npx on Windows ("could not determine
  executable") — call npx as a native token-by-token command instead.

---

## 15. Ambient "today" view + widgets (2026-06-30)

Goal: glanceable today stats (Laptop time, Phone time, Tokens + notional $) without opening the
dashboard. Plan + Codex review: `PLAN-phone-ambient.md`.

- **`/ambient` page** (`app/ambient/page.js`): token-authed (`?k=`), big dark auto-refreshing
  stats. `?w=1` renders a **compact** top-left layout that fits a small widget tile (the full
  layout only showed a top-left crop inside small web-widgets). `?person=` selects whose data.
- **`/api/ambient.json`** (`app/api/ambient.json/route.js`): compact JSON for widgets —
  `{person,date,laptop_min,phone_min,tokens,cost, laptop_fmt,phone_fmt,tokens_fmt,cost_fmt}`
  (preformatted strings so dumb widgets need no math). Token-authed; in middleware `PUBLIC`
  (route handler is the auth boundary). Both `/ambient` and the route share `lib/ambient.js`
  (`ambientTokenOk` + `getAmbientSummary` + headers) — single source of truth (Codex DRY fix).
- **Auth:** `AMBIENT_TOKEN` env (Vercel), fail-closed (require len≥32). Security headers on both
  surfaces (`no-store`, `no-referrer`, `noindex`). Token lives only in device config, never a
  public file (no PWA manifest). Rotate `AMBIENT_TOKEN` to revoke.
- **Laptop widget (Windows / Dhruv): Rainmeter** — skin in `rainmeter/Ambient/Ambient.ini`
  (WebParser, no plugin; reads the JSON's `*_fmt` fields). Installed + verified fetching live
  data; bottom-right, on-desktop (behind windows), auto-starts on login. Token is a placeholder
  in the repo copy; real token only in `Documents\Rainmeter\Skins\Ambient\Ambient.ini`.
- **Laptop widget (Linux / Ria): Conky** (Rainmeter is Windows-only) — config + fetch script in
  `CO-FOUNDER-SETUP.md` §6a. Wayland caveat noted (eww/plasmoid alternative).
- **Phone widget (both): AnyWidget** ("website as widget") pointed at `/ambient?...&w=1`. ColorOS
  battery whitelist required.

---

## 16. Focused vs active time + AFK timeout (2026-06-30)

**Definitions (ActivityWatch):**
- **Focused / window time** = a window was in the foreground, **regardless of input**. Counts
  overnight, while reading, while watching, while away (screen on).
- **Active time** = focused **∩ not-afk**, where `aw-watcher-afk` watches keyboard+mouse and flips
  you to "afk" after a no-input timeout. **AFK is backdated to your last input** — when the timeout
  fires, the whole silent stretch (including those first minutes) is marked idle, from the last
  keystroke. The timeout is a detection delay, NOT a grace period you keep.

**AFK timeout changed 180s → 300s (5 min) on Dhruv's laptop** (`%LOCALAPPDATA%\activitywatch\
activitywatch\aw-watcher-afk\aw-watcher-afk.toml`: uncommented `timeout = 300`, restarted AW).
- **Forward-only** (past events keep their 180s classification).
- Effect is **small**: raising the cutoff only rescues idle gaps *between* 3 and 5 min (+~3–40
  min/day in simulation). The big focused-vs-active gap is dominated by **long** idle — laptop
  on ~24/7 + multi-minute stretches of watching Claude Code run / reading (no typing >5 min),
  which the cutoff doesn't touch. Focus is unchanged by the timeout.
- **Ria:** to match, set `timeout = 300` in her `aw-watcher-afk.toml` and restart AW. Note: on a
  **Wayland** session the afk watcher can under-detect input, making her active artificially low
  regardless (see CO-FOUNDER-SETUP §7).

**What the dashboard/widgets show:** laptop **focused** (not active). Phone usage is foreground
time (Android has no afk concept) → comparable to laptop **focused**, not active. So focused↔phone
is the apples-to-apples comparison; showing focused is deliberate.

**Considered + declined (2026-06-30):** marking apps "always active" / a media watcher (would make
watching-Claude count as active). User chose to keep it strict.
