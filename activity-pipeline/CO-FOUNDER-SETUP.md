# Setup guide — connect your laptop + phone to our activity dashboard

👋 Hey! This connects your **Linux laptop** and your **Android phone** to a shared dashboard
so we can both see where our time goes (apps + websites). It's the same setup I'm running on
mine. Takes **~20 minutes** total.

**What you'll need from me first:** a **Supabase URL** + an **anon key** (I'll send both —
just two strings you paste in). Everything writes to one shared database; the dashboard reads
from it.

**Three parts:** (1) ActivityWatch on your laptop, (2) a tiny daily upload script, (3) the
phone app. At the end you'll send me your two **device IDs** so I can label your data as yours.

---

## 1. Her laptop — ActivityWatch on Linux

### 1a. Install ActivityWatch (EndeavourOS / Arch)
Her OS is **EndeavourOS (Arch-based)**, so use the AUR (cleanest, auto-updates):
```bash
yay -S activitywatch-bin        # or: paru -S activitywatch-bin
aw-qt &                         # launch the tray app
```
(Fallback: download the Linux zip from
https://github.com/ActivityWatch/activitywatch/releases and run `./aw-qt`.)
Confirm: open `http://localhost:5600`. Python 3 ships with Arch (`which python3`).

### ⚠️ 1b. Wayland caveat (check this first — likely relevant on EndeavourOS)
`aw-watcher-window` reads titles via X11. On **Wayland** it often **can't read window
titles/app names** — and EndeavourOS with KDE Plasma 6 defaults to Wayland.
- Check: `echo $XDG_SESSION_TYPE` → `x11` (fine) or `wayland` (needs the fix below).
- If Wayland, install the Rust watcher with Wayland support and use it instead:
  ```bash
  yay -S awatcher        # https://github.com/2e3s/awatcher
  ```
  `awatcher` replaces aw-watcher-window and reports into the same AW server, so the pusher
  works unchanged. (Alternative: pick an "X11/Xorg" session at the SDDM login screen.)

### 1c. Browser extension
Install the **ActivityWatch Web Watcher** extension in whichever browser she uses
(Chrome/Chromium/Firefox on Linux all supported). Verify a `aw-watcher-web-*` bucket
appears at `localhost:5600`.

### 1d. Autostart
Add `aw-qt` to autostart so it launches on login:
`~/.config/autostart/aw-qt.desktop`:
```ini
[Desktop Entry]
Type=Application
Exec=/full/path/to/aw-qt
X-GNOME-Autostart-enabled=true
Name=ActivityWatch
```

---

## 2. Her laptop — the pusher (Linux, Python)

Your Windows pusher is PowerShell-only. Here's the **cross-platform Python port** (stdlib
only, no pip installs; handles UTF-8 natively so no Latin-1 bug). Save as `push-activity.py`
next to a `config.json`.

`config.json`:
```json
{
  "supabase_url": "https://<PROJECT-REF>.supabase.co",
  "supabase_anon_key": "<ANON-KEY>",
  "aw_base": "http://localhost:5600/api/0",
  "device_id": null
}
```
> After her first successful push, **pin the device_id**: copy the `device_id` the script
> prints into `config.json` (replacing `null`). ActivityWatch regenerates its device_id on
> reinstall/reset, which would otherwise create a second "unmapped" device and fragment her
> history. Pinning keeps it stable, and you register that one id in the `devices` table.

