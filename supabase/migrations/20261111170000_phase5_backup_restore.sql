-- Phase 5: document backup files and restoring them as a new document.
--
--  * doc_backup(doc): {format: "lmdu-backup", version: 1, name, exported_at,
--    content (tables, columns, rows, pages, widgets), access (rules, user
--    attributes, settings; owners only)}. Readers may download one unless the
--    document has access rules or blocks copies; then only owners.
--  * restore_backup(workspace, name, backup): creates a new document with new
--    ids throughout. References are re-pointed; attachment files are not in
--    backups, so attachment cells are left empty. Nothing existing is replaced.

create or replace function public.doc_backup(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
  v_access jsonb;
begin
  if public.doc_role(p_doc) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  perform public._acl_require_full_access(p_doc, 'download a backup');
  select name into v_name from public.documents where id = p_doc;
  if public.doc_role(p_doc) = 'owner' then
    v_access := jsonb_build_object(
      'rules', coalesce((select jsonb_agg(jsonb_build_object('table_ref', r.table_ref, 'col_ids', to_jsonb(r.col_ids), 'condition', r.condition,
                           'condition_ast', r.condition_ast, 'permissions', r.permissions, 'memo', r.memo, 'position', r.position)
                         order by r.position, r.id) from public.doc_access_rules r where r.doc_id = p_doc), '[]'::jsonb),
      'attributes', coalesce((select jsonb_agg(jsonb_build_object('name', a.name, 'user_field', a.user_field, 'table_ref', a.table_ref,
                                'match_col', a.match_col) order by a.name) from public.doc_user_attributes a where a.doc_id = p_doc), '[]'::jsonb),
      'settings', (select jsonb_build_object('editors_structure', s.editors_structure, 'block_copies', s.block_copies,
                                             'public_rules', s.public_rules) from public.doc_access_settings s where s.doc_id = p_doc));
  end if;
  return jsonb_build_object('format', 'lmdu-backup', 'version', 1, 'name', v_name, 'exported_at', now(),
                            'content', public._doc_content(p_doc), 'access', v_access);
end $$;

-- The items of a backup section, refusing anything that isn't a list of objects with uuid ids.
create or replace function public._backup_items(p_content jsonb, p_key text, p_need_id boolean default true)
returns setof jsonb language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_content -> p_key;
  x jsonb;
begin
  if v is null or v = 'null'::jsonb then
    return;
  end if;
  if jsonb_typeof(v) <> 'array' then
    raise exception 'This backup file is damaged (% is not a list)', p_key using errcode = '22023';
  end if;
  for x in select value from jsonb_array_elements(v) loop
    if jsonb_typeof(x) <> 'object' or (p_need_id and coalesce(x->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'This backup file is damaged (bad entry in %)', p_key using errcode = '22023';
    end if;
    return next x;
  end loop;
end $$;

create or replace function public.restore_backup(p_workspace uuid, p_name text, p_backup jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := p_backup -> 'content';
  v_new uuid;
  v_map jsonb := '{}'::jsonb;
  v_rows jsonb := '{}'::jsonb;
  x jsonb;
  v_id bigint;
  v_col record;
begin
  if auth.uid() is null then
    raise exception 'Sign in to restore a backup' using errcode = '42501';
  end if;
  if p_backup is null or p_backup->>'format' <> 'lmdu-backup' or coalesce((p_backup->>'version')::int, 0) <> 1
     or coalesce(jsonb_typeof(c), '') <> 'object' then
    raise exception 'This isn''t an LM Data Universe backup file' using errcode = '22023';
  end if;
  if pg_column_size(p_backup) > 100 * 1024 * 1024 then
    raise exception 'This backup is too large to restore here (100 MB at most)' using errcode = '22023';
  end if;
  if p_workspace is null or not coalesce(p_workspace = any (public.my_workspace_ids(2)), false) then
    raise exception 'You can''t add documents to that workspace' using errcode = '42501';
  end if;

  -- New ids for everything that has one.
  select v_map || coalesce(jsonb_object_agg(i->>'id', gen_random_uuid()::text), '{}') into v_map
  from (select public._backup_items(c, 'tables') i union all select public._backup_items(c, 'columns')
        union all select public._backup_items(c, 'pages') union all select public._backup_items(c, 'widgets')) s;

  insert into public.documents (workspace_id, name, created_by)
  values (p_workspace, left(coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_backup->>'name'), ''), 'Restored document'), 200), auth.uid())
  returning id into v_new;

  insert into public.doc_tables (id, doc_id, table_id, position)
  select (v_map->>(t->>'id'))::uuid, v_new, t->>'table_id', coalesce((t->>'position')::double precision, 0)
  from public._backup_items(c, 'tables') t;

  insert into public.doc_columns (id, doc_id, table_ref, col_id, label, type, is_formula, formula, options, position)
  select (v_map->>(k->>'id'))::uuid, v_new, (v_map->>(k->>'table_ref'))::uuid, k->>'col_id', coalesce(k->>'label', ''),
         coalesce(k->>'type', 'Any'), coalesce((k->>'is_formula')::boolean, false), coalesce(k->>'formula', ''),
         public._remap(coalesce(k->'options', '{}'::jsonb), v_map), coalesce((k->>'position')::double precision, 0)
  from public._backup_items(c, 'columns') k;

  for x in select * from public._backup_items(c, 'rows', false) loop
    if coalesce(x->>'id', '') !~ '^\d{1,18}$' or not v_map ? coalesce(x->>'table_ref', '') then
      raise exception 'This backup file is damaged (bad row)' using errcode = '22023';
    end if;
    insert into public.doc_rows (doc_id, table_ref, manual_sort, data)
    values (v_new, (v_map->>(x->>'table_ref'))::uuid, coalesce((x->>'manual_sort')::double precision, (x->>'id')::double precision),
            public._remap(coalesce(x->'data', '{}'::jsonb), v_map))
    returning id into v_id;
    v_rows := v_rows || jsonb_build_object(x->>'id', v_id);
  end loop;

  -- References point at the new row ids; attachment files aren't in backups.
  for v_col in select id, type from public.doc_columns where doc_id = v_new and not is_formula and type in ('Ref', 'RefList', 'Attachments') loop
    if v_col.type = 'Ref' then
      update public.doc_rows set data = jsonb_set(data, array[v_col.id::text], coalesce(v_rows->(data->>v_col.id::text), 'null'))
      where doc_id = v_new and jsonb_typeof(data->v_col.id::text) = 'number';
    elsif v_col.type = 'RefList' then
      update public.doc_rows set data = jsonb_set(data, array[v_col.id::text], coalesce((
        select jsonb_agg(v_rows->(e #>> '{}')) filter (where v_rows ? (e #>> '{}'))
        from jsonb_array_elements(data->v_col.id::text) e), 'null'))
      where doc_id = v_new and jsonb_typeof(data->v_col.id::text) = 'array';
    else
      update public.doc_rows set data = data - v_col.id::text where doc_id = v_new and data ? v_col.id::text;
    end if;
  end loop;

  insert into public.doc_pages (id, doc_id, name, position, layout)
  select (v_map->>(p->>'id'))::uuid, v_new, coalesce(nullif(btrim(p->>'name'), ''), 'Page'), coalesce((p->>'position')::double precision, 0),
         public._remap(coalesce(p->'layout', '{}'::jsonb), v_map)
  from public._backup_items(c, 'pages') p;

  insert into public.doc_widgets (id, doc_id, page_id, table_ref, type, title, position, width, height, options)
  select (v_map->>(w->>'id'))::uuid, v_new, (v_map->>(w->>'page_id'))::uuid, (v_map->>(w->>'table_ref'))::uuid, w->>'type',
         coalesce(w->>'title', ''), coalesce((w->>'position')::double precision, 0), coalesce((w->>'width')::int, 12),
         coalesce((w->>'height')::int, 420), public._remap(coalesce(w->'options', '{}'::jsonb), v_map)
  from public._backup_items(c, 'widgets') w
  where v_map ? coalesce(w->>'page_id', '');
  update public.doc_widgets d set link_source = (v_map->>(w->>'link_source'))::uuid, link_col = (v_map->>(w->>'link_col'))::uuid
  from public._backup_items(c, 'widgets') w
  where d.id = (v_map->>(w->>'id'))::uuid and d.doc_id = v_new and (w->>'link_source' is not null or w->>'link_col' is not null);

  -- Access rules travel with the backup (when an owner made it).
  if jsonb_typeof(p_backup->'access') = 'object' then
    insert into public.doc_user_attributes (doc_id, name, user_field, table_ref, match_col)
    select v_new, a->>'name', coalesce(a->>'user_field', 'Email'), (v_map->>(a->>'table_ref'))::uuid, (v_map->>(a->>'match_col'))::uuid
    from public._backup_items(p_backup->'access', 'attributes', false) a
    where v_map ? coalesce(a->>'table_ref', '') and v_map ? coalesce(a->>'match_col', '');
    insert into public.doc_access_rules (doc_id, table_ref, col_ids, condition, condition_ast, permissions, memo, position)
    select v_new, (v_map->>(r->>'table_ref'))::uuid,
           coalesce((select array_agg((v_map->>e)::uuid) from jsonb_array_elements_text(coalesce(r->'col_ids', '[]')) e where v_map ? e), '{}'),
           coalesce(r->>'condition', ''), public._remap(nullif(r->'condition_ast', 'null'::jsonb), v_map),
           coalesce(r->'permissions', '{}'::jsonb), r->>'memo', coalesce((r->>'position')::int, 0)
    from public._backup_items(p_backup->'access', 'rules', false) r
    where r->>'table_ref' is null or v_map ? (r->>'table_ref');
    if jsonb_typeof(p_backup->'access'->'settings') = 'object' then
      insert into public.doc_access_settings (doc_id, editors_structure, block_copies, public_rules)
      values (v_new, coalesce((p_backup->'access'->'settings'->>'editors_structure')::boolean, true),
              coalesce((p_backup->'access'->'settings'->>'block_copies')::boolean, false),
              coalesce((p_backup->'access'->'settings'->>'public_rules')::boolean, false))
      on conflict (doc_id) do nothing;
    end if;
  end if;

  perform public._after_replace(v_new, jsonb_build_object('op', 'Restore', 'from', 'backup', 'exported_at', p_backup->'exported_at'));
  return v_new;
end $$;

revoke execute on function public._backup_items(jsonb, text, boolean) from public, anon, authenticated;
revoke execute on function public.doc_backup(uuid), public.restore_backup(uuid, text, jsonb) from public, anon;
grant execute on function public.doc_backup(uuid), public.restore_backup(uuid, text, jsonb) to authenticated;
