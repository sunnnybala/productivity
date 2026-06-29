# Update for Ria's laptop + phone (2026-06-29)

Hand this to Ria's AI agent. Repo: `github.com/sunnnybala/productivity`, work in `activity-pipeline/`.
Two things changed since you set up: (1) a **time-calculation fix** you must pull, and (2) two
new features — **token-spend tracking** and an **ambient wallpaper page**.

Current status (verified from the shared DB): your laptop's last activity push was ~03:27 IST
(stale), and you have **no token data yet**. Both are fixed by the steps below.

---

## 1. Pull the fixes (required)

```bash
cd <repo>/activity-pipeline
git pull
```

This brings two fixes to the activity pusher (`co-founder/push-activity.py`) plus the new
token pusher and docs. **Make sure the pusher you actually run is this pulled version.**

### Why (so you understand what to verify)
- The row id must be `device|bucket|ts` — **never include ActivityWatch's `event_id`.** AW/awatcher
  reassign the event id on every read of a growing idle event, which created duplicate "afk" rows
  (we saw 139h of idle in a 24h day). Confirm the id line in `push-activity.py` is:
  `"%s|%s|%s" % (device_id, b, e["timestamp"])` — with **no `e.get("id")`**.
- AW returns the open afk event many times with the **same timestamp** (one was repeated 47×).
  Under the new id those collapse to duplicate ids in one batch and PostgREST returns 500 (the afk
  push silently fails → "active" reads 0). The pulled pusher fixes this by **de-duping rows by id
  (keep max duration) before upserting** — confirm that block is present.
- Read `INGESTION-RULES.md` and follow it. Especially: always send `data.status` on afk events
  (`afk` / `not-afk`) — the "active time" number depends on it.

### Verify the activity pusher works
```bash
python3 push-activity.py
```
Expect all buckets to push with **no "afk: FAILED ... 500"**. Then your active time will populate.

---

## 2. Add token tracking (new "Tokens" dashboard view)

Tracks Claude Code + Codex token usage from your local `~/.claude` and `~/.codex` logs via `ccusage`.

```bash
# needs Node/npx:  npx --version
cp co-founder/push-tokens.py .            # if not already pulled in place
python3 push-tokens.py --full             # one-time backfill; expect "Done. Pushed N token rows."
```
Then schedule it (and ideally re-schedule the activity pusher) to run **hourly** so the dashboard
stays fresh — exact systemd timer unit files are in `CO-FOUNDER-SETUP.md` §2.5 (use `OnCalendar=hourly`
or `*-*-* *:05:00`). Notes: `$` figures are **notional** (API-equivalent, not a bill); OpenClaw is
excluded by design.

---

## 3. Make it fresh (hourly) — important

For both pushers, prefer an **hourly** schedule (not once-a-day), or the dashboard/wallpaper shows
stale numbers for hours. systemd timer with `OnCalendar=*-*-* *:00:00` + `Persistent=true`.

---

## 4. Verify (report these back)

- `push-activity.py` runs with no afk 500.
- `push-tokens.py --full` pushed rows.
- Nothing appears in `v_unmapped_devices` for your devices.
- Your numbers show on the dashboard (Activity + Tokens tabs).

---

## 5. Ria does by hand (no agent needed)

**🖥️ Laptop wallpaper** — install Lively Wallpaper (free), + Add Wallpaper, paste:
```
https://dashboard-five-beta-46.vercel.app/ambient?k=<ASK DHRUV FOR THE TOKEN>&person=cofounder
```
**📱 Phone** — open that same link in Chrome → ⋮ → Add to Home screen (a quick 3-stat glance:
laptop time, phone time, tokens). For the full interactive dashboard instead, open
`https://dashboard-five-beta-46.vercel.app`, enter the shared password once, then Add to Home screen.

**📱 Phone activity app** — already set up; nothing new (token tracking is laptop-only).

(Dhruv: paste the real `?k=` token into the link above before sending — it's the shared ambient secret.)