`push-activity.py` *(this mirrors the canonical `co-founder/push-activity.py` in the repo —
prefer **copying that file** after `git pull` so it never drifts from the fixes)*:
```python
#!/usr/bin/env python3
# Laptop -> Supabase activity pusher (Linux/macOS). Incremental + idempotent.
import json, os, sys, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
AW  = cfg.get("aw_base", "http://localhost:5600/api/0")
SB  = cfg["supabase_url"].rstrip("/"); KEY = cfg["supabase_anon_key"]; BATCH = 500

def aw_get(path):
    with urllib.request.urlopen(AW + path, timeout=60) as r: return json.load(r)

def sb(method, path, body=None, prefer=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(SB + "/rest/v1/" + path, data=data, method=method)
    req.add_header("apikey", KEY); req.add_header("Authorization", "Bearer " + KEY)
    req.add_header("Content-Type", "application/json")
    if prefer: req.add_header("Prefer", prefer)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read().decode("utf-8"); return json.loads(t) if t.strip() else None

def source_of(b):
    if "window" in b: return "window"
    if "afk" in b: return "afk"
    if "web-" in b: return "web-" + b.split("web-")[1].split("_")[0]
    return b

try: info = aw_get("/info")
except Exception: print("AW not reachable; retry next run"); sys.exit(0)
device_id = cfg.get("device_id") or info["device_id"]
now = datetime.now(timezone.utc); now_iso = now.strftime("%Y-%m-%dT%H:%M:%S+00:00")
buckets = [b for b in aw_get("/buckets/").keys()
           if any(k in b for k in ("window", "afk", "web-", "awatcher"))]  # catches awatcher (Wayland)
grand = 0
for b in buckets:
    src = source_of(b)
    q = ("sync_state?device_id=eq.%s&bucket=eq.%s&select=last_event_ts"
         % (urllib.parse.quote(device_id), urllib.parse.quote(b)))
    rows = sb("GET", q) or []
    cursor = rows[0]["last_event_ts"] if rows and rows[0].get("last_event_ts") else None
    if cursor:
        start = (datetime.fromisoformat(cursor.replace("Z","+00:00")) - timedelta(minutes=5)
                 ).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    else:
        start = "1970-01-01T00:00:00+00:00"
    evs = aw_get("/buckets/%s/events?start=%s&end=%s"
                 % (b, urllib.parse.quote(start), urllib.parse.quote(now_iso)))
    if not evs: continue
    out = []
    for e in sorted(evs, key=lambda x: x["timestamp"]):
        d = e.get("data", {})
        # id = device|bucket|ts (NOT event_id: AW reassigns it on every read of a growing
        # idle event, which created duplicate afk rows).
        out.append({"id": "%s|%s|%s" % (device_id, b, e["timestamp"]),
                    "device_id": device_id, "source": src, "bucket": b, "ts": e["timestamp"],
                    "duration_sec": float(e.get("duration", 0)), "app": d.get("app"),
                    "title": d.get("title"), "url": d.get("url"), "category": None, "data": d})
    # AW returns the open afk event many times with the SAME timestamp; under the new id those
    # collapse to duplicate ids in one batch and PostgREST 500s. De-dupe by id (keep max duration).
    _by_id = {}
    for r in out:
        ex = _by_id.get(r["id"])
        if ex is None or r["duration_sec"] > ex["duration_sec"]:
            _by_id[r["id"]] = r
    out = sorted(_by_id.values(), key=lambda x: x["ts"])
    ok = True
    for i in range(0, len(out), BATCH):
        try:
            sb("POST", "laptop_events", out[i:i+BATCH],
               prefer="return=minimal,resolution=merge-duplicates")
        except Exception as ex:
            print("%s: batch failed (%s); cursor held" % (src, ex)); ok = False; break
    if ok and out:
        sb("POST", "sync_state",
           [{"device_id": device_id, "bucket": b, "last_event_ts": out[-1]["ts"],
             "last_synced_at": now_iso}],
           prefer="return=minimal,resolution=merge-duplicates")
        grand += len(out); print("%s: %d events" % (src, len(out)))
print("done, pushed %d" % grand)
```

### Schedule it (systemd user timer — handles missed runs, the Linux "catch-up")
`~/.config/systemd/user/aw-push.service`:
```ini
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /home/<her>/activity-pipeline/push-activity.py
```
`~/.config/systemd/user/aw-push.timer`:
```ini
[Unit]
Description=Daily ActivityWatch -> Supabase push
[Timer]
OnCalendar=*-*-* 21:00:00
Persistent=true
[Install]
WantedBy=timers.target
```
Enable (and let it run without an active login session):
```bash
systemctl --user daemon-reload
systemctl --user enable --now aw-push.timer
loginctl enable-linger $USER
```
`Persistent=true` = runs as soon as possible after a missed slot (laptop was off). Same
no-permanent-gaps guarantee as your Windows task (cursor + AW retention).

