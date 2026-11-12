-- _touched: skip records without an id or that no longer exist (nothing changed for them) instead of failing.
-- Rows touched by a logged bundle: {table uuid: {added: [ids], changed: {id: [changed col uuids]}}}.
create or replace function public._touched(p_actions jsonb, p_inverse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb;
  op jsonb;
  rec jsonb;
  old jsonb;
  t text;
  k text;
  v_changed jsonb;
begin
  for op in select value from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb)) loop
    t := op->>'table';
    if op->>'op' = 'AddRecords' then
      v_out := jsonb_set(v_out, array[t], coalesce(v_out->t, '{}'::jsonb), true);
      v_out := jsonb_set(v_out, array[t, 'added'],
        coalesce(v_out->t->'added', '[]'::jsonb) || coalesce((select jsonb_agg(r->'id') from jsonb_array_elements(op->'records') r where r->>'id' is not null), '[]'::jsonb), true);
    elsif op->>'op' = 'UpdateRecords' then
      for rec in select value from jsonb_array_elements(coalesce(op->'records', '[]'::jsonb)) loop
        continue when rec->>'id' is null;   -- nothing was changed for a record without an id
        -- the old values of this record, from the inverse bundle
        select r->'values' into old
        from jsonb_array_elements(coalesce(p_inverse, '[]'::jsonb)) i, jsonb_array_elements(coalesce(i->'records', '[]'::jsonb)) r
        where i->>'op' = 'UpdateRecords' and i->>'table' = t and r->>'id' = rec->>'id'
        limit 1;
        continue when old is null;   -- the record wasn't there: nothing changed
        v_changed := '[]'::jsonb;
        for k in select jsonb_object_keys(coalesce(rec->'values', '{}'::jsonb)) loop
          if (old->k) is distinct from (rec->'values'->k) then
            v_changed := v_changed || to_jsonb(k);
          end if;
        end loop;
        if jsonb_array_length(v_changed) > 0 then
          v_out := jsonb_set(v_out, array[t], coalesce(v_out->t, '{}'::jsonb), true);
          v_out := jsonb_set(v_out, array[t, 'changed'], coalesce(v_out->t->'changed', '{}'::jsonb), true);
          v_out := jsonb_set(v_out, array[t, 'changed', rec->>'id'],
            coalesce(v_out->t->'changed'->(rec->>'id'), '[]'::jsonb) || v_changed, true);
        end if;
      end loop;
    end if;
  end loop;
  return v_out;
end $$;

revoke execute on function public._touched(jsonb, jsonb) from public, anon, authenticated;
