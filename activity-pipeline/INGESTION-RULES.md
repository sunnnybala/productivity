# INGESTION-RULES.md — how to capture & send activity events so the time stays correct

This is the contract for **any agent or script that pushes activity data** into the shared
Supabase DB (laptop pusher, phone app, or anything new). It exists because we found real
ways the numbers can silently drift. Follow these exactly. If you change a pusher, re-check
this list.

The DB is shared by both co-founders. A bug on one machine corrupts the other person's
dashboard too. Treat these as invariants, not suggestions.

---

## The mental model (read this first)

Three clocks, measured separately, that **overlap in wall-clock time**:

| Surface | The ONE correct measure | Never do this |
|---|---|---|
| **Laptop active** | `window` events **∩** `not-afk` periods, summed per IST day | Don't sum raw `window` (counts idle-but-focused). Don't add `web` or `afk` to it. |
| **Laptop web** | `web-<browser>` events grouped by domain — a *drill-down inside* browser time | Never add web minutes to the laptop total (it double-counts the same seconds). |
| **Phone** | per-app foreground intervals (resume→pause) from `queryEvents`, per IST day | Don't use `queryAndAggregateUsageStats` (sums overlapping buckets → ~2× overcount). |

**Golden rule: never sum across `source`.** `window`, `afk`, and `web-*` are three views of
the same time. Active = `window ∩ not-afk`. Web = `web-*` only. `afk` exists *only* to feed
the intersection — it is never added to a total. The DB now enforces the laptop side via the
`v_laptop_active` view; don't bypass it with `sum(duration) where source='window'`.

---

## Laptop pusher rules

1. **Pin a stable `device_id`.** Set it once in `config.json` (`device_id` override) and never
   let it auto-change. If ActivityWatch's device_id changes (reinstall, AW DB reset, new
   machine), the pusher re-reads ALL history under a new key → the same activity is stored
   twice, and the device drops out of your totals until it's registered. Pin it.

2. **Register every device in the `devices` table before trusting its totals.** The dashboard
   RPC (`dashboard_summary`) inner-joins `devices` — an unregistered device is **invisible**.
   After a machine's first push, check `select * from v_unmapped_devices;` and add a row to
   `devices (device_id, person, kind, os)`.

3. **Send timestamps in UTC** (ISO-8601 with offset, e.g. `2026-06-29T03:14:00Z`). The DB
   converts to `Asia/Kolkata` for day bucketing. Sending local/naive time corrupts day
   boundaries.

4. **Row id MUST be `device|bucket|ts` — do NOT include ActivityWatch's `event_id`.**
   Upsert with `Prefer: resolution=merge-duplicates`. This was a real bug: AW reassigns the
   `event_id` on every read of a still-growing idle (afk) event, so an id containing
   `event_id` made a NEW row each read instead of updating — one idle period ballooned into
   dozens of overlapping rows (139h of "afk" in a 24h day). The event start `ts` is the stable
   natural key within a bucket. Never put `event_id` in the id.

4b. **De-dupe rows by id WITHIN each upsert batch (keep max duration) before sending.** AW
   returns the open afk event many times with the SAME timestamp (we saw 80 events → 7 distinct
   timestamps, one repeated 47×). Under the `device|bucket|ts` id those collapse to duplicate ids
   in one batch, and PostgREST rejects the whole batch with a 500 (`ON CONFLICT DO UPDATE cannot
   affect a row a second time`) — so afk silently stops landing and "active" reads 0. Collapse
   same-id rows (keep the largest duration) in the pusher before the POST. Both pushers do this.

5. **Re-read with a ≥5-minute overlap before the cursor.** ActivityWatch's last (open) event
   keeps growing — its `duration` extends via heartbeats while its `ts` stays fixed. The
   overlap re-read lets that final duration land. Only advance the cursor to `max(ts)` of a
   **fully successful** batch; on any failure, hold the cursor and retry.

6. **Tag `source` precisely:** `window`, `afk`, or `web-<browser>` (e.g. `web-firefox`,
   `web-chrome`). Keep them distinct — never pre-merge.

7. **Always send `data.status` on afk events** (`afk` / `not-afk`). The active-time
   intersection (`v_laptop_active`) depends on it. An afk event with no status is useless.

