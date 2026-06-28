# Plan: Phone browser URL/time tracking (Accessibility) → Supabase

**Goal:** Capture which **URLs** are open in Chrome/Brave on the phone and **how long**,
and push to Supabase — so phone browser time (fanfiction, etc.) is visible alongside
laptop web data. Reading happens in the browser, not a reading app, so app-level
("Chrome 149 min") is not enough.

**Approach chosen:** add a scoped **AccessibilityService** to the existing ActivityPusher
app (NOT a second app; NOT the VPN/domain route). Rationale: the user wants full URLs,
which only Accessibility provides. Domain-only via VPN was considered and rejected
(see NOT in scope) because it can't give the page path.

**Accuracy expectation (set upfront):** domain-level minutes = reliable; full-path
per-URL minutes = good estimate, not ground truth (no scheme; search-terms sometimes
shown instead of URL; single-page apps undercounted; gaps when OS throttles the service).
This is inherent to the technique, confirmed against ActivityWatch's own implementation.

---

## Step 0 — Scope challenge (reuse, don't rebuild)

**What already exists:**
- **Our ActivityPusher app** — already has the Supabase client, WorkManager upload, prefs,
  device id, the upload pattern. We ADD one component (an AccessibilityService) + one table.
- **ActivityWatch aw-android `ChromeWatcher.kt`** — the reference implementation of this exact
  technique. We borrow its proven parts (read `…:id/url_bar`, dedupe on URL change, flush on
  leaving the browser) and FIX its known weaknesses (no typing filter, no screen-off close,
  ballooning intervals).
- **Existing Supabase project + RLS pattern** — add one table mirroring `phone_app_usage`.

**Minimum change set:** 1 AccessibilityService + 1 local session store + 1 new Supabase
table + reuse the existing uploader. ~150-200 lines. No new app, no VPN, no server.

---

## Architecture

```
 Chrome/Brave foreground
        │  (accessibility events: WINDOW_STATE_CHANGED + WINDOW_CONTENT_CHANGED)
        ▼
 BrowserUrlAccessibilityService   (scoped: packageNames = chrome, brave ONLY)
        │  read node …:id/url_bar  → candidate URL
        │  Sessionizer (in-memory): dedupe, typing-filter, debounce, cap, close-on-*
        ▼  completed session {url, start, duration}
 Local store (Room/SQLite: web_sessions)   ← survives process death
        │
        ▼  existing WorkManager daily upload (+ on app open)
 Supabase  phone_web_sessions   (idempotent upsert)
        │
        ▼  view v_phone_web_daily  (per day per url / per domain minutes)
```

**Privacy boundary:** the service is configured with `packageNames="com.android.chrome,
com.brave.browser"` so Android delivers events from ONLY those two apps — never your bank,
WhatsApp, etc. From each event we read exactly one node (the URL bar) and nothing else.
Only `{url, minutes, date}` leave the device. Optional: strip query strings (`?...`) so
tokens/search terms are never stored.

---

## The sessionization algorithm (the hard part — derived from research + ActivityWatch fixes)

