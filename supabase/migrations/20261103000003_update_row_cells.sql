-- Merge cell values into rows instead of replacing the whole data object, so two
-- people editing different cells of the same row don't overwrite each other.
-- p_updates: [{"id": 12, "values": {"<column uuid>": <value>, ...}}, ...]
create or replace function public.update_row_cells(p_updates jsonb)
returns setof public.doc_rows
language plpgsql security invoker set search_path = '' as $$
declare
  u jsonb;
begin
  for u in select value from jsonb_array_elements(p_updates) loop
    return query
      update public.doc_rows
      set data = data || coalesce(u->'values', '{}'::jsonb)
      where id = (u->>'id')::bigint
      returning *;
  end loop;
end $$;

revoke execute on function public.update_row_cells(jsonb) from public, anon;
grant execute on function public.update_row_cells(jsonb) to authenticated;
