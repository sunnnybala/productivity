# PLAN — Token Spend Tracking (Claude Code + Codex)

> **STATUS: BUILT & DEPLOYED (2026-06-29).** Eng-reviewed + Claude outside-voice review applied
> (single merged ccusage command with allowlist tagging; id drops `tool`; `v_unmapped_devices`
> extended; gap-filled + bucket-clamped RPC; `tu_sel` policy; `--offline`). Kept the RPC over
> JS-aggregation (1000-row PostgREST cap). See HANDOFF §14.

Track per-person AI token usage (daily / weekly / monthly / all-time) in the shared
Supabase DB and surface it in the dashboard, reusing the activity-pipeline rails.

**Decisions (locked with user 2026-06-29):**
- Track **Claude Code + Codex** only. OpenClaw excluded (dormant, ~2.7%, not of interest).
- Dashboard: **new "Tokens" view** with **person tabs + date picker + day/week/month toggle** + all-time stat.
- **Tokens are the headline; $ shown as labeled "notional"** (API-equivalent, not billed on a subscription).

---

## 1. Why / what changes for the user

You currently get token numbers only by running `ccusage` by hand on one laptop. After
this, both co-founders' token spend lands in the same dashboard you already use for
laptop/phone time, per person, with the same date controls, plus day/week/month/all-time
rollups. One place to see "who's burning what."

---

## 2. Source of truth

`ccusage` parses each machine's local agent logs (`~/.claude`, `~/.codex`). It already
records exact per-day, per-model token counts (input / output / cache-create / cache-read)
and a notional cost. We pull its JSON, filter to Claude Code + Codex, and upsert into Supabase.

```
npx ccusage@latest daily --json --timezone Asia/Kolkata
  -> { daily: [ { period, modelBreakdowns:[{modelName, inputTokens, outputTokens,
                  cacheCreationTokens, cacheReadTokens, cost}], ... } ] }
```

- `--timezone Asia/Kolkata` makes ccusage's day boundaries match the rest of the pipeline
  (laptop/phone are bucketed IST). Eliminates tz drift. (If an older ccusage lacks the flag,
  fall back to machine-local and note it; both co-founders are in IST so impact is nil.)
- Tool tag derived from `modelName`: contains `gpt`/`codex` -> `codex`; contains `openclaw`
  -> **dropped**; else -> `claude-code`.

---

## 3. Data flow

```
  each laptop (per person)                         Supabase                     dashboard
 ┌───────────────────────┐                 ┌──────────────────────┐        ┌───────────────┐
 │ npx ccusage daily      │                 │ token_usage (RLS:     │        │ /api/tokens   │
 │   --json --tz IST      │  upsert (anon)  │   anon insert/update) │  rpc   │  -> Tokens    │
 │ push-tokens.ps1 / .py  │ ───────────────▶│ id=device|date|tool|  │◀──────▶│  view (D/W/M, │
 │  • filter claude/codex │  merge-dups     │      model            │ service│  per person)  │
 │  • map rows            │                 │ + monotonic-max trig  │  key   │               │
 │  • device_id from      │                 │ token_summary(person, │        │               │
 │    existing config.json│                 │   from,to,bucket) RPC │        │               │
 └───────────────────────┘                 └──────────────────────┘        └───────────────┘
        (Task Scheduler / systemd, daily — same cadence as activity pusher)
```

Person attribution reuses the existing `devices` table: the token pusher reads the **same
`config.json`** as the activity pusher, so `token_usage.device_id` maps to a person via
`devices` exactly like `laptop_events` does. No new registration, one source of truth.

---

## 4. Schema (new migration)

```sql
create table public.token_usage (
  id            text primary key,            -- deterministic: device|usage_date|tool|model
  device_id     text not null,               -- same id as the activity pusher (config.json)
  usage_date    date not null,               -- bucketed Asia/Kolkata (ccusage --timezone)
  tool          text not null,               -- 'claude-code' | 'codex'
  model         text not null,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_create_tokens bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  total_tokens        bigint not null default 0,
  cost_usd      numeric not null default 0,   -- NOTIONAL (API-equivalent, not a bill)
  captured_at   timestamptz not null default now()
);
create index token_usage_device_date_idx on public.token_usage(device_id, usage_date);
create index token_usage_date_idx        on public.token_usage(usage_date);

alter table public.token_usage enable row level security;
create policy tu_ins on public.token_usage for insert to anon with check (true);
create policy tu_upd on public.token_usage for update to anon using (true) with check (true);
-- no select for anon; dashboard reads via service key only.

-- Monotonic guard: a re-read of a day must not LOWER a recorded total (a day's tokens
-- only grow, then finalize). Mirrors the phone trigger.
create or replace function public.token_usage_keep_max()
returns trigger language plpgsql as $$
begin
  if new.total_tokens < old.total_tokens then  -- stale/partial re-read: keep the better row
    return old;
  end if;
  return new;
end; $$;
create trigger token_usage_keep_max_trg
  before update on public.token_usage
  for each row execute function public.token_usage_keep_max();
```

