-- Phase 0: every change to document content is an "action".
--
-- apply_actions(doc, actions) is the only write path for tables, columns,
-- rows, pages and widgets. In one transaction it checks the caller's role,
-- applies each operation, and logs the bundle with its exact inverse in
-- doc_actions. Undo/redo replay inverses server-side, so they survive reloads
-- and work across tabs and devices.
--
-- Operations (JSON objects with an "op" key):
--   {op: "AddRecords",    table, records: [{id?, manual_sort?, data}]}
--   {op: "UpdateRecords", table, records: [{id, values, manual_sort?}]}   -- values merge into data
--   {op: "RemoveRecords", table, ids: [...]}
--   {op: "Add",    entity, row: {...}}          -- entity: table | column | page | widget
--   {op: "Update", entity, id, patch: {...}}
--   {op: "Remove", entity, id}

-- ============================================================
-- Tables
-- ============================================================
create table public.doc_actions (
  id bigint generated always as identity primary key,
  doc_id uuid not null references public.documents(id) on delete cascade,
  author uuid references public.profiles(id) on delete set null,
  kind text not null default 'do' check (kind in ('do', 'undo', 'redo')),
  -- For undo: the action undone. For redo: the action whose effects are re-applied.
  target_id bigint references public.doc_actions(id) on delete set null,
  undoable boolean not null default true,
  source text not null default 'app' check (source in ('app', 'api', 'form', 'automation', 'assistant', 'system')),
  actions jsonb not null,
  inverse jsonb not null,
  created_at timestamptz not null default now()
);
create index doc_actions_doc_idx on public.doc_actions (doc_id, id);
create index doc_actions_author_idx on public.doc_actions (doc_id, author, id);

alter table public.doc_actions enable row level security;
create policy doc_actions_select on public.doc_actions for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[]));

-- Formula values computed on the server, keyed by column uuid.
alter table public.doc_rows add column computed jsonb not null default '{}'::jsonb;
create index doc_rows_data_gin on public.doc_rows using gin (data jsonb_path_ops);
create index doc_rows_computed_gin on public.doc_rows using gin (computed jsonb_path_ops);

-- ============================================================
-- Applying one operation
-- ============================================================
create or replace function public._entity_table(p_entity text)
returns text language sql immutable set search_path = '' as $$
  select case p_entity
    when 'table' then 'doc_tables'
    when 'column' then 'doc_columns'
    when 'page' then 'doc_pages'
    when 'widget' then 'doc_widgets'
  end
$$;

create or replace function public._entity_defaults(p_entity text)
returns jsonb language sql volatile set search_path = '' as $$
  select case p_entity
    when 'table' then jsonb_build_object('id', gen_random_uuid(), 'position', 0, 'created_at', now())
    when 'column' then jsonb_build_object('id', gen_random_uuid(), 'label', '', 'type', 'Any', 'is_formula', false,
      'formula', '', 'options', '{}'::jsonb, 'position', 0, 'created_at', now())
    when 'page' then jsonb_build_object('id', gen_random_uuid(), 'position', 0, 'created_at', now())
    when 'widget' then jsonb_build_object('id', gen_random_uuid(), 'title', '', 'position', 0, 'width', 12,
      'height', 420, 'options', '{}'::jsonb, 'link_source', null, 'link_col', null, 'created_at', now())
  end
$$;

