-- Phase 6 follow-up: a reliable "recalculate everything" request.
--
-- Changing a document's time zone needs every formula recomputed (TODAY()).
-- The first version reset doc_recalc.done_id to 0, but a worker run already
-- going would finish with greatest(done_id, its range) and quietly turn the
-- full request back into an incremental one. Now the request is a flag that
-- only worker_start consumes (handing the worker done_id 0, which it treats
-- as "everything"), and worker_finish keeps the worker looping while one is
-- pending. The worker itself is unchanged.

alter table public.doc_recalc add column full_pending boolean not null default false;

create or replace function public.tg_doc_timezone_recalc()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_start boolean := false;
begin
  if (old.settings ->> 'timezone') is not distinct from (new.settings ->> 'timezone') then
    return null;
  end if;
  insert into public.doc_recalc (doc_id) values (new.id) on conflict (doc_id) do nothing;
  update public.doc_recalc set full_pending = true, updated_at = now() where doc_id = new.id;
  update public.doc_recalc set running_since = now()
  where doc_id = new.id and (running_since is null or running_since < now() - interval '2 minutes')
  returning true into v_start;
  if coalesce(v_start, false) then
    begin
      if not public._kick_doc_worker(new.id) then
        update public.doc_recalc set running_since = null where doc_id = new.id;
      end if;
    exception when others then
      update public.doc_recalc set running_since = null, last_error = 'Could not call worker: ' || sqlerrm where doc_id = new.id;
    end;
  end if;
  return null;
end $$;

-- Claims a run: returns the action range to process (done_id 0 = everything).
create or replace function public.worker_start(p_doc uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.doc_recalc;
  v_full boolean;
begin
  perform public._check_worker_secret(p_secret);
  insert into public.doc_recalc (doc_id) values (p_doc) on conflict (doc_id) do nothing;
  select full_pending into v_full from public.doc_recalc where doc_id = p_doc for update;
  update public.doc_recalc set running_since = now(), updated_at = now(), full_pending = false
  where doc_id = p_doc
  returning * into r;
  return jsonb_build_object('done_id', case when v_full then 0 else r.done_id end, 'requested_id', r.requested_id);
end $$;

-- As before, plus: keep going while a full recalculation is pending, and if a
-- full run fails, ask for it again.
create or replace function public.worker_finish(p_doc uuid, p_secret text, p_done_id bigint, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  r public.doc_recalc;
begin
  perform public._check_worker_secret(p_secret);
  select * into r from public.doc_recalc where doc_id = p_doc for update;
  if p_error is null and (r.requested_id > greatest(r.done_id, p_done_id) or r.full_pending) then
    update public.doc_recalc
    set done_id = greatest(done_id, p_done_id), last_error = null, running_since = now(), updated_at = now()
    where doc_id = p_doc;
    return true;
  end if;
  update public.doc_recalc
  set done_id = case when p_error is null then greatest(done_id, p_done_id) else done_id end,
      full_pending = full_pending or (p_error is not null and p_done_id = 0),
      last_error = p_error, running_since = null, updated_at = now()
  where doc_id = p_doc;
  return false;
end $$;
