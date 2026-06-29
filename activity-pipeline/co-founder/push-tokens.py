#!/usr/bin/env python3
"""
push-tokens.py  —  Laptop -> Supabase token-spend pusher (Claude Code + Codex)

Runs ccusage, filters to Claude Code + Codex, upserts daily per-model token usage
into Supabase. Idempotent. Reuses the activity pusher's config.json (same
supabase_url / anon key / device_id). Linux/macOS (Ria). Python stdlib only.

  python3 push-tokens.py            # trailing 45-day window (for the timer)
  python3 push-tokens.py --full     # full history backfill (run once)
  python3 push-tokens.py --dry-run  # parse + print plan, no upload
"""
import json, os, sys, subprocess, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
AW_BASE = "http://localhost:5600/api/0"
WINDOW_DAYS = 45

def log(m): print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), m), flush=True)

def aw_get(path):
    with urllib.request.urlopen(AW_BASE + path, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))

def tool_of(model):
    """Allowlist: drop openclaw / <synthetic> / unknown agents."""
    if not model: return None
    s = model.lower()
    if "openclaw" in s: return None                 # excluded by decision
    if "gpt" in s or "codex" in s: return "codex"
    if any(k in s for k in ("claude", "opus", "sonnet", "haiku", "fable")): return "claude-code"
    return None                                      # <synthetic>, other agents

def main():
    full = "--full" in sys.argv
    dry  = "--dry-run" in sys.argv
    if not os.path.exists(CONFIG):
        log("No config at %s (reuses the activity pusher config.json)." % CONFIG); sys.exit(1)
    cfg = json.load(open(CONFIG))
    global AW_BASE
    AW_BASE = cfg.get("aw_base", AW_BASE)

    device_id = cfg.get("device_id")
    if not device_id:
        try: device_id = aw_get("/info")["device_id"]
        except Exception as e:
            log("Could not resolve device_id (config.device_id null and AW unreachable: %s). Pin device_id in config.json." % e); sys.exit(1)
    log("device_id=%s" % device_id)

    args = ["npx", "-y", "ccusage@latest", "daily", "--json", "--timezone", "Asia/Kolkata", "--offline"]
    if not full:
        since = (datetime.now() - timedelta(days=WINDOW_DAYS)).strftime("%Y%m%d")
        args += ["--since", since]
    log("running: " + " ".join(args))
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=300)
        if out.returncode != 0 or not out.stdout.strip():
            raise RuntimeError(out.stderr.strip() or "ccusage produced no output")
        data = json.loads(out.stdout)
    except Exception as e:
        log("ccusage failed: %s" % e); sys.exit(1)

    rows, dropped = [], 0
    for d in data.get("daily", []):
        for mb in d.get("modelBreakdowns", []):
            tool = tool_of(mb.get("modelName"))
            if not tool:
                dropped += 1; continue
            inp = int(mb.get("inputTokens") or 0); out_ = int(mb.get("outputTokens") or 0)
            cc  = int(mb.get("cacheCreationTokens") or 0); cr = int(mb.get("cacheReadTokens") or 0)
            rows.append({
                "id": "%s|%s|%s" % (device_id, d["period"], mb["modelName"]),
                "device_id": device_id, "usage_date": d["period"], "tool": tool,
                "model": mb["modelName"], "input_tokens": inp, "output_tokens": out_,
                "cache_create_tokens": cc, "cache_read_tokens": cr,
                "total_tokens": inp + out_ + cc + cr, "cost_usd": float(mb.get("cost") or 0),
            })
    log("rows=%d dropped(openclaw/synthetic/unknown)=%d" % (len(rows), dropped))
    if not rows:
        log("nothing to push."); return

    if dry:
        by = {}
        for r in rows: by[r["tool"]] = by.get(r["tool"], 0) + 1
        for k, v in by.items(): log("  %s: %d rows" % (k, v))
        log("DRY RUN - nothing uploaded."); return

    url = cfg["supabase_url"].rstrip("/") + "/rest/v1/token_usage"
    headers = {"apikey": cfg["supabase_anon_key"],
               "Authorization": "Bearer " + cfg["supabase_anon_key"],
               "Content-Type": "application/json",
               "Prefer": "return=minimal,resolution=merge-duplicates"}
    BATCH = 500
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i+BATCH]
        body = json.dumps(chunk).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
        except urllib.error.HTTPError as e:
            log("upsert FAILED at batch %d: %s %s" % (i, e.code, e.read().decode("utf-8", "ignore")[:300])); sys.exit(1)
    log("Done. Pushed %d token rows." % len(rows))

if __name__ == "__main__":
    main()