-- Inserts an entity row; returns the stored row as jsonb.
create or replace function public._insert_entity(p_doc uuid, p_entity text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tbl text := public._entity_table(p_entity);
  v_row jsonb;
  v_new jsonb;
begin
  if v_tbl is null then
    raise exception 'Unknown entity %', p_entity;
  end if;
  v_row := public._entity_defaults(p_entity) || coalesce(p_row, '{}'::jsonb) || jsonb_build_object('doc_id', p_doc);
  execute format(
    'insert into public.%1$I select * from jsonb_populate_record(null::public.%1$I, $1) returning to_jsonb(%1$I.*)',
    v_tbl
  ) using v_row into v_new;
  -- Columns and widgets take doc_id from their parent; make sure it is this document.
  if (v_new->>'doc_id')::uuid is distinct from p_doc then
    raise exception 'The % belongs to another document', p_entity;
  end if;
  return v_new;
end $$;

-- Updates listed fields of an entity; returns the previous values of those fields.
create or replace function public._update_entity(p_doc uuid, p_entity text, p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tbl text := public._entity_table(p_entity);
  v_old jsonb;
  v_keys text[];
  v_set text;
begin
  execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.doc_id = $2 for update', v_tbl)
    using p_id, p_doc into v_old;
  if v_old is null then
    raise exception 'This % no longer exists', p_entity;
  end if;
  select array_agg(k) into v_keys
  from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) k
  where v_old ? k and k not in ('id', 'doc_id', 'created_at', 'table_ref');
  if v_keys is null then
    return '{}'::jsonb;
  end if;
  select string_agg(format('%1$I = r.%1$I', k), ', ') into v_set from unnest(v_keys) k;
  execute format(
    'update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I, $1) r where t.id = $2',
    v_tbl, v_set
  ) using v_old || p_patch, p_id;
  return (select jsonb_object_agg(k, v_old->k) from unnest(v_keys) k);
end $$;

-- Widgets re-created by an inverse are added without links first, then linked,
-- so links between restored widgets never point at a widget not yet restored.
create or replace function public._restore_widgets_ops(p_widgets jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('op', 'Add', 'entity', 'widget',
      'row', w || '{"link_source": null, "link_col": null}'::jsonb))
    from jsonb_array_elements(p_widgets) w
  ), '[]'::jsonb)
  || coalesce((
    select jsonb_agg(jsonb_build_object('op', 'Update', 'entity', 'widget', 'id', w->'id',
      'patch', jsonb_build_object('link_source', w->'link_source', 'link_col', w->'link_col')))
    from jsonb_array_elements(p_widgets) w
    where w->>'link_source' is not null or w->>'link_col' is not null
  ), '[]'::jsonb)
$$;

