-- ============================================================================
-- Token spend tracking (Claude Code + Codex) via ccusage.
-- Per-person daily token usage; dashboard rolls up day/week/month/all-time.
-- Review-hardened: allowlist tool tagging in the pusher; id has no redundant
-- tool field; v_unmapped_devices covers token-only devices; RPC gap-fills
-- buckets and clamps p_bucket.
-- ============================================================================

create table if not exists public.token_usage (
  id            text primary key,            -- deterministic: device|usage_date|model
  device_id     text not null,               -- same id as the activity pusher (config.json)
  usage_date    date not null,               -- bucketed Asia/Kolkata (ccusage --timezone)
  tool          text not null,               -- 'claude-code' | 'codex'  (column, NOT in id)
  model         text not null,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_create_tokens bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  total_tokens        bigint not null default 0,
  cost_usd      numeric not null default 0,   -- NOTIONAL (API-equivalent, not a bill)
  captured_at   timestamptz not null default now()
);
create index if not exists token_usage_device_date_idx on public.token_usage(device_id, usage_date);
create index if not exists token_usage_date_idx        on public.token_usage(usage_date);

alter table public.token_usage enable row level security;
drop policy if exists tu_ins on public.token_usage;
drop policy if exists tu_upd on public.token_usage;
create policy tu_ins on public.token_usage for insert to anon with check (true);
create policy tu_upd on public.token_usage for update to anon using (true) with check (true);
-- no select for anon; dashboard reads via service key only.

-- Monotonic guard: a stale/partial re-read of a day must not LOWER a recorded total.
-- A day's tokens only grow then finalize; if the new total is smaller, keep the old row.
create or replace function public.token_usage_keep_max()
returns trigger language plpgsql as $$
begin
  if new.total_tokens < old.total_tokens then
    return old;   -- keep the better (more complete) row; valid no-op in BEFORE UPDATE
  end if;
  return new;
end; $$;
drop trigger if exists token_usage_keep_max_trg on public.token_usage;
create trigger token_usage_keep_max_trg
  before update on public.token_usage
  for each row execute function public.token_usage_keep_max();

-- Extend unmapped-device safety to token-only devices (was laptop_events only).
create or replace view public.v_unmapped_devices as
  select distinct u.dev_id as device_id
  from (
    select device_id as dev_id from public.laptop_events
    union
    select device_id as dev_id from public.token_usage
  ) u
  left join public.devices d on d.device_id = u.dev_id
  where d.device_id is null;
revoke all on public.v_unmapped_devices from anon, authenticated;

-- ---------- Aggregation RPC: day/week/month + all-time, per person ------------
create or replace function public.token_summary(
  p_person text, p_from date, p_to date, p_bucket text default 'day'
) returns json
language sql
stable
as $$
  with b as (
    select case when p_bucket in ('day','week','month') then p_bucket else 'day' end as bk
  ),
  dev as (select device_id from public.devices where person = p_person),
  rows as (select t.* from public.token_usage t join dev on dev.device_id = t.device_id),
  rng  as (select * from rows where usage_date between p_from and p_to),
  buckets as (
    select generate_series(
             date_trunc((select bk from b), p_from::timestamp),
             date_trunc((select bk from b), p_to::timestamp),
             ('1 ' || (select bk from b))::interval
           )::date as bucket
  ),
  agg as (
    select date_trunc((select bk from b), usage_date)::date as bucket,
           sum(total_tokens)               as tokens,
           sum(input_tokens+output_tokens) as io_tokens,
           sum(cost_usd)                   as cost
    from rng group by 1
  ),
  series as (
    select bk.bucket,
           coalesce(a.tokens,0)    as tokens,
           coalesce(a.io_tokens,0) as io_tokens,
           coalesce(a.cost,0)      as cost
    from buckets bk left join agg a on a.bucket = bk.bucket
  )
  select json_build_object(
    'bucket',         (select bk from b),
    'total_tokens',   (select coalesce(sum(total_tokens),0)               from rng),
    'io_tokens',      (select coalesce(sum(input_tokens+output_tokens),0) from rng),
    'total_cost',     (select coalesce(sum(cost_usd),0)                   from rng),
    'alltime_tokens', (select coalesce(sum(total_tokens),0)               from rows),
    'alltime_cost',   (select coalesce(sum(cost_usd),0)                   from rows),
    'by_tool',  (select coalesce(json_agg(x),'[]'::json) from (
                   select tool as name, sum(total_tokens) as tokens, round(sum(cost_usd),2) as cost
                   from rng group by 1 order by 2 desc) x),
    'by_model', (select coalesce(json_agg(x),'[]'::json) from (
                   select model as name, sum(total_tokens) as tokens, round(sum(cost_usd),2) as cost
                   from rng group by 1 order by 2 desc limit 25) x),
    'series',   (select coalesce(json_agg(json_build_object(
                   'bucket', bucket, 'tokens', tokens, 'io_tokens', io_tokens, 'cost', round(cost,2)
                 ) order by bucket), '[]'::json) from series)
  );
$$;
revoke all on function public.token_summary(text, date, date, text) from anon, authenticated;
