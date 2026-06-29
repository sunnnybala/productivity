-- token_usage upsert uses resolution=merge-duplicates => INSERT ... ON CONFLICT DO
-- UPDATE, which Postgres requires a SELECT policy for (even with return=minimal),
-- else 42501. Same fix as le_sel/pu_sel on the other ingest tables.
drop policy if exists tu_sel on public.token_usage;
create policy tu_sel on public.token_usage for select to anon using (true);