-- Applies one operation. Returns {result, inverse: [ops], resolved: op}.
-- "resolved" is the operation as applied (e.g. with new row ids), which is
-- what gets logged so a later redo reproduces the same ids.
create or replace function public._apply_op(p_doc uuid, p_op jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := p_op->>'op';
  v_entity text := p_op->>'entity';
  v_table uuid;
  v_uuid uuid;
  v_id bigint;
  v_rec jsonb;
  v_old jsonb;
  v_new jsonb;
  v_ids jsonb := '[]'::jsonb;
  v_records jsonb := '[]'::jsonb;
  v_inv jsonb := '[]'::jsonb;
  v_sort double precision;
  v_ms double precision;
  v_row public.doc_rows;
  v_k text;
  v_widgets jsonb;
begin
  if v_kind in ('AddRecords', 'UpdateRecords', 'RemoveRecords') then
    v_table := (p_op->>'table')::uuid;
    if not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
      raise exception 'Unknown table %', p_op->>'table';
    end if;
  end if;

  case v_kind
  when 'AddRecords' then
    select coalesce(max(manual_sort), 0) into v_sort from public.doc_rows where table_ref = v_table;
    for v_rec in select value from jsonb_array_elements(coalesce(p_op->'records', '[]'::jsonb)) loop
      if jsonb_typeof(v_rec->'manual_sort') = 'number' then
        v_ms := (v_rec->>'manual_sort')::double precision;
        v_sort := greatest(v_sort, v_ms);
      else
        v_sort := v_sort + 1;
        v_ms := v_sort;
      end if;
      if jsonb_typeof(v_rec->'id') = 'number' then
        insert into public.doc_rows (id, doc_id, table_ref, manual_sort, data, created_by)
        values ((v_rec->>'id')::bigint, p_doc, v_table, v_ms, coalesce(v_rec->'data', '{}'::jsonb),
                coalesce((v_rec->>'created_by')::uuid, auth.uid()))
        returning id into v_id;
      else
        insert into public.doc_rows (doc_id, table_ref, manual_sort, data, created_by)
        values (p_doc, v_table, v_ms, coalesce(v_rec->'data', '{}'::jsonb), auth.uid())
        returning id into v_id;
      end if;
      v_ids := v_ids || to_jsonb(v_id);
      v_records := v_records || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'manual_sort', v_ms, 'data', coalesce(v_rec->'data', '{}'::jsonb)));
    end loop;
    return jsonb_build_object(
      'result', v_ids,
      'inverse', jsonb_build_array(jsonb_build_object('op', 'RemoveRecords', 'table', v_table, 'ids', v_ids)),
      'resolved', jsonb_build_object('op', 'AddRecords', 'table', v_table, 'records', v_records));

  when 'UpdateRecords' then
    for v_rec in select value from jsonb_array_elements(coalesce(p_op->'records', '[]'::jsonb)) loop
      select * into v_row from public.doc_rows
      where id = (v_rec->>'id')::bigint and table_ref = v_table for update;
      if not found then
        continue; -- removed meanwhile
      end if;
      v_old := '{}'::jsonb;
      for v_k in select jsonb_object_keys(coalesce(v_rec->'values', '{}'::jsonb)) loop
        v_old := v_old || jsonb_build_object(v_k, coalesce(v_row.data->v_k, 'null'::jsonb));
      end loop;
      v_new := jsonb_build_object('id', v_row.id, 'values', v_old);
      if jsonb_typeof(v_rec->'manual_sort') = 'number' then
        v_new := v_new || jsonb_build_object('manual_sort', v_row.manual_sort);
      end if;
      v_records := v_records || jsonb_build_array(v_new);
      update public.doc_rows
      set data = data || coalesce(v_rec->'values', '{}'::jsonb),
          manual_sort = coalesce((v_rec->>'manual_sort')::double precision, manual_sort)
      where id = v_row.id;
    end loop;
    return jsonb_build_object(
      'result', null,
      'inverse', jsonb_build_array(jsonb_build_object('op', 'UpdateRecords', 'table', v_table, 'records', v_records)),
      'resolved', p_op);

  when 'RemoveRecords' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'manual_sort', manual_sort, 'data', data,
             'created_by', created_by) order by id), '[]'::jsonb)
    into v_records
    from public.doc_rows
    where table_ref = v_table and id in (select x::bigint from jsonb_array_elements_text(p_op->'ids') x);
    delete from public.doc_rows
    where table_ref = v_table and id in (select x::bigint from jsonb_array_elements_text(p_op->'ids') x);
    return jsonb_build_object(
      'result', null,
      'inverse', jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_table, 'records', v_records)),
      'resolved', p_op);

  when 'Add' then
    v_new := public._insert_entity(p_doc, v_entity, p_op->'row');
    return jsonb_build_object(
      'result', v_new->'id',
      'inverse', jsonb_build_array(jsonb_build_object('op', 'Remove', 'entity', v_entity, 'id', v_new->'id')),
      'resolved', jsonb_build_object('op', 'Add', 'entity', v_entity, 'row', v_new));

  when 'Update' then
    v_uuid := (p_op->>'id')::uuid;
    v_old := public._update_entity(p_doc, v_entity, v_uuid, p_op->'patch');
    return jsonb_build_object(
      'result', null,
      'inverse', jsonb_build_array(jsonb_build_object('op', 'Update', 'entity', v_entity, 'id', v_uuid, 'patch', v_old)),
      'resolved', p_op);

  when 'Remove' then
    v_uuid := (p_op->>'id')::uuid;
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.doc_id = $2 for update',
                   public._entity_table(v_entity))
      using v_uuid, p_doc into v_old;
    if v_old is null then
      return jsonb_build_object('result', null, 'inverse', '[]'::jsonb, 'resolved', p_op);
    end if;
    v_inv := jsonb_build_array(jsonb_build_object('op', 'Add', 'entity', v_entity, 'row', v_old));

    if v_entity = 'table' then
      -- Columns, rows and every widget showing the table are removed with it.
      v_inv := v_inv || coalesce((
        select jsonb_agg(jsonb_build_object('op', 'Add', 'entity', 'column', 'row', to_jsonb(c)) order by c.position)
        from public.doc_columns c where c.table_ref = v_uuid), '[]'::jsonb);
      v_inv := v_inv || jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_uuid, 'records', coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'manual_sort', r.manual_sort, 'data', r.data,
                 'created_by', r.created_by) order by r.id)
        from public.doc_rows r where r.table_ref = v_uuid), '[]'::jsonb)));
      select coalesce(jsonb_agg(to_jsonb(w) order by w.position), '[]'::jsonb) into v_widgets
      from public.doc_widgets w where w.table_ref = v_uuid;
    elsif v_entity = 'page' then
      select coalesce(jsonb_agg(to_jsonb(w) order by w.position), '[]'::jsonb) into v_widgets
      from public.doc_widgets w where w.page_id = v_uuid;
    elsif v_entity = 'widget' then
      v_widgets := '[]'::jsonb;
    end if;

    if v_widgets is not null then
      v_inv := v_inv || public._restore_widgets_ops(v_widgets);
      -- Other widgets linked to a removed widget lose their link; restore it.
      v_inv := v_inv || coalesce((
        select jsonb_agg(jsonb_build_object('op', 'Update', 'entity', 'widget', 'id', w.id,
                 'patch', jsonb_build_object('link_source', w.link_source, 'link_col', w.link_col)))
        from public.doc_widgets w
        where w.doc_id = p_doc
          and (w.link_source = v_uuid
               or w.link_source in (select (x->>'id')::uuid from jsonb_array_elements(v_widgets) x))
          and w.id not in (select (x->>'id')::uuid from jsonb_array_elements(v_widgets) x)), '[]'::jsonb);
    elsif v_entity = 'column' then
      -- Widgets filtered by this column lose the link; restore it.
      v_inv := v_inv || coalesce((
        select jsonb_agg(jsonb_build_object('op', 'Update', 'entity', 'widget', 'id', w.id,
                 'patch', jsonb_build_object('link_col', w.link_col)))
        from public.doc_widgets w where w.link_col = v_uuid), '[]'::jsonb);
    end if;

    execute format('delete from public.%I where id = $1 and doc_id = $2', public._entity_table(v_entity))
      using v_uuid, p_doc;
    return jsonb_build_object('result', null, 'inverse', v_inv, 'resolved', p_op);

  else
    raise exception 'Unknown operation %', coalesce(v_kind, '(none)');
  end case;
