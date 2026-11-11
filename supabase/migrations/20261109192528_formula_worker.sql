-- Phase 0: server-side formula recalculation.
--
-- Every logged action that touches records or schema asks for a recalc of
-- its document. A trigger on doc_actions records the request in doc_recalc
-- and, unless a run is already going, calls the `doc-worker` Edge Function
-- through pg_net (sent only after the transaction commits). The worker loads
-- the document, recomputes the formula columns the new actions can affect
-- and writes the values that changed into doc_rows.computed. Bursts of edits
-- are coalesced: while a run is going, new requests only raise requested_id,
-- and the worker loops until it has caught up.
--
-- One-time setup (values are not stored in this file):
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/doc-worker', 'doc_worker_url');
--   select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'doc_worker_secret');
-- Without them, requests are recorded but no worker is called.

create extension if not exists pg_net with schema extensions;

create table public.doc_recalc (
  doc_id uuid primary key references public.documents(id) on delete cascade,
  -- Highest action id that needs recalculating.
  requested_id bigint not null default 0,
  -- Highest action id whose effects are reflected in doc_rows.computed.
  done_id bigint not null default 0,
  running_since timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.doc_recalc enable row level security;
create policy doc_recalc_select on public.doc_recalc for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[]));

-- Calls the worker for a document (no-op until the vault secrets exist).
create or replace function public._kick_doc_worker(p_doc uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'doc_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'doc_worker_secret';
  if v_url is null or v_secret is null then
    return false;
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('doc_id', p_doc),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    timeout_milliseconds := 10000
  );
  return true;
end $$;

create or replace function public.tg_request_recalc()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_start boolean := false;
begin
  -- Page and widget changes never affect formula values.
  if not exists (
    select 1 from jsonb_array_elements(new.actions) a
    where coalesce(a->>'entity', '') not in ('page', 'widget')
  ) then
    return null;
  end if;
  insert into public.doc_recalc as r (doc_id, requested_id) values (new.doc_id, new.id)
  on conflict (doc_id) do update
    set requested_id = greatest(r.requested_id, excluded.requested_id), updated_at = now();
  -- Start a run unless one is going (a run silent for 2 minutes is presumed dead).
  update public.doc_recalc
  set running_since = now()
  where doc_id = new.doc_id and (running_since is null or running_since < now() - interval '2 minutes')
  returning true into v_start;
  if coalesce(v_start, false) then
    -- A worker problem must never block saving an edit.
    begin
      if not public._kick_doc_worker(new.doc_id) then
        update public.doc_recalc set running_since = null where doc_id = new.doc_id;
      end if;
    exception when others then
      update public.doc_recalc set running_since = null, last_error = 'Could not call worker: ' || sqlerrm
      where doc_id = new.doc_id;
    end;
  end if;
  return null;
end $$;

create trigger doc_actions_request_recalc after insert on public.doc_actions
  for each row execute function public.tg_request_recalc();

-- ============================================================
-- Worker API (service role only; the shared secret proves the call came from pg_net)
-- ============================================================
create or replace function public._check_worker_secret(p_secret text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'doc_worker_secret') then
    raise exception 'Invalid worker secret' using errcode = '42501';
  end if;
end $$;

-- Claims a run: returns the action range to process.
create or replace function public.worker_start(p_doc uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.doc_recalc;
begin
  perform public._check_worker_secret(p_secret);
  insert into public.doc_recalc (doc_id) values (p_doc) on conflict (doc_id) do nothing;
  update public.doc_recalc set running_since = now(), updated_at = now()
  where doc_id = p_doc
  returning * into r;
  return jsonb_build_object('done_id', r.done_id, 'requested_id', r.requested_id);
end $$;

-- Writes computed values: p_updates = [{"id": 12, "computed": {...}}, ...].
create or replace function public.worker_set_computed(p_doc uuid, p_secret text, p_updates jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public._check_worker_secret(p_secret);
  update public.doc_rows r
  set computed = u.computed
  from jsonb_to_recordset(p_updates) as u(id bigint, computed jsonb)
  where r.id = u.id and r.doc_id = p_doc and r.computed is distinct from u.computed;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Ends a run. Returns true when newer actions arrived meanwhile (run again).
create or replace function public.worker_finish(p_doc uuid, p_secret text, p_done_id bigint, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  r public.doc_recalc;
begin
  perform public._check_worker_secret(p_secret);
  select * into r from public.doc_recalc where doc_id = p_doc for update;
  if p_error is null and r.requested_id > greatest(r.done_id, p_done_id) then
    update public.doc_recalc
    set done_id = greatest(done_id, p_done_id), last_error = null, running_since = now(), updated_at = now()
    where doc_id = p_doc;
    return true;
  end if;
  update public.doc_recalc
  set done_id = case when p_error is null then greatest(done_id, p_done_id) else done_id end,
      last_error = p_error, running_since = null, updated_at = now()
  where doc_id = p_doc;
  return false;
end $$;

revoke execute on function
  public._kick_doc_worker(uuid), public.tg_request_recalc(), public._check_worker_secret(text),
  public.worker_start(uuid, text), public.worker_set_computed(uuid, text, jsonb),
  public.worker_finish(uuid, text, bigint, text)
from public, anon, authenticated;
grant execute on function
  public.worker_start(uuid, text), public.worker_set_computed(uuid, text, jsonb),
  public.worker_finish(uuid, text, bigint, text)
to service_role;
grant select on public.doc_recalc to authenticated;