Note: no `sync_state` cursor needed. ccusage recomputes from the full local logs each run,
and past days are immutable, so the pusher can upsert all days every run (idempotent). Row
count is tiny (hundreds), so re-pushing everything is cheap.

---

## 5. Aggregation RPC (new)

```sql
create or replace function public.token_summary(
  p_person text, p_from date, p_to date, p_bucket text default 'day'
) returns json language sql stable as $$
  with dev as (select device_id from public.devices where person = p_person),
  rows as (
    select t.* from public.token_usage t join dev on dev.device_id = t.device_id
  ),
  rng as (select * from rows where usage_date between p_from and p_to),
  series as (
    select date_trunc(p_bucket, usage_date)::date as bucket,
           sum(total_tokens) tokens, sum(cost_usd) cost
    from rng group by 1 order by 1
  )
  select json_build_object(
    'total_tokens',  (select coalesce(sum(total_tokens),0) from rng),
    'total_cost',    (select coalesce(sum(cost_usd),0)   from rng),
    'alltime_tokens',(select coalesce(sum(total_tokens),0) from rows),
    'alltime_cost',  (select coalesce(sum(cost_usd),0)   from rows),
    'cache_read',    (select coalesce(sum(cache_read_tokens),0) from rng),
    'by_tool',  (select coalesce(json_agg(x),'[]'::json) from
                  (select tool name, sum(total_tokens) tokens, round(sum(cost_usd),2) cost
                   from rng group by 1 order by 2 desc) x),
    'by_model', (select coalesce(json_agg(x),'[]'::json) from
                  (select model name, sum(total_tokens) tokens, round(sum(cost_usd),2) cost
                   from rng group by 1 order by 2 desc limit 25) x),
    'series',   (select coalesce(json_agg(json_build_object(
                   'bucket',bucket,'tokens',tokens,'cost',round(cost,2)) order by bucket),'[]'::json)
                 from series)
  );
$$;
revoke all on function public.token_summary(text,date,date,text) from anon, authenticated;
```

`p_bucket` ∈ `day|week|month` drives the chart granularity. `alltime_*` ignores the range.

---

## 6. Pusher (`token-pusher/push-tokens.ps1` + `.py`)

Pseudocode (both OSes identical logic; PS1 for dhruv/Windows, Python for Ria/Linux):

```
cfg = read config.json            # reuse activity pusher's config (supabase_url, anon key, device_id)
j   = run: npx ccusage@latest daily --json --timezone Asia/Kolkata
rows = []
for d in j.daily:
  for mb in d.modelBreakdowns:
     tool = tag(mb.modelName)     # gpt/codex->codex ; openclaw->SKIP ; else claude-code
     if tool is null: continue
     rows.append({
       id: f"{device_id}|{d.period}|{tool}|{mb.modelName}",
       device_id, usage_date=d.period, tool, model=mb.modelName,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       total_tokens = sum of the four, cost_usd = mb.cost })
upsert rows -> token_usage  (Prefer: resolution=merge-duplicates, UTF-8 body)
```