end $$;

-- ============================================================
-- Bundles, logging, undo and redo
-- ============================================================
create or replace function public._apply_and_log(
  p_doc uuid, p_actions jsonb, p_kind text, p_target bigint, p_undoable boolean, p_source text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_op jsonb;
  v_r jsonb;
  v_results jsonb := '[]'::jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_inverse jsonb := '[]'::jsonb;
  v_id bigint;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    raise exception 'Actions must be a JSON array';
  end if;
  for v_op in select value from jsonb_array_elements(p_actions) loop
    v_r := public._apply_op(p_doc, v_op);
    v_results := v_results || jsonb_build_array(v_r->'result');
    v_resolved := v_resolved || jsonb_build_array(v_r->'resolved');
    v_inverse := (v_r->'inverse') || v_inverse; -- undo runs in reverse order
  end loop;
  insert into public.doc_actions (doc_id, author, kind, target_id, undoable, source, actions, inverse)
  values (p_doc, auth.uid(), p_kind, p_target, p_undoable, p_source, v_resolved, v_inverse)
  returning id into v_id;
  return jsonb_build_object('action_id', v_id, 'results', v_results, 'applied', v_resolved);
end $$;

-- The caller's undo and redo stacks, rebuilt from their recent history.
create or replace function public._undo_stacks(p_doc uuid, out undo_ids bigint[], out redo_ids bigint[])
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
begin
  undo_ids := '{}';
  redo_ids := '{}';
  for r in
    select id, kind, target_id from (
      select a.id, a.kind, a.target_id from public.doc_actions a
      where a.doc_id = p_doc and a.author = auth.uid() and a.undoable
      order by a.id desc limit 500
    ) recent order by id
  loop
    if r.kind = 'do' then
      undo_ids := undo_ids || r.id;
      redo_ids := '{}';
    elsif r.kind = 'undo' then
      undo_ids := array_remove(undo_ids, r.target_id);
      redo_ids := redo_ids || r.target_id;
    else
      redo_ids := array_remove(redo_ids, r.target_id);
      undo_ids := undo_ids || r.id;
    end if;
  end loop;
end $$;

create or replace function public._require_editor(p_doc uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.doc_role(p_doc), '') not in ('owner', 'editor') then
    raise exception 'You don''t have permission to edit this document' using errcode = '42501';
  end if;
end $$;

create or replace function public.apply_actions(
  p_doc uuid, p_actions jsonb, p_undoable boolean default true, p_source text default 'app'
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_editor(p_doc);
  if p_source not in ('app', 'api', 'assistant') then
    raise exception 'Invalid source %', p_source;
  end if;
  return public._apply_and_log(p_doc, p_actions, 'do', null, p_undoable, p_source);
end $$;

create or replace function public.undo_state(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s record;
begin
  select * into s from public._undo_stacks(p_doc);
  return jsonb_build_object('can_undo', cardinality(s.undo_ids) > 0, 'can_redo', cardinality(s.redo_ids) > 0);
end $$;

create or replace function public.undo_action(p_doc uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s record;
  v_target bigint;
  v_out jsonb;
begin
  perform public._require_editor(p_doc);
  select * into s from public._undo_stacks(p_doc);
  v_target := s.undo_ids[cardinality(s.undo_ids)];
  if v_target is null then
    return null;
  end if;
  v_out := public._apply_and_log(p_doc, (select inverse from public.doc_actions where id = v_target), 'undo', v_target, true, 'app');
  return v_out || public.undo_state(p_doc);
end $$;

create or replace function public.redo_action(p_doc uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s record;
  v_target bigint;
  v_out jsonb;
begin
  perform public._require_editor(p_doc);
  select * into s from public._undo_stacks(p_doc);
  v_target := s.redo_ids[cardinality(s.redo_ids)];
  if v_target is null then
    return null;
  end if;
  v_out := public._apply_and_log(p_doc, (select actions from public.doc_actions where id = v_target), 'redo', v_target, true, 'app');
  return v_out || public.undo_state(p_doc);
end $$;

-- Server-computed formula values (written by the compute worker as the user).
create or replace function public.set_computed(p_doc uuid, p_updates jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public._require_editor(p_doc);
  update public.doc_rows r
  set computed = u.computed
  from jsonb_to_recordset(p_updates) as u(id bigint, computed jsonb)
  where r.id = u.id and r.doc_id = p_doc and r.computed is distinct from u.computed;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Public form submissions go through the same path, so they are logged too.
create or replace function public.submit_public_form(p_token text, p_values jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_widget public.doc_widgets;
  v_data jsonb := '{}'::jsonb;
  v_field record;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' or pg_column_size(p_values) > 65536 then
    raise exception 'Invalid submission';
  end if;
  select w.* into v_widget
  from public.form_shares s join public.doc_widgets w on w.id = s.widget_id
  where s.token = p_token and s.is_active;
  if v_widget.id is null then
    raise exception 'This form is not accepting responses';
  end if;
  for v_field in
    select c.id, coalesce((f.value->>'required')::boolean, false) as required
    from jsonb_array_elements(coalesce(v_widget.options->'fields', '[]'::jsonb)) f
    join public.doc_columns c on c.id = (f.value->>'col')::uuid
    where c.table_ref = v_widget.table_ref and not c.is_formula and c.type not in ('Ref', 'RefList')
  loop
    if p_values ? v_field.id::text and p_values->(v_field.id::text) <> 'null'::jsonb
       and p_values->(v_field.id::text) <> '""'::jsonb then
      v_data := v_data || jsonb_build_object(v_field.id::text, p_values->(v_field.id::text));
    elsif v_field.required then
      raise exception 'Please fill in all required fields';
    end if;
  end loop;
  perform public._apply_and_log(
    v_widget.doc_id,
    jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_widget.table_ref,
      'records', jsonb_build_array(jsonb_build_object('data', v_data)))),
    'do', null, false, 'form');
  return true;
end $$;

-- ============================================================
-- Lock down direct writes: content changes only through apply_actions.
-- ============================================================
revoke insert, update, delete on public.doc_tables, public.doc_columns, public.doc_rows,
  public.doc_pages, public.doc_widgets from authenticated, anon;
drop function if exists public.update_row_cells(jsonb);

revoke execute on function
  public._entity_table(text), public._entity_defaults(text), public._insert_entity(uuid, text, jsonb),
  public._update_entity(uuid, text, uuid, jsonb), public._restore_widgets_ops(jsonb), public._apply_op(uuid, jsonb),
  public._apply_and_log(uuid, jsonb, text, bigint, boolean, text), public._undo_stacks(uuid),
  public._require_editor(uuid)
from public, anon, authenticated;
revoke execute on function
  public.apply_actions(uuid, jsonb, boolean, text), public.undo_state(uuid), public.undo_action(uuid),
  public.redo_action(uuid), public.set_computed(uuid, jsonb)
from public, anon;
grant execute on function
  public.apply_actions(uuid, jsonb, boolean, text), public.undo_state(uuid), public.undo_action(uuid),
  public.redo_action(uuid), public.set_computed(uuid, jsonb)
to authenticated;
