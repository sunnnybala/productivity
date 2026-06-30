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
Then schedule it via a systemd timer — see `CO-FOUNDER-SETUP.md` §2.5. Notes: `$` figures are
**notional** (API-equivalent, not a bill); OpenClaw is excluded by design.

---

## 3. Make it fresh — match Dhruv's cadence

Dhruv runs **activity every 5 min** and **tokens every 30 min** so the dashboard/widgets are
near-live. Set your systemd timers to match:
- activity (`aw-push.timer`): `OnCalendar=*:0/5:00`
- tokens (`token-push.timer`): `OnCalendar=*:0/30:00`

Both with `Persistent=true`. Then `systemctl --user daemon-reload && systemctl --user restart
aw-push.timer token-push.timer`. (Phone stays daily — same as Dhruv.)

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

---

## 6. Ambient "today" widgets (new) — laptop box + phone tile

A small always-visible box showing today's Laptop / Phone / Tokens(+$). Both read
`GET /api/ambient.json?k=<AMBIENT_TOKEN>&person=cofounder` (ask Dhruv for the token).

- **Laptop (EndeavourOS):** Rainmeter is **Windows-only**, so use **Conky** instead (the Linux
  desktop-widget equivalent), pulling the same endpoint. Full config + script in
  `CO-FOUNDER-SETUP.md` §6a. (Wayland session → use eww/a KDE plasmoid, or an X11 session; check
  `echo $XDG_SESSION_TYPE`.)
- **Phone:** you already have the AnyWidget set up — it was showing only the top-left corner
  because the page was full-screen-sized. Fix: change the widget URL to add **`&w=1`** (compact
  layout that fits a small tile): `…/ambient?k=<AMBIENT_TOKEN>&person=cofounder&w=1`. Apply the
  ColorOS battery whitelist so it keeps refreshing.

`$` is notional (not a bill). Phone shows ~0 until the nightly phone upload.

---

## 7. (Optional) Match the AFK timeout

Dhruv changed the ActivityWatch AFK timeout from 3 min → **5 min** (affects the "active" laptop
number only; "focused" is unchanged). To match, set `timeout = 300` in her
`aw-watcher-afk.toml` and restart AW — steps in `CO-FOUNDER-SETUP.md` §7. Low priority; the
dashboard headline shows **focused** time anyway, and on Wayland the afk/active signal is
unreliable regardless.
