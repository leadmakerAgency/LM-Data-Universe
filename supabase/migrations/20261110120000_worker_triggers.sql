-- Trigger formulas for changes made without the app (public forms, later the
-- API): the formula worker computes them and saves the values through this
-- function. Only UpdateRecords is accepted, the bundle is logged with source
-- 'system' (not undoable on its own) and the worker never reacts to 'system'
-- bundles, so this can't loop.
create or replace function public.worker_apply_triggers(p_doc uuid, p_secret text, p_actions jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  perform public._check_worker_secret(p_secret);
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) = 0 then
    return null;
  end if;
  if exists (select 1 from jsonb_array_elements(p_actions) a where a->>'op' is distinct from 'UpdateRecords') then
    raise exception 'Trigger updates must be UpdateRecords';
  end if;
  v_result := public._apply_and_log(p_doc, p_actions, 'do', null, false, 'system');
  return (v_result->>'action_id')::bigint;
end $$;

revoke execute on function public.worker_apply_triggers(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.worker_apply_triggers(uuid, text, jsonb) to service_role;