---

## 2.5. Her laptop — token spend (Claude Code + Codex)

Tracks how many AI tokens she burns, shown in the dashboard's **Tokens** view. Uses
`ccusage` (reads her local `~/.claude` and `~/.codex` logs). Needs Node/npx (`npx --version`).

1. Copy `co-founder/push-tokens.py` to her laptop next to `push-activity.py`. It **reuses the
   same `config.json`** (same Supabase URL / anon key / device_id) — nothing new to configure.
2. One-time full backfill:
   ```bash
   python3 push-tokens.py --full
   ```
   Expect "Done. Pushed N token rows." (Codex rows tagged `codex`, Claude rows `claude-code`;
   OpenClaw/synthetic dropped.)
3. Schedule it daily (trailing 45-day window) — a second systemd timer:
   `~/.config/systemd/user/token-push.service`
   ```ini
   [Service]
   Type=oneshot
   ExecStart=/usr/bin/python3 /home/<her>/activity-pipeline/push-tokens.py
   ```
   `~/.config/systemd/user/token-push.timer`
   ```ini
   [Unit]
   Description=Push token spend daily
   [Timer]
   OnCalendar=*-*-* 21:10
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```
   ```bash
   systemctl --user daemon-reload && systemctl --user enable --now token-push.timer
   ```
   (`loginctl enable-linger` from section 2 already covers this.)

Notes: `$` figures in the dashboard are **notional** (API-equivalent, not a bill). If
`device_id` is null in her `config.json`, the pusher reads it from ActivityWatch `/info`, so
AW should be running for the first run — or pin `device_id` in `config.json`.

---

## 3. Her phone — same APK

1. Send her `ActivityPusher.apk` (the one we built). Install via `adb install` (preferred —
   exempts it from Android 13+ "Restricted Settings") or sideload.
2. Open it, paste the **same Supabase URL + anon key** (shared) or her project's (separate).
3. Save → Grant Usage Access → tap Upload now to confirm.
4. **Battery settings depend on her phone's brand** — tell me what phone she has and I'll
   give exact steps (Samsung/Xiaomi/OnePlus/etc. each differ). Same idea: Unrestricted +
   lock in recents.

Note: the same limits apply — phone captures **app-level** time; **browser site/URL** is
the unsolved piece (accessibility, still under decision for your phone too).

---

## 4. Supabase — nothing to set up on your side

The database already exists. You just use the **URL + anon key I sent you** (pasted in step 2
for the laptop, and the same in step 3 for the phone). No schema, no SQL.

Once your laptop and phone each upload once, **your devices automatically appear on my end as
"unmapped"** and I label them as yours — so you don't need to find or send any IDs. (Just do
the one-time laptop `device_id` pinning note in step 2 so it stays stable.)

---

## 5. Checklist

- [ ] AW installed on her Linux laptop; `localhost:5600` works
- [ ] Wayland vs X11 checked (use `awatcher` if Wayland)
- [ ] Browser extension installed + bucket appears
- [ ] aw-qt autostart added
- [ ] `push-activity.py` + `config.json` in place, systemd timer enabled + linger on
- [ ] First manual run pushes rows (`python3 push-activity.py`)
- [ ] Phone APK installed, creds entered, Usage Access granted, test upload OK
- [ ] Phone battery settings hardened (brand-specific)
- [ ] Pinned laptop `device_id` in `config.json` (step 2 note)
- [ ] Pinged Dhruv that you're set up — your devices auto-appear for me to label

---

## Future (see chat brainstorm): the shared dashboard
A Next.js site on Vercel reading the shared Supabase, showing both people's time side by
side (apps, sites, daily/weekly). Decision points: privacy/consent scope, shared-vs-separate
DB (above), and what granularity to expose. Brainstormed separately.

---

## 6. Ambient widgets — the "today" box on laptop + phone

