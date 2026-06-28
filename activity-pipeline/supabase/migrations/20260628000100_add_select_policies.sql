-- Upserts (POST with Prefer: resolution=merge-duplicates) compile to
-- INSERT ... ON CONFLICT DO UPDATE, which requires the role to be able to
-- SELECT the table for conflict detection. The original schema omitted SELECT
-- policies on these two tables (write-only intent), which made every upsert
-- fail with 42501. Add SELECT policies so idempotent upserts work.

drop policy if exists le_sel on public.laptop_events;
create policy le_sel on public.laptop_events for select to anon using (true);

drop policy if exists pu_sel on public.phone_app_usage;
create policy pu_sel on public.phone_app_usage for select to anon using (true);