- UTF-8 body bytes (same Latin-1 lesson as the activity pusher).
- Batch in chunks; on any non-2xx, log and exit non-zero (don't half-push).
- Scheduling: reuse the existing daily Task Scheduler job / systemd timer (add a second
  action/line), so tokens refresh on the same cadence as activity.

---

## 7. Dashboard (new "Tokens" view)

- Top-level toggle: **[ Activity | Tokens ]**. Reuse person tabs + date presets/custom range.
- New `app/tokens.js` client component + `app/api/tokens/route.js` (auth recheck, calls
  `token_summary`). `page.js` renders a small client shell that switches Activity/Tokens.
- Tokens view layout:
  - Granularity switch: **Day | Week | Month** (sets `p_bucket`).
  - KPIs: **Total tokens** (range) · **~$ notional** (labeled "API-equiv, not billed") ·
    **All-time tokens**.
  - Bar chart: `series` (tokens per bucket).
  - Two `RankList` panels (reused): **by tool**, **by model**.
  - Footer caveat: "$ is notional (API list prices); on a Max/Pro plan you pay a flat fee.
    Most tokens are cache-reads."

```
[ Activity | TOKENS ]      Person: ( Dhruv ) Ria        2026-06-01 → 06-29 · IST
Granularity: ( Day ) Week Month
┌────────────┐ ┌────────────┐ ┌──────────────┐
│ Tokens     │ │ ~$ notional│ │ All-time     │
│ 1.70B      │ │ $2,135     │ │ 2.37B tok    │
└────────────┘ └────────────┘ └──────────────┘
Bar chart: tokens per day/week/month
[ by tool ]      [ by model ]
```

---

## 8. Test coverage diagram

```
PUSHER (push-tokens.ps1 / .py)
  ├── tag(modelName)
  │   ├── [TEST] "gpt-5.5" -> codex
  │   ├── [TEST] "[openclaw] claude-opus-4-5" -> SKIP (null)
  │   ├── [TEST] "claude-opus-4-8" -> claude-code
  │   └── [TEST] empty/unknown -> claude-code (default) + logged
  ├── row mapping
  │   ├── [TEST] total_tokens = sum of 4 token fields
  │   ├── [TEST] id == device|date|tool|model (determinism: same input -> same id)
  │   └── [TEST] missing modelBreakdowns / empty day -> 0 rows, no crash
  ├── ccusage invocation
  │   ├── [TEST] ccusage absent / npx fails -> non-zero exit, nothing pushed
  │   └── [→E2E] real ccusage run on this laptop -> rows land in token_usage
  └── upsert
      ├── [TEST] non-2xx response -> exit non-zero, no partial-success claim
      └── [TEST] UTF-8 body (model names are ASCII, but enforce anyway)

DB
  ├── token_usage_keep_max trigger
  │   ├── [TEST] re-push smaller total -> row unchanged (keeps max)
  │   └── [TEST] re-push larger total  -> row updated
  └── token_summary RPC
      ├── [TEST] day/week/month bucketing via date_trunc
      ├── [TEST] range totals vs all-time totals
      ├── [TEST] by_tool / by_model sums == series sum
      └── [TEST] unmapped device -> excluded (person inner-join)

DASHBOARD
  ├── [TEST] Activity/Tokens toggle renders correct view
  ├── [TEST] granularity switch refetches with p_bucket
  ├── [→E2E] auth: /api/tokens without cookie -> blocked
  └── [TEST] empty range -> "no data", no NaN
```

---

## 9. Failure modes

| Codepath | Failure | Test? | Error handling | Visible? |
|---|---|---|---|---|
| ccusage invoke | binary/npx missing or network | yes | exit non-zero, log | pusher log |
| ccusage schema | field renamed in new ccusage | partial | guard missing fields -> 0, log | pusher log |
| tag(model) | new model string unrecognized | yes | default claude-code + log | row tagged claude-code |
| today still growing | later partial re-read smaller | yes | monotonic-max trigger keeps max | none (correct) |
| timezone | machine not IST | n/a (both IST) | pass --timezone; documented | doc note |
| RPC | huge range | n/a (tiny table) | indexed | fast |

No failure mode is both silent AND data-losing. The monotonic trigger covers the one
correctness risk (partial re-read shrinking a day).

---

## 10. NOT in scope (deferred)

- **OpenClaw token tracking** — excluded by decision (dormant, ~2.7%). Easy to add later
  (just stop dropping the `openclaw` tag).
- **OpenTelemetry live per-person stream** — the ccusage-pull is simpler and sufficient;
  OTEL stays the option if you later want real-time burn-rate. (See HANDOFF token research.)
- **Live 5-hour / weekly limit prediction** — that's `claude-monitor`'s job, run locally;
  not a dashboard concern.
- **Real billed dollars** — impossible on a subscription; we show notional only.
- **Per-session / per-project token drill-down** — daily granularity is enough for now.

## 11. What already exists (reused, not rebuilt)

- `devices` table + person mapping + `v_unmapped_devices` safety → reused for attribution.
- RLS write-only anon pattern (`phone_app_usage`) → copied for `token_usage`.
- Monotonic-max trigger (phone) → copied for `token_usage`.
- Pusher pattern + config.json + scheduling (Task Scheduler / systemd) → reused.
- Dashboard person tabs, date controls, `RankList`, bar chart, RPC+service-key data layer,
  auth → reused; only a new view + route + RPC added.

## 12. Parallelization

| Step | Modules | Depends on |
|---|---|---|
| A. migration (table + RPC + trigger) | supabase/migrations | — |
| B. pusher (ps1 + py) | token-pusher/ | A (needs table) |
| C. dashboard (view + api route) | dashboard/app | A (needs RPC) |
| D. Ria setup doc update | CO-FOUNDER-SETUP.md | B |

Lane 1: A → (B ∥ C) in parallel after A. Then D. B and C touch different dirs, no conflict.

## 13. Rollout

1. Apply migration (`supabase db push`).
2. Run `push-tokens.ps1` once on this laptop → backfill all history → verify rows.
3. Add Tokens view, deploy, verify against ccusage numbers ($2,135 Claude / $455 Codex).
4. Add the daily schedule.
5. Update `CO-FOUNDER-SETUP.md` so Ria's agent installs the token pusher too.
6. Add token rules to `INGESTION-RULES.md`.