Small always-visible box showing **today's** Laptop time, Phone time, Tokens (+ notional $).
Both pull one endpoint: `GET /api/ambient.json?k=<AMBIENT_TOKEN>&person=cofounder`
(returns preformatted fields `laptop_fmt`, `phone_fmt`, `tokens_fmt`, `cost_fmt`). Ask Dhruv for
the real `<AMBIENT_TOKEN>`.

### 6a. Laptop (EndeavourOS) — Conky (Rainmeter is Windows-only)
Rainmeter doesn't exist on Linux. The equivalent is **Conky** — a lightweight desktop widget that
sits on the wallpaper layer. It works great on **X11**; on a **Wayland** session it's limited
(check with `echo $XDG_SESSION_TYPE`) — if Wayland, either use an X11 session, a Conky build with
Wayland support, or **eww** / a KDE plasmoid instead. Her agent should pick based on her DE/session.

```bash
sudo pacman -S --needed conky curl jq
```

`~/ambient-widget.sh` (chmod +x):
```bash
#!/usr/bin/env bash
URL="https://dashboard-five-beta-46.vercel.app/api/ambient.json?k=<AMBIENT_TOKEN>&person=cofounder"
curl -s --max-time 10 "$URL" \
 | jq -r '"Laptop   \(.laptop_fmt)\nPhone    \(.phone_fmt)\nTokens   \(.tokens_fmt)  (\(.cost_fmt))"' \
 2>/dev/null || echo "unavailable"
```

`~/.config/conky/ambient.conf`:
```lua
conky.config = {
    own_window = true,
    own_window_type = 'desktop',
    own_window_transparent = true,
    own_window_argb_visual = true,
    own_window_argb_value = 200,
    own_window_hints = 'undecorated,below,sticky,skip_taskbar,skip_pager',
    alignment = 'bottom_right',
    gap_x = 16, gap_y = 48,
    minimum_width = 210,
    update_interval = 60,
    double_buffer = true,
    use_xft = true,
    font = 'DejaVu Sans:size=11',
    default_color = 'CCCCCC',
};
conky.text = [[
${color 8B94A7}RIA - TODAY
${color CCCCCC}${execi 60 bash ~/ambient-widget.sh}
]];
```
Run + autostart:
```bash
conky -c ~/.config/conky/ambient.conf &      # test it appears bottom-right
# autostart: add the same line to your DE's Autostart, or a ~/.config/autostart/conky.desktop
```

### 6b. Phone — AnyWidget (already installed)
You already added the widget. It was showing only the top-left corner because the page was
full-screen-sized. Fix: in AnyWidget, set the URL to the **compact** layout by adding `&w=1`:
```
https://dashboard-five-beta-46.vercel.app/ambient?k=<AMBIENT_TOKEN>&person=cofounder&w=1
```
That renders a tight version with all 3 stats stacked, fitting a small tile. Apply the ColorOS
battery whitelist (Auto-launch on, Allow background, Don't optimize, Lock in Recents) or it
freezes. `$` is notional; phone shows ~0 until the nightly phone upload.

---

## 7. AFK timeout (focused vs active) — optional, to match Dhruv

The dashboard's "active" laptop number = window-focused time **and** keyboard/mouse input within
the AFK timeout. Default is **180s (3 min)**; Dhruv set his to **5 min**. To match on her laptop,
edit her AFK config and restart AW:

`~/.config/activitywatch/aw-watcher-afk/aw-watcher-afk.toml` (path may vary; it's the AW config
dir), set:
```toml
[aw-watcher-afk]
timeout = 300
poll_time = 5
```
Then restart ActivityWatch (`aw-qt` tray → Quit, relaunch; or restart `aw-watcher-afk`).

Notes:
- Forward-only (past data keeps the old classification). The effect is small — it only rescues
  3–5 min pauses; long idle still counts as away.
- **Wayland caveat:** on a Wayland session the afk watcher can under-detect input, so *active* may
  read artificially low no matter the timeout. *Focused* and phone numbers are unaffected. Check
  `echo $XDG_SESSION_TYPE`; the dashboard headline uses **focused**, so this mostly doesn't matter.
