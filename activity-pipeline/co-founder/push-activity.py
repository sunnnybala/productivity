#!/usr/bin/env python3
# Laptop -> Supabase activity pusher (Linux/macOS). Incremental + idempotent.
# Writes to the SHARED `laptop_events` table + advances `sync_state`.
# Same schema Dhruv's Windows pusher uses, so the shared dashboard reads it correctly.
# Install at ~/activity-pipeline/push-activity.py next to config.json. Run: python3 push-activity.py
import json, os, sys, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

_cfgpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
if not os.path.exists(_cfgpath):
    print("No config.json next to push-activity.py — copy config.example.json and fill it in."); sys.exit(1)
cfg = json.load(open(_cfgpath))
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
print("device_id =", device_id, "  <-- pin this into config.json after first run")
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
        # id = device|bucket|ts  (NOT event_id: AW reassigns event ids on every read for
        # growing afk/idle events, which created duplicate rows. ts is the stable natural key.)
        out.append({"id": "%s|%s|%s" % (device_id, b, e["timestamp"]),
                    "device_id": device_id, "source": src, "bucket": b, "ts": e["timestamp"],
                    "duration_sec": float(e.get("duration", 0)), "app": d.get("app"),
                    "title": d.get("title"), "url": d.get("url"), "category": None, "data": d})
    # AW returns the open afk event many times with the SAME timestamp (growing duration).
    # id is device|bucket|ts, so collapse same-id rows (keep max duration) before upserting,
    # else the batch has duplicate ids and PostgREST 500s (ON CONFLICT can't affect a row twice).
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