8. **UTF-8 everything.** Encode the request body as UTF-8 bytes explicitly. (PowerShell 5.1
   defaults to Latin-1 and silently corrupts non-ASCII window titles → Postgres 400s. The
   Windows pusher already sends `[Text.Encoding]::UTF8.GetBytes($body)`; match that in any new
   sender.)

---

## Phone app rules

9. **Use events, not aggregates.** Compute per-app foreground time from `queryEvents`
   (`MOVE_TO_FOREGROUND` → `MOVE_TO_BACKGROUND`), pairing each resume with its next pause and
   summing the intervals. `queryAndAggregateUsageStats` over-reports (it sums overlapping
   buckets — that's the old 62h/day bug).

10. **Bucket days in `Asia/Kolkata`**, id = `device|usage_date|package`, upsert with
    `merge-duplicates`.

11. **Re-reads heal upward, never downward.** The DB has a trigger
    (`phone_usage_keep_max`) that keeps `GREATEST(old, new)` minutes per (device, date,
    package). This is deliberate: a fresh read of a day is accurate, but the same day re-read
    later — near Android's ~7-day raw-event retention edge — is under-counted. Monotonic merge
    stops the bad read from overwriting the good one. **Do not "fix" this trigger to a plain
    overwrite.** (Tradeoff: legitimate downward corrections are blocked — correct for
    monotonic daily usage.)

12. **Run more often than once a week.** UsageStats raw events live only ~a few days. A day
    with no successful upload before its events are evicted is permanently lost (platform
    limit, not fixable in code). The 7-day re-upload window is the self-heal; keep it, but make
    sure the worker actually runs (OEM battery killers on realme/ColorOS will silently stop it
    — whitelist the app).

13. **Midnight carry-in is a known minor undercount.** An app already foreground at 00:00
    (resumed yesterday) loses its 00:00→first-event slice, because `queryEvents(start,end)`
    has no resume inside the window. Low magnitude; fix when convenient by seeding from the
    last event before `start`.

---

## Cross-cutting

14. **Don't sum two devices' time as deduplicated wall-clock.** Phone + laptop overlap in real
    time (you use both at once). The "Σ Total" is *combined device time*, not a person's unique
    awake-and-working time. Label it as such; don't claim it's one or the other.

15. **The dashboard reads via the service-role key only.** Devices use the anon key and may
    WRITE the ingest tables but not READ them. Don't hand the service-role key to a device
    pusher.

---

## Token-spend rules (Claude Code + Codex via ccusage)

16. **One command, allowlist tagging.** Use `ccusage daily --json --timezone Asia/Kolkata
    --offline` (it already includes ALL agent CLIs). Tag each `modelBreakdowns[]` row by an
    explicit allowlist: `openclaw` → DROP, `gpt`/`codex` → `codex`, `claude`/`opus`/`sonnet`/
    `haiku`/`fable` → `claude-code`, anything else (`<synthetic>`, empty, other agents) → DROP.
    Never tag by a default-to-claude fallback.
17. **Row id = `device|usage_date|model`** (NOT including `tool` — it's derived from model and
    would create a duplicate if reclassified). Upsert `resolution=merge-duplicates`.
18. **Reuse the activity `device_id`** (from `config.json`, else AW `/info`) so token rows map
    to the same person via `devices`. Register the device first (`v_unmapped_devices` now also
    covers token-only devices).
19. **`--timezone Asia/Kolkata`** so day boundaries match laptop/phone. **`--offline`** so a
    pricing fetch can't hang a scheduled run.
20. **Backfill once with `-Full` / `--full`; scheduled runs use the trailing 45-day window**
    (`--since`). Past days are immutable; bounding the re-push avoids re-touching old rows if a
    future ccusage renames models. A monotonic-max trigger also stops a partial re-read from
    lowering a day.
21. **$ is notional.** ccusage prices tokens at API list rates; on a subscription it's value
    extracted, not a bill. Never present it as real spend.

## Quick self-check before trusting a new number

- Did a new device show up in `v_unmapped_devices`? → register it.
- Does laptop active look ~10-15% lower than raw window? → correct, that's the AFK exclusion.
- Did a phone day's minutes drop between two views? → shouldn't happen now (monotonic trigger);
  if it does, the trigger is missing.
- Are web minutes being added to the laptop total anywhere? → bug, they must stay separate.
