-- Phase 5: API keys, the REST API's database side, webhooks, automations and
-- a job queue for delivering them.
--
--  * api_keys: personal keys, stored only as a SHA-256 hash. An API call
--    resolves its key to the owner (_api_auth) and then runs exactly as that
--    person: the same role checks, access rules and write path (apply_actions,
--    source 'api') as the app.
--  * api_* functions: what the Next.js route handlers under /api/docs call.
--    Tables and columns are addressed by their names (table_id / col_id).
--  * doc_webhooks / doc_automations: owners only. A trigger on doc_actions
--    turns each change into jobs; conditions use the access-rule condition
--    language (rec.Status == "Done"), compiled to SQL as for rules.
--  * job_queue: drained by the `deliver` Edge Function (pg_net kick right
--    after a change, and pg_cron every minute for retries with backoff).

-- ============================================================
-- API keys
-- ============================================================
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  prefix text not null,
  hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  window_start timestamptz,
  window_count int not null default 0
);
create index api_keys_user_idx on public.api_keys (user_id);
alter table public.api_keys enable row level security;
revoke all on public.api_keys from anon, authenticated;
grant select (id, label, prefix, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
create policy api_keys_own on public.api_keys for select to authenticated using (user_id = (select auth.uid()));

-- Creates a key and returns it once: {id, key}. Only its hash is kept.
create or replace function public.create_api_key(p_label text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in to create API keys' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_label, ''))) not between 1 and 80 then
    raise exception 'Give the key a name (up to 80 characters)';
  end if;
  if (select count(*) from public.api_keys where user_id = v_user and revoked_at is null) >= 20 then
    raise exception 'You can have up to 20 active keys. Revoke one first.';
  end if;
  v_key := 'lmdu_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (user_id, label, prefix, hash)
  values (v_user, btrim(p_label), left(v_key, 13), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key);
end $$;

create or replace function public.revoke_api_key(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.api_keys set revoked_at = now()
  where id = p_id and user_id = auth.uid() and revoked_at is null;
  if not found then
    raise exception 'Key not found' using errcode = 'P0002';
  end if;
end $$;

-- Resolves an API key to its owner and makes the rest of this call run as
-- that person (auth.uid() reads request.jwt.claim.sub). 600 calls a minute per key.
create or replace function public._api_auth(p_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_count int;
begin
  if p_key is null or p_key !~ '^lmdu_[0-9a-f]{48}$' then
    raise exception 'Invalid API key' using errcode = 'PT401';
  end if;
  update public.api_keys k set
    window_count = case when k.window_start > now() - interval '1 minute' then k.window_count + 1 else 1 end,
    window_start = case when k.window_start > now() - interval '1 minute' then k.window_start else now() end,
    last_used_at = now()
  where k.hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') and k.revoked_at is null
  returning k.user_id, k.window_count into v_user, v_count;
  if v_user is null then
    raise exception 'Invalid API key' using errcode = 'PT401';
  end if;
  if v_count > 600 then
    raise exception 'Too many requests: 600 a minute per key' using errcode = 'PT429';
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return v_user;
end $$;

-- ============================================================
-- API helpers
-- ============================================================
create or replace function public._api_doc(p_doc uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.doc_role(p_doc);
begin
  if v_role is null or exists (select 1 from public.documents where id = p_doc and deleted_at is not null) then
    raise exception 'Document not found' using errcode = 'PT404';
  end if;
  return v_role;
end $$;

-- A table by its name (or id).
create or replace function public._api_table(p_doc uuid, p_table text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.doc_tables
  where doc_id = p_doc and (table_id = p_table or id::text = p_table)
  order by (table_id = p_table) desc limit 1;
  if v_id is null then
    raise exception 'Table % not found', p_table using errcode = 'PT404';
  end if;
  return v_id;
end $$;

-- Columns of a table the caller may see: [{id (uuid), col_id, type, is_formula, ...}].
create or replace function public._api_cols(p_doc uuid, p_table uuid)
returns setof public.doc_columns language sql stable security definer set search_path = '' as $$
  select c.* from public.doc_columns c
  where c.table_ref = p_table and not public._acl_col_hidden(p_doc, p_table, c.id)
  order by c.position, c.col_id
$$;

-- SQL selecting the records of a table as the caller may read them.
create or replace function public._api_read_sql(p_doc uuid, p_table uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if public._acl_ruled(p_doc) then
    return public._acl_read_sql(p_doc, p_table, public._acl_ctx_me(p_doc));
  end if;
  return format('select r.id, r.table_ref, r.manual_sort, r.data, r.computed from public.doc_rows r '
                'where r.table_ref = %L and r.doc_id = %L', p_table, p_doc);
end $$;

-- {ColId: value} -> {col uuid: value} for writing; refuses unknown and formula columns.
create or replace function public._api_values(p_doc uuid, p_table uuid, p_fields jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb;
  k text;
  c public.doc_columns;
begin
  if p_fields is null or p_fields = 'null'::jsonb then
    return v_out;
  end if;
  if jsonb_typeof(p_fields) <> 'object' then
    raise exception '"fields" must be an object' using errcode = 'PT400';
  end if;
  for k in select jsonb_object_keys(p_fields) loop
    select * into c from public._api_cols(p_doc, p_table) x where x.col_id = k or x.id::text = k
    order by (x.col_id = k) desc limit 1;
    if c.id is null then
      raise exception 'Unknown column %', k using errcode = 'PT400';
    end if;
    if c.is_formula then
      raise exception 'Column % is a formula column', k using errcode = 'PT400';
    end if;
    if pg_column_size(p_fields->k) > 100000 then
      raise exception 'Value of % is too large', k using errcode = 'PT400';
    end if;
    v_out := v_out || jsonb_build_object(c.id::text, p_fields->k);
  end loop;
  return v_out;
end $$;

-- Records as the API returns them: [{id, fields: {ColId: value}}], formula values included.
-- p_where is SQL over x (id, data, computed).
create or replace function public._api_select(p_doc uuid, p_table uuid, p_where text, p_order text, p_limit int, p_sql text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_fields text := '';
  v_out jsonb;
  c record;
begin
  for c in select * from public._api_cols(p_doc, p_table) loop
    v_fields := v_fields || format(', %L, case when x.%s ? %L then x.%s -> %L end',
      c.col_id, case when c.is_formula then 'computed' else 'data' end, c.id::text,
      case when c.is_formula then 'computed' else 'data' end, c.id::text);
  end loop;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', x.id, ''fields'', jsonb_strip_nulls(jsonb_build_object(%s))) order by %s), ''[]''::jsonb) '
    'from (select * from (%s) x where %s order by %s limit %s) x',
    coalesce(nullif(substr(v_fields, 3), ''), '''_'', null'), coalesce(p_order, 'x.id'),
    coalesce(p_sql, public._api_read_sql(p_doc, p_table)), coalesce(p_where, 'true'), coalesce(p_order, 'x.id'),
    least(greatest(coalesce(p_limit, 10000), 1), 10000))
  into v_out;
  return v_out;
end $$;

-- SQL testing that each {ColId: value} matches (for filters and upsert "require").
create or replace function public._api_match_sql(p_doc uuid, p_table uuid, p_require jsonb, p_any boolean)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_sql text := 'true';
  k text;
  c public.doc_columns;
  v_src text;
begin
  if p_require is null or p_require = '{}'::jsonb then
    return 'true';
  end if;
  if coalesce(jsonb_typeof(p_require), '') <> 'object' then
    raise exception 'Expected an object of column values' using errcode = 'PT400';
  end if;
  for k in select jsonb_object_keys(p_require) loop
    select * into c from public._api_cols(p_doc, p_table) x where x.col_id = k or x.id::text = k
    order by (x.col_id = k) desc limit 1;
    if c.id is null then
      raise exception 'Unknown column %', k using errcode = 'PT400';
    end if;
    v_src := format('coalesce(x.%s -> %L, ''null''::jsonb)', case when c.is_formula then 'computed' else 'data' end, c.id::text);
    if p_any then
      -- filter: {"Col": [v1, v2]} matches any of the values
      if coalesce(jsonb_typeof(p_require->k), '') <> 'array' then
        raise exception 'Filter values for % must be a list', k using errcode = 'PT400';
      end if;
      v_sql := v_sql || format(' and %s in (select jsonb_array_elements(%L::jsonb))', v_src, (p_require->k)::text);
    else
      v_sql := v_sql || format(' and %s = %L::jsonb', v_src, coalesce(p_require->k, 'null'::jsonb)::text);
    end if;
  end loop;
  return v_sql;
end $$;

-- ============================================================
-- API: reading
-- ============================================================
create or replace function public.api_tables(p_key text, p_doc uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  return jsonb_build_object('tables', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.table_id, 'fields', jsonb_build_object('ref', t.id)) order by t.position, t.table_id)
    from public.doc_tables t where t.doc_id = p_doc), '[]'::jsonb));
end $$;

create or replace function public.api_columns(p_key text, p_doc uuid, p_table text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  return jsonb_build_object('columns', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.col_id, 'fields', jsonb_strip_nulls(jsonb_build_object(
      'label', coalesce(nullif(c.label, ''), c.col_id), 'type', c.type, 'isFormula', c.is_formula,
      'formula', nullif(c.formula, ''), 'choices', c.options->'choices',
      'refTable', (select t.table_id from public.doc_tables t where t.id::text = c.options->>'refTable')))))
    from public._api_cols(p_doc, v_table) c), '[]'::jsonb));
end $$;

-- GET records. p_filter: {"ColId": [values]}; p_sort: "ColId,-Other".
create or replace function public.api_records(
  p_key text, p_doc uuid, p_table text, p_filter jsonb default null, p_sort text default null, p_limit int default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
  v_order text := '';
  s text;
  v_desc boolean;
  c public.doc_columns;
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  for s in select btrim(x) from unnest(string_to_array(coalesce(p_sort, ''), ',')) x where btrim(x) <> '' loop
    v_desc := left(s, 1) = '-';
    s := ltrim(s, '-+ ');
    select * into c from public._api_cols(p_doc, v_table) x where x.col_id = s or (s = 'id' and false) limit 1;
    if s = 'id' then
      v_order := v_order || case when v_desc then 'x.id desc, ' else 'x.id, ' end;
      continue;
    end if;
    if c.id is null then
      raise exception 'Unknown sort column %', s using errcode = 'PT400';
    end if;
    v_order := v_order || format('x.%s -> %L %s nulls last, ', case when c.is_formula then 'computed' else 'data' end,
                                 c.id::text, case when v_desc then 'desc' else 'asc' end);
  end loop;
  return jsonb_build_object('records', public._api_select(
    p_doc, v_table, public._api_match_sql(p_doc, v_table, p_filter, true), v_order || 'x.id', p_limit));
end $$;

-- ============================================================
-- API: writing (all through apply_actions, source 'api')
-- ============================================================
create or replace function public.api_add_records(p_key text, p_doc uuid, p_table text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
  v_recs jsonb := '[]'::jsonb;
  r jsonb;
  v_res jsonb;
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  if coalesce(jsonb_typeof(p_records), '') <> 'array' or jsonb_array_length(p_records) > 5000 then
    raise exception '"records" must be a list of up to 5000 records' using errcode = 'PT400';
  end if;
  for r in select value from jsonb_array_elements(p_records) loop
    v_recs := v_recs || jsonb_build_array(jsonb_build_object('data', public._api_values(p_doc, v_table, r->'fields')));
  end loop;
  if jsonb_array_length(v_recs) = 0 then
    return jsonb_build_object('records', '[]'::jsonb);
  end if;
  v_res := public.apply_actions(p_doc, jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_table, 'records', v_recs)), true, 'api');
  return jsonb_build_object('records', (select jsonb_agg(jsonb_build_object('id', x)) from jsonb_array_elements(v_res->'results'->0) x));
end $$;

create or replace function public.api_update_records(p_key text, p_doc uuid, p_table text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
  v_recs jsonb := '[]'::jsonb;
  r jsonb;
  v_missing bigint;
  v_ok boolean;
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  if coalesce(jsonb_typeof(p_records), '') <> 'array' or jsonb_array_length(p_records) > 5000 then
    raise exception '"records" must be a list of up to 5000 records' using errcode = 'PT400';
  end if;
  for r in select value from jsonb_array_elements(p_records) loop
    if coalesce(jsonb_typeof(r->'id'), '') <> 'number' then
      raise exception 'Each record needs a numeric "id"' using errcode = 'PT400';
    end if;
    execute format('select exists (select 1 from (%s) x where x.id = $1)', public._api_read_sql(p_doc, v_table))
    into v_ok using (r->>'id')::bigint;
    if not v_ok then
      raise exception 'Record % not found in %', r->>'id', p_table using errcode = 'PT404';
    end if;
    v_recs := v_recs || jsonb_build_array(jsonb_build_object('id', (r->>'id')::bigint, 'values', public._api_values(p_doc, v_table, r->'fields')));
  end loop;
  if jsonb_array_length(v_recs) > 0 then
    perform public.apply_actions(p_doc, jsonb_build_array(jsonb_build_object('op', 'UpdateRecords', 'table', v_table, 'records', v_recs)), true, 'api');
  end if;
  return '{}'::jsonb;
end $$;

-- PUT records: [{require: {ColId: v}, fields: {...}}]. Adds a record when none
-- matches (unless p_add is false), updates the first (or all, p_onmany = 'all';
-- or none, 'none') match otherwise (unless p_update is false).
create or replace function public.api_upsert_records(
  p_key text, p_doc uuid, p_table text, p_records jsonb,
  p_onmany text default 'first', p_add boolean default true, p_update boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
  v_read text;
  r jsonb;
  v_ids bigint[];
  v_adds jsonb := '[]'::jsonb;
  v_updates jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_values jsonb;
  v_res jsonb;
  v_added int := 0;
  v_updated int := 0;
  i bigint;
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  if coalesce(p_onmany, 'first') not in ('first', 'all', 'none') then
    raise exception 'onmany must be first, all or none' using errcode = 'PT400';
  end if;
  if coalesce(jsonb_typeof(p_records), '') <> 'array' or jsonb_array_length(p_records) > 5000 then
    raise exception '"records" must be a list of up to 5000 records' using errcode = 'PT400';
  end if;
  v_read := public._api_read_sql(p_doc, v_table);
  for r in select value from jsonb_array_elements(p_records) loop
    if coalesce(jsonb_typeof(coalesce(r->'require', '{}'::jsonb)), '') <> 'object' then
      raise exception '"require" must be an object' using errcode = 'PT400';
    end if;
    execute format('select array_agg(x.id order by x.id) from (%s) x where %s', v_read,
                   public._api_match_sql(p_doc, v_table, coalesce(r->'require', '{}'::jsonb), false))
    into v_ids;
    if coalesce(cardinality(v_ids), 0) = 0 or coalesce(r->'require', '{}'::jsonb) = '{}'::jsonb then
      if coalesce(p_add, true) then
        v_adds := v_adds || jsonb_build_array(jsonb_build_object('data',
          public._api_values(p_doc, v_table, coalesce(r->'require', '{}'::jsonb) || coalesce(r->'fields', '{}'::jsonb))));
        v_added := v_added + 1;
      end if;
    elsif coalesce(p_update, true) and not (cardinality(v_ids) > 1 and p_onmany = 'none') then
      v_values := public._api_values(p_doc, v_table, coalesce(r->'fields', '{}'::jsonb));
      foreach i in array case when p_onmany = 'all' then v_ids else v_ids[1:1] end loop
        v_updates := v_updates || jsonb_build_array(jsonb_build_object('id', i, 'values', v_values));
        v_updated := v_updated + 1;
      end loop;
    end if;
  end loop;
  if jsonb_array_length(v_adds) > 0 then
    v_actions := v_actions || jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_table, 'records', v_adds));
  end if;
  if jsonb_array_length(v_updates) > 0 then
    v_actions := v_actions || jsonb_build_array(jsonb_build_object('op', 'UpdateRecords', 'table', v_table, 'records', v_updates));
  end if;
  if jsonb_array_length(v_actions) > 0 then
    v_res := public.apply_actions(p_doc, v_actions, true, 'api');
  end if;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

create or replace function public.api_delete_records(p_key text, p_doc uuid, p_table text, p_ids jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid;
  v_found bigint[];
begin
  perform public._api_auth(p_key);
  perform public._api_doc(p_doc);
  v_table := public._api_table(p_doc, p_table);
  if coalesce(jsonb_typeof(p_ids), '') <> 'array' or jsonb_array_length(p_ids) > 5000
     or exists (select 1 from jsonb_array_elements(p_ids) x where jsonb_typeof(x) <> 'number') then
    raise exception 'Expected a list of up to 5000 record ids' using errcode = 'PT400';
  end if;
  execute format('select array_agg(x.id) from (%s) x where x.id in (select (v #>> ''{}'')::bigint from jsonb_array_elements($1) v)',
                 public._api_read_sql(p_doc, v_table))
  into v_found using p_ids;
  if coalesce(cardinality(v_found), 0) <> (select count(distinct v) from jsonb_array_elements(p_ids) v) then
    raise exception 'Some records were not found in %', p_table using errcode = 'PT404';
  end if;
  perform public.apply_actions(p_doc, jsonb_build_array(jsonb_build_object('op', 'RemoveRecords', 'table', v_table, 'ids', p_ids)), true, 'api');
  return '{}'::jsonb;
end $$;

-- ============================================================
-- Webhooks, automations and the job queue
-- ============================================================
-- Outgoing addresses: https only, and never a local or private network.
create or replace function public._safe_url(p_url text)
returns boolean language sql immutable set search_path = '' as $$
  select p_url ~* '^https://[^/\s:@]+(:\d+)?(/\S*)?$'
     and length(p_url) <= 2000
     and lower(substring(p_url from '^https://([^/:]+)')) !~ '^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\..*|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)'
$$;

create table public.doc_webhooks (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  table_ref uuid not null references public.doc_tables(id) on delete cascade,
  name text not null default '' check (length(name) <= 120),
  url text not null check (public._safe_url(url)),
  events text[] not null default '{add,update}' check (cardinality(events) > 0 and events <@ array['add', 'update']),
  ready_col uuid references public.doc_columns(id) on delete set null,
  secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_webhooks_doc_idx on public.doc_webhooks (doc_id);

create table public.doc_automations (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  table_ref uuid not null references public.doc_tables(id) on delete cascade,
  name text not null default '' check (length(name) <= 120),
  enabled boolean not null default true,
  trigger text not null default 'add_or_update' check (trigger in ('add', 'update', 'add_or_update')),
  watch_cols uuid[] not null default '{}',
  condition text not null default '' check (length(condition) <= 4000),
  condition_ast jsonb check (condition_ast is null or (jsonb_typeof(condition_ast) = 'object' and pg_column_size(condition_ast) < 32768)),
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array' and pg_column_size(actions) < 65536),
  secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_automations_doc_idx on public.doc_automations (doc_id);

create table public.job_queue (
  id bigint generated always as identity primary key,
  doc_id uuid not null references public.documents(id) on delete cascade,
  kind text not null check (kind in ('webhook', 'automation')),
  source_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  next_run_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_status int,
  last_error text,
  created_at timestamptz not null default now()
);
create index job_queue_due_idx on public.job_queue (next_run_at) where status in ('pending', 'running');
create index job_queue_source_idx on public.job_queue (source_id, id desc);
create index job_queue_doc_idx on public.job_queue (doc_id, created_at desc);

alter table public.doc_webhooks enable row level security;
alter table public.doc_automations enable row level security;
alter table public.job_queue enable row level security;
revoke all on public.doc_webhooks, public.doc_automations, public.job_queue from anon, authenticated;

-- Asks the `deliver` Edge Function to run now (it also runs every minute).
create or replace function public._kick_jobs()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.job_queue where status in ('pending', 'running') and next_run_at <= now() + interval '5 seconds') then
    return;
  end if;
  select replace(decrypted_secret, '/doc-worker', '/deliver') into v_url from vault.decrypted_secrets where name = 'doc_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'doc_worker_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    body := '{}'::jsonb
  );
end $$;

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

-- The person an integration acts as: its creator (falling back to the owner).
create or replace function public._integration_ctx(p_doc uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := p_user;
begin
  if v_user is null or public._role_of(p_doc, v_user) is null then
    select d.created_by into v_user from public.documents d where d.id = p_doc;
  end if;
  return public._acl_ctx(p_doc, v_user, coalesce(public._role_of(p_doc, v_user), 'owner'));
end $$;

-- Turns a logged change into webhook and automation jobs.
create or replace function public.tg_integrations()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_touch jsonb;
  w record;
  a record;
  v_ids bigint[];
  v_ready bigint[];
  v_cand bigint[];
  v_cond text;
  v_hits bigint[];
  v_ctx jsonb;
  i int;
  n int;
  v_row bigint;
  v_any boolean := false;
begin
  if new.source = 'system' or new.kind not in ('do', 'undo', 'redo') then
    return null;
  end if;
  if not exists (select 1 from public.doc_webhooks where doc_id = new.doc_id and enabled)
     and not exists (select 1 from public.doc_automations where doc_id = new.doc_id and enabled) then
    return null;
  end if;
  v_touch := public._touched(new.actions, new.inverse);
  if v_touch = '{}'::jsonb then
    return null;
  end if;

  for w in select * from public.doc_webhooks where doc_id = new.doc_id and enabled and v_touch ? table_ref::text loop
    select array_agg(distinct x::bigint) into v_ids from (
      select jsonb_array_elements_text(case when 'add' = any (w.events) then coalesce(v_touch->w.table_ref::text->'added', '[]') else '[]' end) x
      union all
      select jsonb_object_keys(case when 'update' = any (w.events) then coalesce(v_touch->w.table_ref::text->'changed', '{}') else '{}' end)
    ) s;
    if w.ready_col is not null and v_ids is not null then
      select array_agg(r.id) into v_ready from public.doc_rows r
      where r.id = any (v_ids) and r.table_ref = w.table_ref
        and public._acl_truthy(coalesce(r.data -> w.ready_col::text, r.computed -> w.ready_col::text));
      v_ids := v_ready;
    end if;
    n := coalesce(cardinality(v_ids), 0);
    i := 1;
    while i <= n loop
      insert into public.job_queue (doc_id, kind, source_id, payload)
      values (new.doc_id, 'webhook', w.id, jsonb_build_object('table', w.table_ref, 'row_ids', to_jsonb(v_ids[i:i + 499]), 'action_id', new.id));
      v_any := true;
      i := i + 500;
    end loop;
  end loop;

  for a in select * from public.doc_automations where doc_id = new.doc_id and enabled and v_touch ? table_ref::text loop
    select array_agg(distinct x::bigint) into v_cand from (
      select jsonb_array_elements_text(case when a.trigger in ('add', 'add_or_update') then coalesce(v_touch->a.table_ref::text->'added', '[]') else '[]' end) x
      union all
      select c.key from jsonb_each(case when a.trigger in ('update', 'add_or_update') then coalesce(v_touch->a.table_ref::text->'changed', '{}') else '{}' end) c
      where cardinality(a.watch_cols) = 0
         or exists (select 1 from jsonb_array_elements_text(c.value) k where k::uuid = any (a.watch_cols))
    ) s;
    continue when v_cand is null;
    v_hits := v_cand;
    if a.condition_ast is not null then
      v_ctx := public._integration_ctx(new.doc_id, a.created_by) || '{"_newRec": "r"}'::jsonb;
      v_cond := public._acl_cond(a.condition_ast, new.doc_id, a.table_ref, v_ctx);
      if v_cond is null then
        continue;   -- a broken condition never fires
      end if;
      execute format('select array_agg(r.id) from public.doc_rows r where r.id = any ($1) and r.table_ref = $2 and coalesce(%s, false)', v_cond)
      into v_hits using v_cand, a.table_ref;
    end if;
    continue when v_hits is null;
    -- At most 2000 automation deliveries a day per document (an email flood guard).
    if (select count(*) from public.job_queue q where q.doc_id = new.doc_id and q.kind = 'automation'
        and q.created_at > now() - interval '1 day') >= 2000 then
      raise warning 'integrations: daily automation limit reached for document %', new.doc_id;
      exit;
    end if;
    foreach v_row in array v_hits[1:100] loop
      for i in 0 .. least(jsonb_array_length(a.actions), 5) - 1 loop
        insert into public.job_queue (doc_id, kind, source_id, payload, max_attempts)
        values (new.doc_id, 'automation', a.id,
                jsonb_build_object('table', a.table_ref, 'row_id', v_row, 'action_index', i, 'action_id', new.id,
                                   'event', case when v_touch->a.table_ref::text->'added' @> to_jsonb(v_row) then 'add' else 'update' end),
                case when a.actions->i->>'type' = 'email' then 5 else 8 end);
        v_any := true;
      end loop;
    end loop;
  end loop;

  if v_any then
    perform public._kick_jobs();
  end if;
  return null;
exception when others then
  -- Integrations must never break saving: note the problem and carry on.
  raise warning 'integrations: %', sqlerrm;
  return null;
end $$;

create trigger doc_actions_integrations after insert on public.doc_actions
  for each row execute function public.tg_integrations();

-- ============================================================
-- Delivery (called by the `deliver` Edge Function with the worker secret)
-- ============================================================
-- One record as {ColId: value} for an integration, read as its creator may.
create or replace function public._integration_records(p_doc uuid, p_table uuid, p_ids bigint[], p_ctx jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sql text;
  v_fields text := '';
  c record;
  v_out jsonb;
begin
  if public._acl_ruled(p_doc) then
    v_sql := public._acl_read_sql(p_doc, p_table, p_ctx);
  else
    v_sql := format('select r.id, r.table_ref, r.manual_sort, r.data, r.computed from public.doc_rows r where r.table_ref = %L', p_table);
  end if;
  for c in select * from public.doc_columns where table_ref = p_table order by position, col_id loop
    v_fields := v_fields || format(', %L, x.%s -> %L', c.col_id, case when c.is_formula then 'computed' else 'data' end, c.id::text);
  end loop;
  execute format('select coalesce(jsonb_agg(jsonb_build_object(''id'', x.id) || jsonb_strip_nulls(jsonb_build_object(%s)) order by x.id), ''[]''::jsonb) '
                 'from (%s) x where x.id = any ($1)', coalesce(nullif(substr(v_fields, 3), ''), '''_'', null'), v_sql)
  into v_out using p_ids;
  return v_out;
end $$;

-- Text of a value for an email: references show their display column.
create or replace function public._value_text(c public.doc_columns, v jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_vis public.doc_columns;
  v_out text;
begin
  if v is null or v = 'null'::jsonb then
    return '';
  end if;
  if c.type in ('Ref', 'RefList') and c.options ? 'visibleCol' then
    select * into v_vis from public.doc_columns where id::text = c.options->>'visibleCol';
    if v_vis.id is not null then
      select string_agg(coalesce(case when v_vis.is_formula then r.computed else r.data end ->> v_vis.id::text, ''), ', ' order by r.id)
      into v_out from public.doc_rows r
      where r.table_ref = v_vis.table_ref
        and r.id in (select (x #>> '{}')::bigint from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else jsonb_build_array(v) end) x
                     where jsonb_typeof(x) = 'number');
      return coalesce(v_out, '');
    end if;
  end if;
  if jsonb_typeof(v) = 'array' then
    return (select string_agg(x #>> '{}', ', ') from jsonb_array_elements(v) x);
  end if;
  if jsonb_typeof(v) = 'boolean' then
    return case when v = 'true'::jsonb then 'Yes' else 'No' end;
  end if;
  if jsonb_typeof(v) = 'object' then
    return '';
  end if;
  return v #>> '{}';
end $$;

-- Replaces {{ColId}} / {{Column label}} / {{id}} with the record's values.
-- Unknown placeholders ({{link}} and the like) are left for the sender.
create or replace function public._fill_template(p_text text, p_table uuid, p_record jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_out text := coalesce(p_text, '');
  m text[];
  c public.doc_columns;
  v_name text;
begin
  for m in select regexp_matches(coalesce(p_text, ''), '\{\{\s*([^{}]+?)\s*\}\}', 'g') loop
    v_name := m[1];
    if lower(v_name) = 'id' then
      v_out := replace(v_out, '{{' || m[1] || '}}', coalesce(p_record->>'id', ''));
      continue;
    end if;
    select * into c from public.doc_columns where table_ref = p_table and (col_id = v_name or lower(label) = lower(v_name))
    order by (col_id = v_name) desc limit 1;
    if c.id is not null then
      v_out := regexp_replace(v_out, '\{\{\s*' || regexp_replace(m[1], '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\s*\}\}',
                              replace(public._value_text(c, p_record->c.col_id), '\', '\\'), 'g');
    end if;
  end loop;
  return v_out;
end $$;

-- Claims due jobs and returns what to send: [{id, kind: webhook|email, ...}].
create or replace function public.jobs_claim(p_secret text, p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.job_queue;
  w public.doc_webhooks;
  a public.doc_automations;
  v_act jsonb;
  v_ctx jsonb;
  v_recs jsonb;
  v_rec jsonb;
  v_to text[];
  v_out jsonb := '[]'::jsonb;
  v_doc_name text;
  v_table_name text;
begin
  perform public._check_worker_secret(p_secret);
  -- Jobs left "running" by a crashed run go back in the queue.
  update public.job_queue set status = 'pending' where status = 'running' and started_at < now() - interval '5 minutes';
  for j in
    update public.job_queue q set status = 'running', attempts = q.attempts + 1, started_at = now()
    where q.id in (select id from public.job_queue where status = 'pending' and next_run_at <= now()
                   order by next_run_at, id limit least(greatest(p_limit, 1), 100) for update skip locked)
    returning q.*
  loop
    select d.name into v_doc_name from public.documents d where d.id = j.doc_id;
    select t.table_id into v_table_name from public.doc_tables t where t.id = (j.payload->>'table')::uuid;
    if j.kind = 'webhook' then
      select * into w from public.doc_webhooks where id = j.source_id;
      if w.id is null or not w.enabled then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'Webhook removed or turned off' where id = j.id;
        continue;
      end if;
      v_ctx := public._integration_ctx(j.doc_id, w.created_by) || '{"_newRec": "r"}'::jsonb;
      v_recs := public._integration_records(j.doc_id, w.table_ref,
                  array(select (x #>> '{}')::bigint from jsonb_array_elements(j.payload->'row_ids') x), v_ctx);
      if jsonb_array_length(v_recs) = 0 then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'The records no longer exist' where id = j.id;
        continue;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'webhook', 'url', w.url, 'secret', w.secret,
        'body', jsonb_build_object('event', 'records', 'document', j.doc_id, 'table', v_table_name, 'records', v_recs)));
    else
      select * into a from public.doc_automations where id = j.source_id;
      v_act := a.actions -> (j.payload->>'action_index')::int;
      if a.id is null or not a.enabled or v_act is null then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'Automation removed, turned off or changed' where id = j.id;
        continue;
      end if;
      v_ctx := public._integration_ctx(j.doc_id, a.created_by) || '{"_newRec": "r"}'::jsonb;
      v_rec := public._integration_records(j.doc_id, a.table_ref, array[(j.payload->>'row_id')::bigint], v_ctx) -> 0;
      if v_rec is null then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'The record no longer exists' where id = j.id;
        continue;
      end if;
      if v_act->>'type' = 'email' then
        select array_agg(distinct lower(btrim(x))) into v_to
        from unnest(string_to_array(public._fill_template(v_act->>'to', a.table_ref, v_rec), ',')) x
        where btrim(x) ~* '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$';
        if v_to is null then
          update public.job_queue set status = 'failed', finished_at = now(), last_error = 'No valid email address in "To"' where id = j.id;
          continue;
        end if;
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'email', 'to', to_jsonb(v_to[1:10]),
          'subject', left(public._fill_template(v_act->>'subject', a.table_ref, v_rec), 300),
          'text', left(public._fill_template(v_act->>'body', a.table_ref, v_rec), 20000),
          'doc', j.doc_id, 'doc_name', v_doc_name));
      elsif v_act->>'type' = 'webhook' then
        if not public._safe_url(v_act->>'url') then
          update public.job_queue set status = 'failed', finished_at = now(), last_error = 'Address not allowed' where id = j.id;
          continue;
        end if;
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'webhook', 'url', v_act->>'url', 'secret', a.secret,
          'body', jsonb_build_object('event', j.payload->>'event', 'automation', a.name, 'document', j.doc_id,
                                     'table', v_table_name, 'record', v_rec)));
      else
        update public.job_queue set status = 'failed', finished_at = now(), last_error = 'Unknown action' where id = j.id;
      end if;
    end if;
  end loop;
  return v_out;
end $$;

-- Reports a job's result. Failures are retried with growing waits: 30 s, 1, 2, 4 ... up to 60 minutes.
create or replace function public.jobs_done(p_secret text, p_id bigint, p_error text default null, p_status int default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._check_worker_secret(p_secret);
  update public.job_queue set
    status = case when p_error is null then 'done' when attempts >= max_attempts then 'failed' else 'pending' end,
    finished_at = case when p_error is null or attempts >= max_attempts then now() end,
    next_run_at = case when p_error is null then next_run_at
                       else now() + least(interval '30 seconds' * power(2, greatest(attempts - 1, 0)), interval '60 minutes') end,
    last_status = p_status,
    last_error = left(p_error, 1000)
  where id = p_id and status = 'running';
end $$;

create or replace function public._jobs_cleanup()
returns void language sql security definer set search_path = '' as $$
  delete from public.job_queue where status in ('done', 'skipped') and created_at < now() - interval '14 days';
  delete from public.job_queue where status = 'failed' and created_at < now() - interval '30 days';
$$;

select cron.schedule('lmdu-deliver', '* * * * *', 'select public._kick_jobs()');
select cron.schedule('lmdu-jobs-cleanup', '53 3 * * *', 'select public._jobs_cleanup()');

-- ============================================================
-- Managing integrations (owners)
-- ============================================================
create or replace function public._require_owner(p_doc uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can manage webhooks and automations' using errcode = '42501';
  end if;
end $$;

create or replace function public.get_integrations(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_owner(p_doc);
  return jsonb_build_object(
    'webhooks', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at) from public.doc_webhooks w where w.doc_id = p_doc), '[]'::jsonb),
    'automations', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.doc_automations a where a.doc_id = p_doc), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(to_jsonb(j) - 'payload' || jsonb_build_object(
                        'row_ids', coalesce(j.payload->'row_ids', jsonb_build_array(j.payload->'row_id')),
                        'action_index', j.payload->'action_index', 'event', j.payload->'event') order by j.id desc)
                      from (select * from public.job_queue where doc_id = p_doc order by id desc limit 100) j), '[]'::jsonb),
    'queued', (select count(*) from public.job_queue where doc_id = p_doc and status in ('pending', 'running')));
end $$;

create or replace function public.save_webhook(p_doc uuid, p_hook jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_hook->>'id', '')::uuid;
  v_table uuid := (p_hook->>'table_ref')::uuid;
  v_ready uuid := nullif(p_hook->>'ready_col', '')::uuid;
  v_events text[];
begin
  perform public._require_owner(p_doc);
  if not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
    raise exception 'Pick a table of this document';
  end if;
  if v_ready is not null and not exists (select 1 from public.doc_columns where id = v_ready and table_ref = v_table) then
    raise exception 'The "ready" column must belong to the table';
  end if;
  if not public._safe_url(coalesce(p_hook->>'url', '')) then
    raise exception 'Use an https:// address on the public internet';
  end if;
  select array_agg(x) into v_events from jsonb_array_elements_text(coalesce(p_hook->'events', '["add","update"]')) x;
  if (select count(*) from public.doc_webhooks where doc_id = p_doc) >= 20 and v_id is null then
    raise exception 'A document can have up to 20 webhooks';
  end if;
  if v_id is null then
    insert into public.doc_webhooks (doc_id, table_ref, name, url, events, ready_col, enabled, created_by)
    values (p_doc, v_table, left(coalesce(p_hook->>'name', ''), 120), p_hook->>'url', v_events, v_ready,
            coalesce((p_hook->>'enabled')::boolean, true), auth.uid())
    returning id into v_id;
  else
    update public.doc_webhooks set table_ref = v_table, name = left(coalesce(p_hook->>'name', ''), 120), url = p_hook->>'url',
      events = v_events, ready_col = v_ready, enabled = coalesce((p_hook->>'enabled')::boolean, true), updated_at = now()
    where id = v_id and doc_id = p_doc;
    if not found then
      raise exception 'Webhook not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.save_automation(p_doc uuid, p_auto jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_auto->>'id', '')::uuid;
  v_table uuid := (p_auto->>'table_ref')::uuid;
  v_watch uuid[];
  v_actions jsonb := coalesce(p_auto->'actions', '[]'::jsonb);
  v_ast jsonb := nullif(p_auto->'condition_ast', 'null'::jsonb);
  a jsonb;
begin
  perform public._require_owner(p_doc);
  if not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
    raise exception 'Pick a table of this document';
  end if;
  select coalesce(array_agg(x::uuid), '{}') into v_watch from jsonb_array_elements_text(coalesce(p_auto->'watch_cols', '[]')) x;
  if exists (select 1 from unnest(v_watch) c where not exists (select 1 from public.doc_columns where id = c and table_ref = v_table)) then
    raise exception 'Watched columns must belong to the table';
  end if;
  if v_ast is not null then
    begin
      perform public._acl_bool(v_ast, p_doc, v_table, public._acl_ctx_me(p_doc) || '{"_newRec": "r"}'::jsonb, 0);
    exception when others then
      raise exception 'The condition can''t be used: %', sqlerrm;
    end;
  end if;
  if coalesce(jsonb_typeof(v_actions), '') <> 'array' or jsonb_array_length(v_actions) not between 1 and 5 then
    raise exception 'Add between 1 and 5 actions';
  end if;
  for a in select value from jsonb_array_elements(v_actions) loop
    if a->>'type' = 'email' then
      if length(btrim(coalesce(a->>'to', ''))) = 0 or length(a->>'to') > 1000 or length(coalesce(a->>'subject', '')) > 300
         or length(coalesce(a->>'body', '')) > 20000 then
        raise exception 'An email needs a "To" address, a subject of up to 300 characters and a message of up to 20,000';
      end if;
    elsif a->>'type' = 'webhook' then
      if not public._safe_url(coalesce(a->>'url', '')) then
        raise exception 'Webhook actions need an https:// address on the public internet';
      end if;
    else
      raise exception 'Unknown action type %', a->>'type';
    end if;
  end loop;
  if v_id is null then
    if (select count(*) from public.doc_automations where doc_id = p_doc) >= 50 then
      raise exception 'A document can have up to 50 automations';
    end if;
    insert into public.doc_automations (doc_id, table_ref, name, enabled, trigger, watch_cols, condition, condition_ast, actions, created_by)
    values (p_doc, v_table, left(coalesce(p_auto->>'name', ''), 120), coalesce((p_auto->>'enabled')::boolean, true),
            coalesce(p_auto->>'trigger', 'add_or_update'), v_watch, left(coalesce(p_auto->>'condition', ''), 4000), v_ast, v_actions, auth.uid())
    returning id into v_id;
  else
    update public.doc_automations set table_ref = v_table, name = left(coalesce(p_auto->>'name', ''), 120),
      enabled = coalesce((p_auto->>'enabled')::boolean, true), trigger = coalesce(p_auto->>'trigger', 'add_or_update'),
      watch_cols = v_watch, condition = left(coalesce(p_auto->>'condition', ''), 4000), condition_ast = v_ast,
      actions = v_actions, updated_at = now()
    where id = v_id and doc_id = p_doc;
    if not found then
      raise exception 'Automation not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_integration(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc uuid;
begin
  if p_kind = 'webhook' then
    select doc_id into v_doc from public.doc_webhooks where id = p_id;
  else
    select doc_id into v_doc from public.doc_automations where id = p_id;
  end if;
  if v_doc is null then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  perform public._require_owner(v_doc);
  if p_kind = 'webhook' then
    delete from public.doc_webhooks where id = p_id;
  else
    delete from public.doc_automations where id = p_id;
  end if;
  update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'Removed'
  where source_id = p_id and status = 'pending';
end $$;

-- Sends a webhook or runs an automation's actions now, for the table's newest record.
create or replace function public.test_integration(p_kind text, p_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_doc uuid;
  v_table uuid;
  v_actions jsonb;
  v_row bigint;
  v_job bigint;
  i int;
begin
  if p_kind = 'webhook' then
    select doc_id, table_ref into v_doc, v_table from public.doc_webhooks where id = p_id;
  else
    select doc_id, table_ref, actions into v_doc, v_table, v_actions from public.doc_automations where id = p_id;
  end if;
  if v_doc is null then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  perform public._require_owner(v_doc);
  select max(id) into v_row from public.doc_rows where table_ref = v_table;
  if v_row is null then
    raise exception 'The table has no records to send';
  end if;
  if p_kind = 'webhook' then
    insert into public.job_queue (doc_id, kind, source_id, payload, max_attempts)
    values (v_doc, 'webhook', p_id, jsonb_build_object('table', v_table, 'row_ids', jsonb_build_array(v_row), 'test', true), 1)
    returning id into v_job;
  else
    for i in 0 .. jsonb_array_length(v_actions) - 1 loop
      insert into public.job_queue (doc_id, kind, source_id, payload, max_attempts)
      values (v_doc, 'automation', p_id, jsonb_build_object('table', v_table, 'row_id', v_row, 'action_index', i, 'event', 'test'), 1)
      returning id into v_job;
    end loop;
  end if;
  perform public._kick_jobs();
  return v_job;
end $$;

create or replace function public.retry_job(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc uuid;
begin
  select doc_id into v_doc from public.job_queue where id = p_id and status in ('failed', 'pending');
  if v_doc is null then
    raise exception 'Only failed or waiting deliveries can be retried' using errcode = 'P0002';
  end if;
  perform public._require_owner(v_doc);
  update public.job_queue set status = 'pending', next_run_at = now(), max_attempts = greatest(max_attempts, attempts + 1)
  where id = p_id;
  perform public._kick_jobs();
end $$;

-- ============================================================
-- Grants
-- ============================================================
revoke execute on function
  public._api_auth(text), public._api_doc(uuid), public._api_table(uuid, text), public._api_cols(uuid, uuid),
  public._api_read_sql(uuid, uuid), public._api_values(uuid, uuid, jsonb),
  public._api_select(uuid, uuid, text, text, int, text), public._api_match_sql(uuid, uuid, jsonb, boolean),
  public._kick_jobs(), public._touched(jsonb, jsonb), public._integration_ctx(uuid, uuid), public.tg_integrations(),
  public._integration_records(uuid, uuid, bigint[], jsonb), public._value_text(public.doc_columns, jsonb),
  public._fill_template(text, uuid, jsonb), public.jobs_claim(text, int), public.jobs_done(text, bigint, text, int),
  public._jobs_cleanup(), public._require_owner(uuid), public._safe_url(text)
from public, anon, authenticated;
grant execute on function public.jobs_claim(text, int), public.jobs_done(text, bigint, text, int) to service_role;

revoke execute on function
  public.create_api_key(text), public.revoke_api_key(uuid), public.get_integrations(uuid), public.save_webhook(uuid, jsonb),
  public.save_automation(uuid, jsonb), public.delete_integration(text, uuid), public.test_integration(text, uuid), public.retry_job(bigint)
from public, anon;
grant execute on function
  public.create_api_key(text), public.revoke_api_key(uuid), public.get_integrations(uuid), public.save_webhook(uuid, jsonb),
  public.save_automation(uuid, jsonb), public.delete_integration(text, uuid), public.test_integration(text, uuid), public.retry_job(bigint)
to authenticated;

-- The REST API calls these with the public key; the API key inside decides who it is.
grant execute on function
  public.api_tables(text, uuid), public.api_columns(text, uuid, text),
  public.api_records(text, uuid, text, jsonb, text, int), public.api_add_records(text, uuid, text, jsonb),
  public.api_update_records(text, uuid, text, jsonb), public.api_upsert_records(text, uuid, text, jsonb, text, boolean, boolean),
  public.api_delete_records(text, uuid, text, jsonb)
to anon, authenticated;
