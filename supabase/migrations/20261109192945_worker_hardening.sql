-- Keep pg_net out of the API-exposed public schema (Supabase advisor 0014).
-- Its functions live in the `net` schema either way; only the extension's
-- home schema changes. Fresh setups already create it in `extensions`.
do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
             where e.extname = 'pg_net' and n.nspname = 'public') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end $$;

-- Formula values are written by the doc-worker only. set_computed (from the
-- action_log migration) let any editor store arbitrary "computed" values,
-- which the API and exports would then trust.
revoke execute on function public.set_computed(uuid, jsonb) from authenticated;