1. **Subscribe** to `TYPE_WINDOW_STATE_CHANGED` + `TYPE_WINDOW_CONTENT_CHANGED` only
   (NOT `TYPE_VIEW_TEXT_CHANGED` — that's the per-keystroke firehose). `notificationTimeout≈100ms`,
   flags `flagReportViewIds|flagRetrieveInteractiveWindows`, `canRetrieveWindowContent=true`.
2. On an event from a browser package, read `…:id/url_bar`. **Skip** the read if:
   - node absent/empty (toolbar hidden on scroll), OR
   - node `isFocused`/`isEditable` (user is typing in the omnibox), OR
   - text isn't URL-shaped (no dot / has spaces / not parseable).
3. **Debounce** ~500ms; take the settled value as `candidateUrl`.
4. If `candidateUrl != currentUrl`: **flush** the previous URL —
   `duration = min(now − currentStart, CAP)` (CAP ≈ 30-60 min) → write a session row;
   then `currentUrl = candidateUrl`, `currentStart = now`.
5. **Force-close** the open session on ANY of:
   - foreground package leaves the browser (WINDOW_STATE_CHANGED to launcher/other app),
   - `SCREEN_OFF` / device lock (a `BroadcastReceiver`),
   - idle/AFK timeout (no events for N minutes).
   This is what prevents the **ballooning-interval bug** (ActivityWatch's weak point):
   never leave an interval open relying on the next URL event to close it.
6. (Optional enrich) read the WebView title node after load for a human label + to notice
   single-page-app navigations the URL bar misses.

---

## Supabase schema (additive)

```sql
create table if not exists public.phone_web_sessions (
  id           text primary key,            -- device|start_epoch_ms|url  (deterministic)
  device_id    text not null,
  ts           timestamptz not null,         -- session start (UTC)
  day          date not null,                -- local day (Asia/Kolkata)
  url          text not null,
  domain       text not null,                -- parsed host, for easy rollups
  duration_sec numeric not null,
  captured_at  timestamptz not null default now()
);
create index if not exists pws_day_idx on public.phone_web_sessions (day);
-- RLS: same pattern as phone_app_usage (anon insert+update+select; accepted world-read).

create or replace view public.v_phone_web_daily as
  select day, device_id, domain, url, round(sum(duration_sec)/60.0,1) as minutes
  from public.phone_web_sessions group by 1,2,3,4;
```

Idempotent: deterministic `id` + merge-duplicates upsert (same as the rest of the pipeline).

---

## Failure modes (each: handled? silent?)

| Failure | Handling |
|---|---|
| Screen off / browser killed mid-session | Session force-closed by SCREEN_OFF receiver + duration CAP → no ballooning |
| User typing partial URLs (a, ar, arc) | Skipped (node focused/editable + URL-shape filter) |
| Scroll hides toolbar (node disappears) | Empty read ignored; dedupe on unchanged URL |
| **Accessibility permission revoked by OEM battery optimization (silent stop)** | App checks `isAccessibilityServiceEnabled` on open + shows status; user re-enables. THE main reliability risk (same OnePlus battery issue, worse). |
| SPA in-page nav (YouTube/Gmail) | Undercounted — accepted limitation |
| Incognito | Never captured (Android blocks) — accepted |
| Local store survives process death | Sessions written to SQLite immediately on flush, not held in memory until upload |

No failure mode is silent + data-losing within normal operation (sessions persist locally;
upload is idempotent/incremental like the rest of the pipeline).

---

## Tests

- Sessionizer (unit, pure logic): typing-filter drops partials; dedupe on same URL; flush
  on URL change with correct duration; **cap** applied; **screen-off closes** the session;
  **foreground-leave closes** it; idle timeout closes it.
- URL parsing: domain extraction; query-string stripping (if enabled); non-URL rejection.
- Upload idempotency: same sessions uploaded twice → no duplicate rows.
- Instrumented: AccessibilityService receives browser events; permission-revoked path shows status.

---

## NOT in scope

- **VPN/domain route (RethinkDNS-style)** — rejected; can't give full path, and we want URLs.
- **Incognito, SPA in-page navigation** — technically impossible via url_bar.
- **Browsers other than Chrome/Brave** — can add view-ids later (Firefox/Edge differ).
- **Full historical backfill** — accessibility only sees activity from when it's enabled.
- Tightening the anon world-read RLS — previously accepted as-is.

## Decisions to confirm

1. **Full URL vs domain-only capture** (privacy vs detail). User wants full URL; default to
   full URL **with query-string stripped** (keep `host/path`, drop `?token=...`). OK?
2. **Local store:** Room/SQLite (robust, survives death) vs a flat append file. Recommend SQLite.
3. **Upload cadence for web sessions:** piggyback the existing daily job (+ on app open) vs a
   more frequent job. Recommend daily + on-open (matches everything else).

---

## CROSS-MODEL REVIEW VERDICT (Codex + independent Claude reviewer)

**Both verdicts: technique correctly chosen (only way to full paths), but NOT sound to
implement as written.** Required changes before building:

**Consensus criticals:**
1. **Timing model is wrong for passive reading.** Closing on "no events for N min" and a
   30–60 min CAP both UNDERCOUNT long static reads (fanfiction = no events for 20+ min while
   actively reading). FIX: time by *state* — while screen ON + browser FOREGROUND = active,
   counted via periodic heartbeats; CAP becomes a safety bound (~2–3h) only for orphaned
   sessions, not normal reads.
2. **Open session is in-memory → lost on every service kill (the common case on OxygenOS).**
   "No silent data loss" was false. FIX: checkpoint `{url,start,lastHeartbeat}` to disk every
   ~15s; on restart, close dangling session at `lastHeartbeat`. (ActivityWatch heartbeat pattern.)
3. **Service survival on OxygenOS is make-or-break and under-mitigated.** OnePlus 5/5 worst-tier;
   power-saving turns accessibility OFF every 1–2h; settings revert randomly. FIX: foreground
   service + ongoing notification; heartbeat; a WorkManager watchdog that ALERTS on silent death;
   battery hardening checklist in-app; periodic re-check. Even then expect 1–2h gaps.
4. **Raw full URLs must NOT be world-readable** (more sensitive than app totals). FIX: insert-only
   table, no anon SELECT; upload only un-synced rows from a local outbox via plain INSERT (avoids
   the ON-CONFLICT-needs-SELECT problem entirely); reads locked to service_role.

**Other required fixes:**
5. **Install via `adb install` only** — Android 13+ "Restricted Settings" blocks enabling
   accessibility for file-manager-sideloaded APKs, and OxygenOS 15+ removed the workaround menu.
   adb (session) installs are exempt. (We already install via adb — keep it.)
6. **Filter on `isFocused`, NOT `isEditable`** — url_bar is an EditText so isEditable is always
   true; filtering on it would drop every read.
7. **Whitelist `com.android.systemui`/transient windows** — pulling the notification shade raises
   a WINDOW_STATE_CHANGED that would otherwise fragment every session.
8. **Hash the URL in the PK** (`device|start_ms|sha256(url)`), keep full url as a column —
   btree unique index caps at ~2704 bytes; real URLs exceed it.
9. **Outbox lifecycle:** `synced`/`uploaded_at` flag, upload only unsynced, prune after N days.
10. **Midnight split:** a 23:50→00:20 session must split at Asia/Kolkata midnight or it lands
    entirely on the wrong day.
11. **Honest privacy note:** `packageNames` scoping is OS-enforced (safe re other apps), BUT with
    `canRetrieveWindowContent=true` the service is *capable* of reading page content (incl. web
    login fields) within Chrome/Brave — "only url_bar" is code-discipline, not enforcement.
12. **Drop or rate-limit WINDOW_CONTENT_CHANGED** (battery firehose on dynamic pages); prefer
    WINDOW_STATE_CHANGED + low-freq self-poll. Measure battery on the real device.
13. Multi-window disambiguation (focused window only); Brave url_bar node UNVERIFIED — validate
    on the real OnePlus before locking schema.

**Reliability ceiling (both):** even implemented perfectly, OxygenOS will cause periodic gaps
and per-URL minutes remain approximate (domain-level reliable, full-path estimate).
