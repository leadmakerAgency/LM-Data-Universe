-- Phase 3: access rules.
--
-- Owners can limit who reads, adds, changes and deletes which records and
-- columns, using conditions written in the formula language
-- (`user.Email == rec.Owner`, `user.Access != "owner"`, `user.Team.Name == rec.Team`).
--
-- How it is enforced:
--   * Rules are stored as a checked condition tree (doc_access_rules.condition_ast),
--     never as SQL. The database turns that tree into SQL itself, quoting every
--     value and checking every column id against the document's own columns.
--   * Rules only narrow what a role allows; they never widen it. Record rules
--     (a table's, then the document's default rules) are tried in order and the
--     first that matches decides; column rules narrow further. A rule that can't
--     be evaluated (e.g. its column was removed) fails closed: a broken "deny"
--     always applies, a broken "allow" never does.
--   * In a document with rules, rows can't be selected directly (row-level
--     security), so the API and Realtime `postgres_changes` see nothing. The app
--     reads through read_rows(), which filters records and strips hidden cells,
--     and is told about changes by a private Broadcast message that carries only
--     row ids, which it then re-reads through read_rows().
--   * apply_actions (and undo/redo) check every record operation against the
--     rules before applying it, inside the same transaction.
--   * The activity log, snapshots, "compare" and copies contain unfiltered data,
--     so in a document with rules only owners can use them. Comments and
--     attachments follow the visibility of the record and cell they belong to.
--   * Public forms and the formula worker are not subject to the rules (the
--     owner published the form; the worker never returns data to a person).

-- ============================================================
-- Tables
-- ============================================================
create table public.doc_access_rules (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  -- null: a default rule for every table.
  table_ref uuid references public.doc_tables(id) on delete cascade,
  -- empty: the rule is about whole records; otherwise about these columns' cells.
  col_ids uuid[] not null default '{}',
  -- The condition as written; the editor shows it re-printed from the tree.
  condition text not null default '' check (length(condition) <= 4000),
  -- The condition the database enforces; null means "always".
  condition_ast jsonb check (condition_ast is null or (jsonb_typeof(condition_ast) = 'object' and pg_column_size(condition_ast) < 32768)),
  -- {"read": true|false, "create": ..., "update": ..., "delete": ...}; a missing key leaves that permission to later rules.
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  memo text check (memo is null or length(memo) <= 500),
  position double precision not null default 0,
  created_at timestamptz not null default now(),
  check (table_ref is not null or cardinality(col_ids) = 0)
);
create index doc_access_rules_doc_idx on public.doc_access_rules (doc_id, table_ref, position);

-- user.<name> in conditions: the record of table_ref whose match_col equals the
-- person's Email (or UserID / Name), e.g. user.Person.Department.
create table public.doc_user_attributes (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' and name not in ('Email', 'UserID', 'Name', 'Access', 'IsLoggedIn')),
  user_field text not null default 'Email' check (user_field in ('Email', 'UserID', 'Name')),
  table_ref uuid not null references public.doc_tables(id) on delete cascade,
  match_col uuid not null references public.doc_columns(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (doc_id, name)
);
create index doc_user_attributes_doc_idx on public.doc_user_attributes (doc_id);

create table public.doc_access_settings (
  doc_id uuid primary key references public.documents(id) on delete cascade,
  -- Editors may add, change and remove tables and columns (owners always can).
  -- Whoever can change columns can write a formula that shows any value, so
  -- without a saved setting this is off once a document has rules.
  editors_structure boolean not null default true,
  -- Only owners may copy the document or download its data.
  block_copies boolean not null default false,
  -- Everyone with access may read the rules (otherwise only owners).
  public_rules boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Read and written only through get_access_rules / save_access_rules.
alter table public.doc_access_rules enable row level security;
alter table public.doc_user_attributes enable row level security;
alter table public.doc_access_settings enable row level security;
revoke all on public.doc_access_rules, public.doc_user_attributes, public.doc_access_settings from anon, authenticated;

-- ============================================================
-- Which documents have rules
-- ============================================================
create or replace function public._acl_ruled(p_doc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.doc_access_rules where doc_id = p_doc)
$$;

-- Documents the caller can open that have rules (row-level security uses this once per query).
create or replace function public._acl_ruled_docs()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct r.doc_id), '{}') from public.doc_access_rules r
  where r.doc_id = any (public.my_doc_ids(1))
$$;

-- Role of any user (for "view as"); doc_role() is always about the caller.
create or replace function public._role_of(p_doc uuid, p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case max(s.r) when 3 then 'owner' when 2 then 'editor' when 1 then 'viewer' end
  from (
    select public.role_rank(dm.role) as r from public.document_members dm where dm.doc_id = p_doc and dm.user_id = p_user
    union all
    select public.role_rank(wm.role) from public.documents d
    join public.workspace_members wm on wm.workspace_id = d.workspace_id where d.id = p_doc and wm.user_id = p_user
    union all
    select public.role_rank(tm.role) from public.documents d join public.workspaces w on w.id = d.workspace_id
    join public.team_members tm on tm.team_id = w.team_id where d.id = p_doc and tm.user_id = p_user
  ) s
$$;

-- ============================================================
-- The `user` object of conditions
-- ============================================================
create or replace function public._acl_ctx(p_doc uuid, p_user uuid, p_role text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_prof public.profiles;
  v_ctx jsonb;
  v_attrs jsonb := '{}'::jsonb;
  a record;
  v_key text;
  v_id bigint;
  v_row jsonb;
begin
  if p_user is not null then
    select * into v_prof from public.profiles where id = p_user;
  end if;
  v_ctx := jsonb_build_object(
    'Email', coalesce(v_prof.email, ''), 'UserID', coalesce(p_user::text, ''), 'Name', coalesce(v_prof.full_name, ''),
    'Access', p_role, 'IsLoggedIn', p_user is not null);
  for a in
    select ua.name, ua.user_field, ua.table_ref, ua.match_col, c.is_formula
    from public.doc_user_attributes ua join public.doc_columns c on c.id = ua.match_col
    where ua.doc_id = p_doc
  loop
    v_key := v_ctx->>a.user_field;
    v_id := null;
    v_row := null;
    if coalesce(v_key, '') <> '' then
      select r.id into v_id from public.doc_rows r
      where r.table_ref = a.table_ref
        and lower(case when a.is_formula then r.computed else r.data end ->> a.match_col::text) = lower(v_key)
      order by r.id limit 1;
    end if;
    if v_id is not null then
      select jsonb_build_object('id', r.id) || coalesce(jsonb_object_agg(c.id::text,
               coalesce(case when c.is_formula then r.computed else r.data end -> c.id::text, 'null'::jsonb)), '{}'::jsonb)
      into v_row
      from public.doc_rows r join public.doc_columns c on c.table_ref = r.table_ref
      where r.id = v_id
      group by r.id;
    end if;
    v_attrs := v_attrs || jsonb_build_object(a.name, coalesce(v_row, 'null'::jsonb));
  end loop;
  return v_ctx || jsonb_build_object('attrs', v_attrs);
end $$;

create or replace function public._acl_ctx_me(p_doc uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public._acl_ctx(p_doc, auth.uid(), public.doc_role(p_doc))
$$;

-- The caller's context, or (owners only) someone else's for "view as".
create or replace function public._acl_request_ctx(p_doc uuid, p_as text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.doc_role(p_doc);
  v_user uuid;
  v_as_role text;
begin
  if v_role is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if p_as is null or btrim(p_as) = '' then
    return public._acl_ctx(p_doc, auth.uid(), v_role);
  end if;
  if v_role <> 'owner' then
    raise exception 'Only owners can view the document as someone else' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(btrim(p_as));
  if v_user is null then
    raise exception 'No user with email %', p_as using errcode = 'P0002';
  end if;
  v_as_role := public._role_of(p_doc, v_user);
  if v_as_role is null then
    raise exception '% has no access to this document', p_as using errcode = 'P0002';
  end if;
  return public._acl_ctx(p_doc, v_user, v_as_role);
end $$;

-- ============================================================
-- Value helpers used by compiled conditions
-- ============================================================
-- Python-like truthiness of a stored value (formula errors are objects: false).
create or replace function public._acl_truthy(v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case jsonb_typeof(v)
    when 'boolean' then v = 'true'::jsonb
    when 'number' then v <> '0'::jsonb
    when 'string' then v <> '""'::jsonb
    when 'array' then jsonb_array_length(v) > 0
    else false
  end
$$;

create or replace function public._acl_cmp(l jsonb, op text, r jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case op
    when '==' then l = r
    when 'is' then l = r
    when '!=' then l <> r
    when 'is not' then l <> r
    -- Ordering only between two numbers or two strings (like Python 3).
    when '<' then jsonb_typeof(l) = jsonb_typeof(r) and jsonb_typeof(l) in ('number', 'string') and l < r
    when '<=' then jsonb_typeof(l) = jsonb_typeof(r) and jsonb_typeof(l) in ('number', 'string') and l <= r
    when '>' then jsonb_typeof(l) = jsonb_typeof(r) and jsonb_typeof(l) in ('number', 'string') and l > r
    when '>=' then jsonb_typeof(l) = jsonb_typeof(r) and jsonb_typeof(l) in ('number', 'string') and l >= r
  end, false)
$$;

-- `l in r`: membership in a list (ChoiceList, RefList, [..]) or a substring.
create or replace function public._acl_in(l jsonb, r jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case jsonb_typeof(r)
    when 'array' then exists (select 1 from jsonb_array_elements(r) e where e = l)
    when 'string' then jsonb_typeof(l) = 'string' and strpos(r #>> '{}', l #>> '{}') > 0
    else false
  end, false)
$$;

create or replace function public._acl_fn(p_fn text, v jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(v) is distinct from 'string' then v
    when p_fn = 'lower' then to_jsonb(lower(v #>> '{}'))
    when p_fn = 'upper' then to_jsonb(upper(v #>> '{}'))
    when p_fn = 'strip' then to_jsonb(btrim(v #>> '{}'))
    else v
  end
$$;

-- Follows a reference: the cell p_col (or the id when p_col is null) of the
-- p_table record whose id is p_ref.
create or replace function public._acl_ref_cell(p_ref jsonb, p_table uuid, p_col uuid, p_formula boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when p_col is null then to_jsonb(x.id)
                when p_formula then x.computed -> (p_col::text)
                else x.data -> (p_col::text) end
    from public.doc_rows x
    where x.table_ref = p_table
      and x.id = case when jsonb_typeof(p_ref) = 'number' then (p_ref #>> '{}')::numeric::bigint end
  ), 'null'::jsonb)
$$;

-- ============================================================
-- Condition tree -> SQL
-- ============================================================
-- Nodes:
--   {"t":"lit","v":<string|number|boolean|null>}      {"t":"list","items":[..]}
--   {"t":"user","f":"Email"|"UserID"|"Name"|"Access"|"IsLoggedIn"}
--   {"t":"uattr","a":"<attribute name>","col":"<column uuid>"|"id"}
--   {"t":"rec","which":"rec"|"newRec","path":["<column uuid>", ..., optionally "id"]}
--   {"t":"cmp","op":"=="|"!="|"<"|"<="|">"|">="|"in"|"not in"|"is"|"is not","l":..,"r":..}
--   {"t":"and"|"or","args":[..]}   {"t":"not","arg":..}   {"t":"fn","fn":"lower"|"upper"|"strip","arg":..}
-- Records are the aliases `r` (rec) and `n` (newRec; p_ctx->>'_newRec' renames it).
-- Every value expression is jsonb and never SQL NULL.

create or replace function public._acl_val(p_node jsonb, p_doc uuid, p_table uuid, p_ctx jsonb, p_depth int)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_t text := p_node->>'t';
  v_sql text;
  v_items text;
  v_alias text;
  v_path jsonb;
  v_len int;
  v_cur uuid;
  v_el text;
  v_col public.doc_columns;
  v_attr jsonb;
begin
  if p_depth > 40 then
    raise exception 'The condition is too deeply nested';
  end if;
  if jsonb_typeof(p_node) is distinct from 'object' then
    raise exception 'Invalid condition';
  end if;
  case v_t
  when 'lit' then
    if jsonb_typeof(p_node->'v') not in ('string', 'number', 'boolean', 'null') then
      raise exception 'Invalid value in condition';
    end if;
    return format('%L::jsonb', (p_node->'v')::text);

  when 'list' then
    if jsonb_typeof(p_node->'items') is distinct from 'array' or jsonb_array_length(p_node->'items') > 200 then
      raise exception 'Invalid list in condition';
    end if;
    select string_agg(public._acl_val(e, p_doc, p_table, p_ctx, p_depth + 1), ', ' order by o) into v_items
    from jsonb_array_elements(p_node->'items') with ordinality x(e, o);
    return 'jsonb_build_array(' || coalesce(v_items, '') || ')';

  when 'user' then
    if coalesce(p_node->>'f', '') not in ('Email', 'UserID', 'Name', 'Access', 'IsLoggedIn') then
      raise exception 'Unknown user field %', p_node->>'f';
    end if;
    return format('%L::jsonb', coalesce(p_ctx->(p_node->>'f'), 'null'::jsonb)::text);

  when 'uattr' then
    if not coalesce(p_ctx->'attrs' ? (p_node->>'a'), false) then
      raise exception 'Unknown user attribute %', p_node->>'a';
    end if;
    v_attr := p_ctx->'attrs'->(p_node->>'a');
    if p_node->>'col' is distinct from 'id' and not exists (
      select 1 from public.doc_user_attributes ua join public.doc_columns c on c.table_ref = ua.table_ref
      where ua.doc_id = p_doc and ua.name = p_node->>'a' and c.id::text = p_node->>'col'
    ) then
      raise exception 'Unknown column of user.%', p_node->>'a';
    end if;
    return format('%L::jsonb', coalesce(v_attr->(p_node->>'col'), 'null'::jsonb)::text);

  when 'rec' then
    v_alias := case p_node->>'which' when 'rec' then 'r' when 'newRec' then coalesce(p_ctx->>'_newRec', 'n') end;
    if v_alias is null then
      raise exception 'Invalid record reference';
    end if;
    if p_table is null then
      raise exception 'rec and newRec can only be used in rules for a specific table';
    end if;
    v_path := p_node->'path';
    if jsonb_typeof(v_path) is distinct from 'array' then
      raise exception 'Invalid record reference';
    end if;
    v_len := jsonb_array_length(v_path);
    if v_len not between 1 and 5 then
      raise exception 'Invalid record reference';
    end if;
    v_cur := p_table;
    for i in 0 .. v_len - 1 loop
      v_el := v_path->>i;
      if v_el = 'id' then
        if i <> v_len - 1 then
          raise exception 'Invalid record reference';
        end if;
        if i = 0 then
          v_sql := format('to_jsonb(%s.id)', v_alias);
        end if;
        -- After a reference, the reference value itself is the id.
        exit;
      end if;
      v_col := null;
      select * into v_col from public.doc_columns c where c.id::text = v_el and c.table_ref = v_cur;
      if v_col.id is null then
        raise exception 'The condition refers to a column that no longer exists';
      end if;
      if i = 0 then
        v_sql := format('coalesce(%s.%s -> %L, ''null''::jsonb)', v_alias,
                        case when v_col.is_formula then 'computed' else 'data' end, v_col.id::text);
      else
        v_sql := format('public._acl_ref_cell(%s, %L::uuid, %L::uuid, %L::boolean)', v_sql, v_cur, v_col.id, v_col.is_formula);
      end if;
      if i < v_len - 1 then
        if v_col.type <> 'Ref' or coalesce(v_col.options->>'refTable', '') !~ '^[0-9a-f-]{36}$' then
          raise exception 'Only Reference columns can be followed with "."';
        end if;
        v_cur := (v_col.options->>'refTable')::uuid;
      end if;
    end loop;
    return v_sql;

  when 'fn' then
    if coalesce(p_node->>'fn', '') not in ('lower', 'upper', 'strip') then
      raise exception 'Unsupported function %', p_node->>'fn';
    end if;
    return format('public._acl_fn(%L, %s)', p_node->>'fn', public._acl_val(p_node->'arg', p_doc, p_table, p_ctx, p_depth + 1));

  when 'cmp', 'and', 'or', 'not' then
    return format('to_jsonb(%s)', public._acl_bool(p_node, p_doc, p_table, p_ctx, p_depth + 1));

  else
    raise exception 'Invalid condition';
  end case;
end $$;

create or replace function public._acl_bool(p_node jsonb, p_doc uuid, p_table uuid, p_ctx jsonb, p_depth int)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_t text := p_node->>'t';
  v_op text;
  v_sql text;
begin
  if p_depth > 40 then
    raise exception 'The condition is too deeply nested';
  end if;
  if jsonb_typeof(p_node) is distinct from 'object' then
    raise exception 'Invalid condition';
  end if;
  case v_t
  when 'and', 'or' then
    if jsonb_typeof(p_node->'args') is distinct from 'array' or jsonb_array_length(p_node->'args') not between 1 and 100 then
      raise exception 'Invalid condition';
    end if;
    select string_agg('(' || public._acl_bool(e, p_doc, p_table, p_ctx, p_depth + 1) || ')', ' ' || v_t || ' ' order by o) into v_sql
    from jsonb_array_elements(p_node->'args') with ordinality x(e, o);
    return '(' || v_sql || ')';
  when 'not' then
    return format('(not %s)', public._acl_bool(p_node->'arg', p_doc, p_table, p_ctx, p_depth + 1));
  when 'cmp' then
    v_op := p_node->>'op';
    if v_op in ('in', 'not in') then
      return format('(%s public._acl_in(%s, %s))', case when v_op = 'not in' then 'not' else '' end,
                    public._acl_val(p_node->'l', p_doc, p_table, p_ctx, p_depth + 1),
                    public._acl_val(p_node->'r', p_doc, p_table, p_ctx, p_depth + 1));
    end if;
    if coalesce(v_op, '') not in ('==', '!=', '<', '<=', '>', '>=', 'is', 'is not') then
      raise exception 'Unsupported comparison %', v_op;
    end if;
    return format('public._acl_cmp(%s, %L, %s)',
                  public._acl_val(p_node->'l', p_doc, p_table, p_ctx, p_depth + 1), v_op,
                  public._acl_val(p_node->'r', p_doc, p_table, p_ctx, p_depth + 1));
  else
    return format('public._acl_truthy(%s)', public._acl_val(p_node, p_doc, p_table, p_ctx, p_depth + 1));
  end case;
end $$;

-- A rule's condition as SQL, or null when it can't be compiled (the caller fails closed).
create or replace function public._acl_cond(p_ast jsonb, p_doc uuid, p_table uuid, p_ctx jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_ast is null then
    return 'true';
  end if;
  return public._acl_bool(p_ast, p_doc, p_table, p_ctx, 0);
exception when others then
  return null;
end $$;

-- SQL boolean: may the person do p_perm ('read' | 'create' | 'update' | 'delete')
--   * p_col null: on a record of p_table. The table's record rules, then the
--     document's default rules, in order; the first that matches decides;
--     none matching allows. The role caps everything (viewers never write).
--   * p_col set: on that column's cell. Only the column's rules; none matching
--     allows (the record permission is checked separately).
create or replace function public._acl_perm(p_doc uuid, p_table uuid, p_col uuid, p_perm text, p_ctx jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  rule record;
  v_cond text;
  v_allow boolean;
  v_cases text := '';
  v_rank int := coalesce(public.role_rank(p_ctx->>'Access'), 0);
begin
  if p_col is null and v_rank < (case when p_perm = 'read' then 1 else 2 end) then
    return 'false';
  end if;
  for rule in
    select r.* from public.doc_access_rules r
    where r.doc_id = p_doc and r.permissions ? p_perm
      and case when p_col is null
               then (r.table_ref = p_table and cardinality(r.col_ids) = 0) or r.table_ref is null
               else r.table_ref = p_table and p_col = any (r.col_ids) end
    order by (r.table_ref is null), r.position, r.id
  loop
    v_allow := jsonb_typeof(rule.permissions->p_perm) = 'boolean' and (rule.permissions->>p_perm)::boolean;
    v_cond := public._acl_cond(rule.condition_ast, p_doc, rule.table_ref, p_ctx);
    if v_cond is null then
      if v_allow then
        continue;           -- a broken "allow" never applies
      end if;
      v_cond := 'true';     -- a broken "deny" always applies
    end if;
    -- A condition that comes out unknown counts as matching for "deny", not for "allow".
    v_cases := v_cases || format(' when coalesce(%s, %s) then %s', v_cond,
                                 case when v_allow then 'false' else 'true' end,
                                 case when v_allow then 'true' else 'false' end);
    exit when v_cond = 'true';  -- nothing after an unconditional rule is reached
  end loop;
  if v_cases = '' then
    return 'true';
  end if;
  return '(case' || v_cases || ' else true end)';
end $$;

-- Evaluates a permission expression that doesn't depend on a record; null when it does.
create or replace function public._acl_const(p_expr text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if p_expr = 'true' then return true; end if;
  if p_expr = 'false' then return false; end if;
  execute 'select ' || p_expr into v;
  return coalesce(v, false);
exception when others then
  return null;  -- refers to r / n: depends on the record
end $$;

-- SQL selecting the readable records of a table, without the cells the person can't read.
create or replace function public._acl_read_sql(p_doc uuid, p_table uuid, p_ctx jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx jsonb := p_ctx || '{"_newRec": "r"}'::jsonb;
  v_strip text := '';
  v_c text;
  c record;
begin
  for c in
    select distinct unnest(r.col_ids) as id from public.doc_access_rules r
    where r.doc_id = p_doc and r.table_ref = p_table and r.permissions ? 'read'
  loop
    v_c := public._acl_perm(p_doc, p_table, c.id, 'read', v_ctx);
    if v_c <> 'true' then
      v_strip := v_strip || format(', case when coalesce(%s, false) then null else %L end', v_c, c.id::text);
    end if;
  end loop;
  v_strip := case when v_strip = '' then '''{}''::text[]'
                  else 'array_remove(array[' || substr(v_strip, 3) || ']::text[], null)' end;
  return format(
    'select r.id, r.table_ref, r.manual_sort, r.data - %1$s as data, r.computed - %1$s as computed '
    'from public.doc_rows r where r.table_ref = %2$L and r.doc_id = %3$L and coalesce(%4$s, false)',
    v_strip, p_table, p_doc, public._acl_perm(p_doc, p_table, null, 'read', v_ctx));
end $$;

-- ============================================================
-- Reading
-- ============================================================
-- Records of a document as the caller (or, for owners, p_as) may see them,
-- in id order, p_limit at a time after id p_after; or only the ids in p_ids.
create or replace function public.read_rows(
  p_doc uuid, p_after bigint default 0, p_limit int default 1000, p_ids bigint[] default null, p_as text default null
) returns table (id bigint, table_ref uuid, manual_sort double precision, data jsonb, computed jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_ctx jsonb := public._acl_request_ctx(p_doc, p_as);
  v_sql text;
  t record;
begin
  for t in select dt.id as tid from public.doc_tables dt where dt.doc_id = p_doc order by dt.position loop
    v_sql := coalesce(v_sql || ' union all ', '') || public._acl_read_sql(p_doc, t.tid, v_ctx);
  end loop;
  if v_sql is null then
    return;
  end if;
  return query execute format(
    'select x.id, x.table_ref, x.manual_sort, x.data, x.computed from (%s) x '
    'where x.id > $1 and ($2::bigint[] is null or x.id = any ($2)) order by x.id limit $3', v_sql)
  using coalesce(p_after, 0), p_ids, least(greatest(coalesce(p_limit, 1000), 1), 5000);
end $$;

-- Whether one cell (or record, when p_col is null) is readable.
create or replace function public._acl_can_read(p_doc uuid, p_table uuid, p_row bigint, p_col uuid, p_ctx jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx jsonb := p_ctx || '{"_newRec": "r"}'::jsonb;
  v_ok boolean;
begin
  execute format('select exists (select 1 from public.doc_rows r where r.id = $1 and r.table_ref = %L and r.doc_id = %L and coalesce(%s, false) and coalesce(%s, false))',
                 p_table, p_doc, public._acl_perm(p_doc, p_table, null, 'read', v_ctx),
                 case when p_col is null then 'true' else public._acl_perm(p_doc, p_table, p_col, 'read', v_ctx) end)
  into v_ok using p_row;
  return v_ok;
end $$;

-- A column whose cells the caller can never read (its rules don't depend on the record).
create or replace function public._acl_col_hidden(p_doc uuid, p_table uuid, p_col uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.doc_access_rules r where r.doc_id = p_doc and r.table_ref = p_table
                 and p_col = any (r.col_ids) and r.permissions ? 'read') then
    return false;
  end if;
  return public._acl_const(public._acl_perm(p_doc, p_table, p_col, 'read', public._acl_ctx_me(p_doc))) is false;
end $$;

-- What the caller (or p_as) may do, for the app to show and hide controls.
-- Values: true / false, or null when it depends on the record.
create or replace function public.acl_info(p_doc uuid, p_as text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx jsonb := public._acl_request_ctx(p_doc, p_as);
  v_ruled boolean := public._acl_ruled(p_doc);
  v_settings public.doc_access_settings;
  v_tables jsonb := '{}'::jsonb;
  v_cols jsonb := '{}'::jsonb;
  v_hidden jsonb := '[]'::jsonb;
  v_read boolean;
  t record;
  c record;
begin
  select * into v_settings from public.doc_access_settings where doc_id = p_doc;
  if v_ruled then
    for t in select dt.id from public.doc_tables dt where dt.doc_id = p_doc loop
      v_tables := v_tables || jsonb_build_object(t.id::text, jsonb_build_object(
        'read', public._acl_const(public._acl_perm(p_doc, t.id, null, 'read', v_ctx)),
        'create', public._acl_const(public._acl_perm(p_doc, t.id, null, 'create', v_ctx)),
        'update', public._acl_const(public._acl_perm(p_doc, t.id, null, 'update', v_ctx)),
        'delete', public._acl_const(public._acl_perm(p_doc, t.id, null, 'delete', v_ctx))));
    end loop;
    for c in
      select distinct r.table_ref, unnest(r.col_ids) as id from public.doc_access_rules r
      where r.doc_id = p_doc and r.table_ref is not null
    loop
      v_read := public._acl_const(public._acl_perm(p_doc, c.table_ref, c.id, 'read', v_ctx));
      v_cols := v_cols || jsonb_build_object(c.id::text, jsonb_build_object(
        'read', v_read,
        'update', public._acl_const(public._acl_perm(p_doc, c.table_ref, c.id, 'update', v_ctx || '{"_newRec": "r"}'::jsonb))));
      if v_read is false then
        v_hidden := v_hidden || to_jsonb(c.id::text);
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'ruled', v_ruled,
    'access', v_ctx->>'Access',
    'email', v_ctx->>'Email',
    'view_as', nullif(btrim(coalesce(p_as, '')), ''),
    'structure', public._acl_can_structure(p_doc, v_ctx),
    'settings', jsonb_build_object(
      'editors_structure', coalesce(v_settings.editors_structure, not v_ruled),
      'block_copies', coalesce(v_settings.block_copies, false),
      'public_rules', coalesce(v_settings.public_rules, false)),
    'tables', v_tables,
    'cols', v_cols,
    'hidden_cols', v_hidden);
end $$;

-- ============================================================
-- Writing
-- ============================================================
create or replace function public._acl_can_structure(p_doc uuid, p_ctx jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_ctx->>'Access'
    when 'owner' then true
    when 'editor' then coalesce((select s.editors_structure from public.doc_access_settings s where s.doc_id = p_doc),
                                not public._acl_ruled(p_doc))
    else false
  end
$$;

-- Raises unless the person may apply this operation. Runs before the
-- operation, so it sees the records as they are at that point of the bundle.
create or replace function public._acl_check_op(p_doc uuid, p_op jsonb, p_ctx jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := p_op->>'op';
  v_entity text := p_op->>'entity';
  v_table uuid;
  v_name text;
  v_r jsonb := p_ctx || '{"_newRec": "r"}'::jsonb;
  v_n jsonb := p_ctx || '{"_newRec": "n"}'::jsonb;
  v_perm text;
  v_cols text := '';
  v_bad bigint;
  c record;
begin
  if v_kind in ('Add', 'Update', 'Remove') then
    if v_entity in ('table', 'column') then
      if not public._acl_can_structure(p_doc, p_ctx) then
        raise exception 'You don''t have permission to change tables and columns in this document' using errcode = '42501';
      end if;
      if v_kind = 'Remove' and (
        exists (select 1 from public.doc_access_rules r where r.doc_id = p_doc
                and (r.table_ref::text = p_op->>'id' or (p_op->>'id') = any (r.col_ids::text[])
                     or strpos(coalesce(r.condition_ast::text, ''), p_op->>'id') > 0))
        or exists (select 1 from public.doc_user_attributes a where a.doc_id = p_doc
                   and (a.table_ref::text = p_op->>'id' or a.match_col::text = p_op->>'id'))
      ) then
        raise exception 'This % is used by access rules. Change the rules first.', v_entity using errcode = '42501';
      end if;
    end if;
    return;
  end if;

  if v_kind not in ('AddRecords', 'UpdateRecords', 'RemoveRecords') or not public._acl_ruled(p_doc) then
    return;
  end if;
  v_table := (p_op->>'table')::uuid;
  select table_id into v_name from public.doc_tables where id = v_table;
  v_perm := case v_kind when 'AddRecords' then 'create' when 'UpdateRecords' then 'update' else 'delete' end;

  -- Cells written must be readable and writable for this person.
  if v_kind <> 'RemoveRecords' then
    for c in
      select distinct unnest(r.col_ids) as id from public.doc_access_rules r
      where r.doc_id = p_doc and r.table_ref = v_table and (r.permissions ? 'read' or r.permissions ? v_perm)
    loop
      v_cols := v_cols || format(' and (not (p.vals ? %L) or (coalesce(%s, false) and coalesce(%s, false)))',
                                 c.id::text, public._acl_perm(p_doc, v_table, c.id, 'read', v_r),
                                 public._acl_perm(p_doc, v_table, c.id, v_perm, v_n));
    end loop;
  end if;

  if v_kind = 'AddRecords' then
    execute format(
      'select 1 from jsonb_array_elements($1) e '
      'cross join lateral (select coalesce(e->''data'', ''{}''::jsonb) as vals) p '
      'cross join lateral (select null::bigint as id, $2::uuid as table_ref, p.vals as data, ''{}''::jsonb as computed) r '
      'cross join lateral (select r.id, r.table_ref, r.data, r.computed) n '
      'where not (coalesce(%s, false) %s) limit 1',
      public._acl_perm(p_doc, v_table, null, 'create', v_n), v_cols)
    into v_bad using coalesce(p_op->'records', '[]'::jsonb), v_table;
    if v_bad is not null then
      raise exception 'You don''t have permission to add these records to %', v_name using errcode = '42501';
    end if;
  elsif v_kind = 'UpdateRecords' then
    execute format(
      'select p.id from (select (e->>''id'')::bigint as id, coalesce(e->''values'', ''{}''::jsonb) as vals '
      '                  from jsonb_array_elements($1) e) p '
      'join public.doc_rows r on r.id = p.id and r.table_ref = $2 '
      'cross join lateral (select r.id, r.table_ref, r.data || p.vals as data, r.computed) n '
      'where not (coalesce(%s, false) and coalesce(%s, false) %s) limit 1',
      public._acl_perm(p_doc, v_table, null, 'read', v_r), public._acl_perm(p_doc, v_table, null, 'update', v_n), v_cols)
    into v_bad using coalesce(p_op->'records', '[]'::jsonb), v_table;
    if v_bad is not null then
      raise exception 'You don''t have permission to change record % of %', v_bad, v_name using errcode = '42501';
    end if;
  else
    execute format(
      'select r.id from public.doc_rows r '
      'cross join lateral (select r.id, r.table_ref, r.data, r.computed) n '
      'where r.table_ref = $2 and r.id in (select x::bigint from jsonb_array_elements_text($1) x) '
      'and not (coalesce(%s, false) and coalesce(%s, false)) limit 1',
      public._acl_perm(p_doc, v_table, null, 'read', v_r), public._acl_perm(p_doc, v_table, null, 'delete', v_r))
    into v_bad using coalesce(p_op->'ids', '[]'::jsonb), v_table;
    if v_bad is not null then
      raise exception 'You don''t have permission to delete record % of %', v_bad, v_name using errcode = '42501';
    end if;
  end if;
end $$;

-- The bundle runner gains a check step. Callers acting for a person (apply,
-- undo, redo) pass p_check; public forms and the formula worker don't.
drop function public._apply_and_log(uuid, jsonb, text, bigint, boolean, text);
create function public._apply_and_log(
  p_doc uuid, p_actions jsonb, p_kind text, p_target bigint, p_undoable boolean, p_source text, p_check boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_op jsonb;
  v_r jsonb;
  v_results jsonb := '[]'::jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_inverse jsonb := '[]'::jsonb;
  v_id bigint;
  v_ctx jsonb;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    raise exception 'Actions must be a JSON array';
  end if;
  if p_check then
    v_ctx := public._acl_ctx_me(p_doc);
  end if;
  for v_op in select value from jsonb_array_elements(p_actions) loop
    if p_check then
      perform public._acl_check_op(p_doc, v_op, v_ctx);
    end if;
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

create or replace function public.apply_actions(
  p_doc uuid, p_actions jsonb, p_undoable boolean default true, p_source text default 'app'
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_editor(p_doc);
  if p_source not in ('app', 'api', 'assistant') then
    raise exception 'Invalid source %', p_source;
  end if;
  return public._apply_and_log(p_doc, p_actions, 'do', null, p_undoable, p_source, true);
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
  v_out := public._apply_and_log(p_doc, (select inverse from public.doc_actions where id = v_target), 'undo', v_target, true, 'app', true);
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
  v_out := public._apply_and_log(p_doc, (select actions from public.doc_actions where id = v_target), 'redo', v_target, true, 'app', true);
  return v_out || public.undo_state(p_doc);
end $$;

-- ============================================================
-- Row-level security: no direct reads of rows in documents with rules
-- ============================================================
drop policy doc_rows_select on public.doc_rows;
create policy doc_rows_select on public.doc_rows for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and doc_id <> all ((select public._acl_ruled_docs())::uuid[]));
drop policy doc_rows_select_anon on public.doc_rows;
create policy doc_rows_select_anon on public.doc_rows for select to anon
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and doc_id <> all ((select public._acl_ruled_docs())::uuid[]));

-- Columns nobody may read (for this person) disappear entirely.
drop policy doc_columns_select on public.doc_columns;
create policy doc_columns_select on public.doc_columns for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or not public._acl_col_hidden(doc_id, table_ref, id)));
drop policy doc_columns_select_anon on public.doc_columns;
create policy doc_columns_select_anon on public.doc_columns for select to anon
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or not public._acl_col_hidden(doc_id, table_ref, id)));

-- The action log holds every value ever written: owners only once there are rules.
drop policy doc_actions_select on public.doc_actions;
create policy doc_actions_select on public.doc_actions for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or doc_id = any ((select public.my_doc_ids(3))::uuid[])));

drop policy doc_snapshots_select on public.doc_snapshots;
create policy doc_snapshots_select on public.doc_snapshots for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(2))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or doc_id = any ((select public.my_doc_ids(3))::uuid[])));

-- Comments follow the visibility of their cell.
create or replace function public._acl_comment_visible(p_doc uuid, p_table uuid, p_row bigint, p_col uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_table is null or p_row is null
      or public._acl_can_read(p_doc, p_table, p_row, p_col, public._acl_ctx_me(p_doc))
$$;
drop policy doc_comments_select on public.doc_comments;
create policy doc_comments_select on public.doc_comments for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or public._acl_comment_visible(doc_id, table_ref, row_id, col_id)));
drop policy doc_comments_insert on public.doc_comments;
create policy doc_comments_insert on public.doc_comments for insert to authenticated
  with check (doc_id = any ((select public.my_doc_ids(1))::uuid[]) and author = (select auth.uid())
              and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or public._acl_comment_visible(doc_id, table_ref, row_id, col_id)));

-- Attachments: visible when they're in a cell the person can read (or they uploaded them).
create or replace function public._acl_attachment_visible(p_doc uuid, p_att uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx jsonb;
  v_ok boolean;
  c record;
begin
  if not public._acl_ruled(p_doc) then
    return true;
  end if;
  v_ctx := public._acl_ctx_me(p_doc) || '{"_newRec": "r"}'::jsonb;
  for c in select col.id, col.table_ref from public.doc_columns col
           where col.doc_id = p_doc and col.type = 'Attachments' and not col.is_formula loop
    execute format('select exists (select 1 from public.doc_rows r where r.table_ref = %L and r.data -> %L @> %L::jsonb '
                   'and coalesce(%s, false) and coalesce(%s, false))',
                   c.table_ref, c.id::text, jsonb_build_array(p_att::text)::text,
                   public._acl_perm(p_doc, c.table_ref, null, 'read', v_ctx),
                   public._acl_perm(p_doc, c.table_ref, c.id, 'read', v_ctx))
    into v_ok;
    if v_ok then
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function public._acl_attachment_path_visible(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.doc_attachments a
    where a.path = p_path
      and (a.created_by = auth.uid() or public._acl_attachment_visible(a.doc_id, a.id))
  )
$$;

drop policy doc_attachments_select on public.doc_attachments;
create policy doc_attachments_select on public.doc_attachments for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[])
              or created_by = (select auth.uid()) or public._acl_attachment_visible(doc_id, id)));
drop policy doc_attachments_select_anon on public.doc_attachments;
create policy doc_attachments_select_anon on public.doc_attachments for select to anon
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[])
         and (doc_id <> all ((select public._acl_ruled_docs())::uuid[]) or public._acl_attachment_visible(doc_id, id)));

drop policy "Attachments readable by document readers" on storage.objects;
create policy "Attachments readable by document readers" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(1))::text[])
         and ((storage.foldername(name))[1] <> all ((select public._acl_ruled_docs())::text[])
              or public._acl_attachment_path_visible(name)));
drop policy "Attachments readable by link visitors" on storage.objects;
create policy "Attachments readable by link visitors" on storage.objects for select to anon
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(1))::text[])
         and ((storage.foldername(name))[1] <> all ((select public._acl_ruled_docs())::text[])
              or public._acl_attachment_path_visible(name)));

-- ============================================================
-- Snapshots, compare and copies hold unfiltered data
-- ============================================================
create or replace function public._acl_require_full_access(p_doc uuid, p_what text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is distinct from 'owner'
     and (public._acl_ruled(p_doc)
          or coalesce((select s.block_copies from public.doc_access_settings s where s.doc_id = p_doc), false)) then
    raise exception 'Only owners can % in this document', p_what using errcode = '42501';
  end if;
end $$;

create or replace function public.get_snapshot(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.doc_snapshots;
begin
  select * into s from public.doc_snapshots where id = p_id;
  if s.id is null or coalesce(public.role_rank(public.doc_role(s.doc_id)), 0) < 2 then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;
  perform public._acl_require_full_access(s.doc_id, 'open snapshots');
  return jsonb_build_object('id', s.id, 'doc_id', s.doc_id, 'kind', s.kind, 'label', s.label, 'created_at', s.created_at, 'content', s.content);
end $$;

create or replace function public.doc_content(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  perform public._acl_require_full_access(p_doc, 'compare versions');
  return public._doc_content(p_doc);
end $$;

-- Rules, user attributes and settings travel with copies (ids remapped).
create or replace function public._copy_access_rules(p_src uuid, p_dst uuid, p_map jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.doc_user_attributes (doc_id, name, user_field, table_ref, match_col)
  select p_dst, a.name, a.user_field, (p_map->>a.table_ref::text)::uuid, (p_map->>a.match_col::text)::uuid
  from public.doc_user_attributes a where a.doc_id = p_src;
  insert into public.doc_access_rules (doc_id, table_ref, col_ids, condition, condition_ast, permissions, memo, position)
  select p_dst, (p_map->>r.table_ref::text)::uuid,
         coalesce((select array_agg((p_map->>c::text)::uuid) from unnest(r.col_ids) c where p_map ? c::text), '{}'),
         r.condition, public._remap(r.condition_ast, p_map), r.permissions, r.memo, r.position
  from public.doc_access_rules r where r.doc_id = p_src;
  insert into public.doc_access_settings (doc_id, editors_structure, block_copies, public_rules)
  select p_dst, s.editors_structure, s.block_copies, s.public_rules from public.doc_access_settings s where s.doc_id = p_src
  on conflict (doc_id) do update set editors_structure = excluded.editors_structure,
    block_copies = excluded.block_copies, public_rules = excluded.public_rules, updated_at = now();
end $$;

create or replace function public._copy_content(p_src uuid, p_dst uuid, p_with_data boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_map jsonb := '{}';
  v_rows jsonb := '{}';
  v_col record;
  v_row record;
  v_new bigint;
begin
  select v_map || coalesce(jsonb_object_agg(id::text, gen_random_uuid()::text), '{}') into v_map from public.doc_tables where doc_id = p_src;
  select v_map || coalesce(jsonb_object_agg(id::text, gen_random_uuid()::text), '{}') into v_map from public.doc_columns where doc_id = p_src;
  select v_map || coalesce(jsonb_object_agg(id::text, gen_random_uuid()::text), '{}') into v_map from public.doc_pages where doc_id = p_src;
  select v_map || coalesce(jsonb_object_agg(id::text, gen_random_uuid()::text), '{}') into v_map from public.doc_widgets where doc_id = p_src;

  insert into public.doc_tables (id, doc_id, table_id, position)
  select (v_map->>t.id::text)::uuid, p_dst, t.table_id, t.position from public.doc_tables t where t.doc_id = p_src;
  insert into public.doc_columns (id, doc_id, table_ref, col_id, label, type, is_formula, formula, options, position)
  select (v_map->>c.id::text)::uuid, p_dst, (v_map->>c.table_ref::text)::uuid, c.col_id, c.label, c.type, c.is_formula, c.formula,
         public._remap(c.options, v_map), c.position
  from public.doc_columns c where c.doc_id = p_src;

  if p_with_data then
    for v_row in select id, table_ref, manual_sort, data from public.doc_rows where doc_id = p_src order by id loop
      insert into public.doc_rows (doc_id, table_ref, manual_sort, data)
      values (p_dst, (v_map->>v_row.table_ref::text)::uuid, v_row.manual_sort, public._remap(v_row.data, v_map))
      returning id into v_new;
      v_rows := v_rows || jsonb_build_object(v_row.id::text, v_new);
    end loop;
    -- References point at the new row ids; attachments are not copied.
    for v_col in select id, type from public.doc_columns where doc_id = p_dst and not is_formula and type in ('Ref', 'RefList', 'Attachments') loop
      if v_col.type = 'Ref' then
        update public.doc_rows set data = jsonb_set(data, array[v_col.id::text], coalesce(v_rows->(data->>v_col.id::text), 'null'))
        where doc_id = p_dst and jsonb_typeof(data->v_col.id::text) = 'number';
      elsif v_col.type = 'RefList' then
        update public.doc_rows set data = jsonb_set(data, array[v_col.id::text], coalesce((
          select jsonb_agg(v_rows->(e #>> '{}')) filter (where v_rows ? (e #>> '{}'))
          from jsonb_array_elements(data->v_col.id::text) e), 'null'))
        where doc_id = p_dst and jsonb_typeof(data->v_col.id::text) = 'array';
      else
        update public.doc_rows set data = data - v_col.id::text where doc_id = p_dst and data ? v_col.id::text;
      end if;
    end loop;
  end if;

  insert into public.doc_pages (id, doc_id, name, position, layout)
  select (v_map->>p.id::text)::uuid, p_dst, p.name, p.position, public._remap(p.layout, v_map) from public.doc_pages p where p.doc_id = p_src;
  insert into public.doc_widgets (id, doc_id, page_id, table_ref, type, title, position, width, height, options)
  select (v_map->>w.id::text)::uuid, p_dst, (v_map->>w.page_id::text)::uuid, (v_map->>w.table_ref::text)::uuid, w.type, w.title,
         w.position, w.width, w.height, public._remap(w.options, v_map)
  from public.doc_widgets w where w.doc_id = p_src;
  update public.doc_widgets d set link_source = (v_map->>w.link_source::text)::uuid, link_col = (v_map->>w.link_col::text)::uuid
  from public.doc_widgets w
  where w.doc_id = p_src and d.id = (v_map->>w.id::text)::uuid and (w.link_source is not null or w.link_col is not null);

  perform public._copy_access_rules(p_src, p_dst, v_map);
end $$;

create or replace function public.copy_document(p_doc uuid, p_workspace uuid, p_name text, p_with_data boolean default true, p_fork boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_new uuid;
begin
  if public.doc_role(p_doc) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if auth.uid() is null then
    raise exception 'Sign in to save a copy' using errcode = '42501';
  end if;
  perform public._acl_require_full_access(p_doc, 'copy the document');
  if not (p_workspace = any (public.my_workspace_ids(2))) then
    raise exception 'You can''t add documents to that workspace' using errcode = '42501';
  end if;
  insert into public.documents (workspace_id, name, created_by, forked_from)
  values (p_workspace, left(coalesce(nullif(btrim(p_name), ''), 'Copy'), 200), auth.uid(), case when p_fork then p_doc end)
  returning id into v_new;
  perform public._copy_content(p_doc, v_new, p_with_data);
  perform public._after_replace(v_new, jsonb_build_object('op', 'Copy', 'from', p_doc));
  return v_new;
end $$;

-- Replacing the original brings the copy's rules along (the original's go:
-- its tables are replaced, so rules about them would point at nothing).
create or replace function public.replace_with_copy(p_copy uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_orig uuid;
  v_backup bigint;
begin
  select forked_from into v_orig from public.documents where id = p_copy;
  if v_orig is null then
    raise exception 'This document is not a copy of another document';
  end if;
  if public.doc_role(v_orig) is distinct from 'owner' then
    raise exception 'Only owners of the original can replace it' using errcode = '42501';
  end if;
  if public.doc_role(p_copy) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  perform public._require_editor(v_orig);
  perform public._acl_require_full_access(p_copy, 'use this copy to replace the original');
  perform 1 from public.documents where id = v_orig for update;
  v_backup := public._take_snapshot(v_orig, 'before-replace', 'Before replacing with a copy');
  delete from public.doc_access_rules where doc_id = v_orig;
  delete from public.doc_user_attributes where doc_id = v_orig;
  perform public._clear_content(v_orig);
  perform public._copy_content(p_copy, v_orig, true);
  perform public._after_replace(v_orig, jsonb_build_object('op', 'Replace', 'from', p_copy, 'backup', v_backup));
  return v_backup;
end $$;

-- Restoring a snapshot keeps the current rules (snapshots don't contain them).
-- Rules about tables the snapshot doesn't have are dropped with those tables.
create or replace function public.restore_snapshot(p_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s public.doc_snapshots;
  v_backup bigint;
  v_shares jsonb;
  v_rules jsonb;
  v_attrs jsonb;
begin
  select * into s from public.doc_snapshots where id = p_id;
  if s.id is null or public.doc_role(s.doc_id) is distinct from 'owner' then
    raise exception 'Only owners can restore a snapshot' using errcode = '42501';
  end if;
  perform public._require_editor(s.doc_id);
  perform 1 from public.documents where id = s.doc_id for update;
  v_backup := public._take_snapshot(s.doc_id, 'before-restore', 'Before restoring ' || to_char(s.created_at, 'YYYY-MM-DD HH24:MI'));
  select coalesce(jsonb_agg(to_jsonb(f)), '[]') into v_shares from public.form_shares f where f.doc_id = s.doc_id;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v_rules from public.doc_access_rules r where r.doc_id = s.doc_id;
  select coalesce(jsonb_agg(to_jsonb(a)), '[]') into v_attrs from public.doc_user_attributes a where a.doc_id = s.doc_id;
  perform public._clear_content(s.doc_id);
  perform public._load_content(s.doc_id, s.content);
  insert into public.form_shares (id, token, doc_id, widget_id, is_active)
  select (f->>'id')::uuid, f->>'token', s.doc_id, (f->>'widget_id')::uuid, (f->>'is_active')::boolean
  from jsonb_array_elements(v_shares) f
  where exists (select 1 from public.doc_widgets w where w.id = (f->>'widget_id')::uuid and w.type = 'form')
  on conflict do nothing;
  insert into public.doc_access_rules
  select * from jsonb_populate_recordset(null::public.doc_access_rules, v_rules) r
  where r.table_ref is null or exists (select 1 from public.doc_tables t where t.id = r.table_ref)
  on conflict do nothing;
  insert into public.doc_user_attributes
  select * from jsonb_populate_recordset(null::public.doc_user_attributes, v_attrs) a
  where exists (select 1 from public.doc_columns c where c.id = a.match_col and c.table_ref = a.table_ref)
  on conflict do nothing;
  perform public._after_replace(s.doc_id, jsonb_build_object('op', 'Restore', 'snapshot', s.id, 'backup', v_backup));
  return v_backup;
end $$;

-- ============================================================
-- Change notices for documents with rules (Realtime Broadcast, private)
-- ============================================================
-- Only ids travel; the app re-reads them through read_rows().
create or replace function public._acl_notify(p_doc uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(p_payload, p_event, 'doc:' || p_doc::text, true);
exception when others then
  null;  -- a notification problem must never block saving
end $$;

create or replace function public.tg_acl_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_rows jsonb := '{}'::jsonb;
  v_ids jsonb;
  v_full boolean := false;
  v_count int := 0;
  op jsonb;
begin
  if not public._acl_ruled(new.doc_id) then
    return null;
  end if;
  for op in select value from jsonb_array_elements(new.actions) loop
    case op->>'op'
    when 'AddRecords', 'UpdateRecords' then
      select coalesce(jsonb_agg(e->'id'), '[]'::jsonb) into v_ids from jsonb_array_elements(coalesce(op->'records', '[]'::jsonb)) e;
    when 'RemoveRecords' then
      v_ids := coalesce(op->'ids', '[]'::jsonb);
    else
      -- Table and column changes can change what's visible; pages and widgets can't.
      if coalesce(op->>'entity', '') not in ('page', 'widget') then
        v_full := true;
      end if;
      continue;
    end case;
    v_rows := jsonb_set(v_rows, array[op->>'table'], coalesce(v_rows->(op->>'table'), '[]'::jsonb) || v_ids);
    v_count := v_count + jsonb_array_length(v_ids);
  end loop;
  if v_count > 2000 then
    v_full := true;
  end if;
  if v_full or v_count > 0 then
    perform public._acl_notify(new.doc_id, 'changes', jsonb_build_object(
      'action_id', new.id, 'full', v_full, 'rows', case when v_full then '{}'::jsonb else v_rows end));
  end if;
  return null;
end $$;
create trigger doc_actions_acl_changes after insert on public.doc_actions
  for each row execute function public.tg_acl_changes();

-- Server-computed formula values: tell readers of documents with rules which rows changed.
create or replace function public.worker_set_computed(p_doc uuid, p_secret text, p_updates jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_ids jsonb;
  v_count integer;
begin
  perform public._check_worker_secret(p_secret);
  with u as (
    update public.doc_rows r
    set computed = u.computed
    from jsonb_to_recordset(p_updates) as u(id bigint, computed jsonb)
    where r.id = u.id and r.doc_id = p_doc and r.computed is distinct from u.computed
    returning r.id
  )
  select coalesce(jsonb_agg(u.id), '[]'::jsonb), count(*) into v_ids, v_count from u;
  if v_count > 0 and public._acl_ruled(p_doc) then
    perform public._acl_notify(p_doc, 'computed', jsonb_build_object('ids', case when v_count > 2000 then null else v_ids end));
  end if;
  return v_count;
end $$;

-- Readers of a document may listen to its private channel; nobody may send on it.
create policy "Document readers receive change notices" on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast'
         and realtime.topic() like 'doc:%'
         and substr(realtime.topic(), 5) = any ((select public.my_doc_ids(1))::text[]));

-- ============================================================
-- Managing rules (owners)
-- ============================================================
create or replace function public.get_access_rules(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.doc_role(p_doc);
  v_settings public.doc_access_settings;
begin
  select * into v_settings from public.doc_access_settings where doc_id = p_doc;
  if v_role is null or (v_role <> 'owner' and not coalesce(v_settings.public_rules, false)) then
    raise exception 'Only owners can see the access rules of this document' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_edit', v_role = 'owner',
    'rules', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'table_ref', r.table_ref, 'col_ids', to_jsonb(r.col_ids), 'condition', r.condition,
        'condition_ast', r.condition_ast, 'permissions', r.permissions, 'memo', r.memo, 'position', r.position,
        'valid', public._acl_cond(r.condition_ast, p_doc, r.table_ref, public._acl_ctx_me(p_doc)) is not null)
        order by (r.table_ref is null), r.table_ref, r.position)
      from public.doc_access_rules r where r.doc_id = p_doc), '[]'::jsonb),
    'attributes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'user_field', a.user_field, 'table_ref', a.table_ref, 'match_col', a.match_col) order by a.name)
      from public.doc_user_attributes a where a.doc_id = p_doc), '[]'::jsonb),
    'settings_saved', v_settings.doc_id is not null,
    'settings', jsonb_build_object(
      'editors_structure', coalesce(v_settings.editors_structure, not public._acl_ruled(p_doc)),
      'block_copies', coalesce(v_settings.block_copies, false),
      'public_rules', coalesce(v_settings.public_rules, false)));
end $$;

-- Replaces all rules, user attributes and settings of a document at once.
--   p_rules: [{table_ref, col_ids, condition, condition_ast, permissions, memo}] in order
--   p_attributes: [{name, user_field, table_ref, match_col}]
--   p_settings: {editors_structure, block_copies, public_rules}
create or replace function public.save_access_rules(p_doc uuid, p_rules jsonb, p_attributes jsonb, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rule jsonb;
  v_n int := 0;
  v_table uuid;
  v_cols uuid[];
  v_perm text;
  v_ctx jsonb;
  t record;
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can change access rules' using errcode = '42501';
  end if;
  perform public._require_editor(p_doc);
  if jsonb_typeof(p_rules) is distinct from 'array' or jsonb_array_length(p_rules) > 500 then
    raise exception 'Rules must be a list of at most 500 rules';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'array' or jsonb_array_length(p_attributes) > 50 then
    raise exception 'User attributes must be a list of at most 50';
  end if;
  perform 1 from public.documents where id = p_doc for update;

  delete from public.doc_access_rules where doc_id = p_doc;
  delete from public.doc_user_attributes where doc_id = p_doc;

  insert into public.doc_user_attributes (doc_id, name, user_field, table_ref, match_col)
  select p_doc, a->>'name', coalesce(a->>'user_field', 'Email'), (a->>'table_ref')::uuid, (a->>'match_col')::uuid
  from jsonb_array_elements(p_attributes) a;
  if exists (
    select 1 from public.doc_user_attributes a
    where a.doc_id = p_doc and not exists (
      select 1 from public.doc_columns c join public.doc_tables dt on dt.id = c.table_ref
      where c.id = a.match_col and c.table_ref = a.table_ref and dt.doc_id = p_doc)
  ) then
    raise exception 'A user attribute refers to a table or column of another document';
  end if;

  for v_rule in select value from jsonb_array_elements(p_rules) loop
    v_n := v_n + 1;
    v_table := nullif(v_rule->>'table_ref', '')::uuid;
    if v_table is not null and not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
      raise exception 'Rule %: unknown table', v_n;
    end if;
    select coalesce(array_agg(x::uuid), '{}') into v_cols from jsonb_array_elements_text(coalesce(v_rule->'col_ids', '[]'::jsonb)) x;
    if cardinality(v_cols) > 0 and (v_table is null or exists (
      select 1 from unnest(v_cols) c where not exists (select 1 from public.doc_columns dc where dc.id = c and dc.table_ref = v_table))) then
      raise exception 'Rule %: unknown column', v_n;
    end if;
    if jsonb_typeof(v_rule->'permissions') is distinct from 'object' or v_rule->'permissions' = '{}'::jsonb then
      raise exception 'Rule % must allow or deny something', v_n;
    end if;
    for v_perm in select jsonb_object_keys(v_rule->'permissions') loop
      if v_perm not in ('read', 'create', 'update', 'delete') or jsonb_typeof(v_rule->'permissions'->v_perm) <> 'boolean' then
        raise exception 'Rule %: invalid permission %', v_n, v_perm;
      end if;
    end loop;
    insert into public.doc_access_rules (doc_id, table_ref, col_ids, condition, condition_ast, permissions, memo, position)
    values (p_doc, v_table, v_cols, coalesce(v_rule->>'condition', ''),
            case when jsonb_typeof(v_rule->'condition_ast') = 'object' then v_rule->'condition_ast' end,
            v_rule->'permissions', nullif(btrim(coalesce(v_rule->>'memo', '')), ''), v_n);
  end loop;

  insert into public.doc_access_settings (doc_id, editors_structure, block_copies, public_rules)
  values (p_doc, coalesce((p_settings->>'editors_structure')::boolean, true),
          coalesce((p_settings->>'block_copies')::boolean, false), coalesce((p_settings->>'public_rules')::boolean, false))
  on conflict (doc_id) do update set editors_structure = excluded.editors_structure, block_copies = excluded.block_copies,
    public_rules = excluded.public_rules, updated_at = now();

  -- Every condition must compile, and every table must stay readable by the engine.
  v_ctx := public._acl_ctx_me(p_doc);
  v_n := 0;
  for v_rule in select to_jsonb(r) from public.doc_access_rules r where r.doc_id = p_doc order by r.position loop
    v_n := v_n + 1;
    if v_rule->'condition_ast' <> 'null'::jsonb then
      begin
        perform public._acl_bool(v_rule->'condition_ast', p_doc, nullif(v_rule->>'table_ref', '')::uuid, v_ctx, 0);
      exception when others then
        raise exception 'Rule % (%): %', v_n, coalesce(nullif(v_rule->>'condition', ''), 'condition'), sqlerrm;
      end;
    end if;
  end loop;
  for t in select dt.id from public.doc_tables dt where dt.doc_id = p_doc loop
    execute format('select 1 from (%s) x limit 1', public._acl_read_sql(p_doc, t.id, v_ctx));
  end loop;

  perform public._acl_notify(p_doc, 'acl', '{}'::jsonb);
  return public.get_access_rules(p_doc);
end $$;

-- ============================================================
-- Grants
-- ============================================================
revoke execute on function
  public._acl_ruled(uuid), public._acl_ruled_docs(), public._role_of(uuid, uuid), public._acl_ctx(uuid, uuid, text),
  public._acl_ctx_me(uuid), public._acl_request_ctx(uuid, text), public._acl_truthy(jsonb), public._acl_cmp(jsonb, text, jsonb),
  public._acl_in(jsonb, jsonb), public._acl_fn(text, jsonb), public._acl_ref_cell(jsonb, uuid, uuid, boolean),
  public._acl_val(jsonb, uuid, uuid, jsonb, int), public._acl_bool(jsonb, uuid, uuid, jsonb, int),
  public._acl_cond(jsonb, uuid, uuid, jsonb), public._acl_perm(uuid, uuid, uuid, text, jsonb), public._acl_const(text),
  public._acl_read_sql(uuid, uuid, jsonb), public._acl_can_read(uuid, uuid, bigint, uuid, jsonb),
  public._acl_col_hidden(uuid, uuid, uuid), public._acl_can_structure(uuid, jsonb), public._acl_check_op(uuid, jsonb, jsonb),
  public._apply_and_log(uuid, jsonb, text, bigint, boolean, text, boolean), public._acl_comment_visible(uuid, uuid, bigint, uuid),
  public._acl_attachment_visible(uuid, uuid), public._acl_attachment_path_visible(text),
  public._acl_require_full_access(uuid, text), public._copy_access_rules(uuid, uuid, jsonb), public._acl_notify(uuid, text, jsonb),
  public.tg_acl_changes()
from public, anon, authenticated;
-- Row-level security policies call these as the querying role.
grant execute on function public._acl_ruled_docs(), public._acl_col_hidden(uuid, uuid, uuid),
  public._acl_comment_visible(uuid, uuid, bigint, uuid), public._acl_attachment_visible(uuid, uuid),
  public._acl_attachment_path_visible(text)
to anon, authenticated;

revoke execute on function
  public.read_rows(uuid, bigint, int, bigint[], text), public.acl_info(uuid, text),
  public.get_access_rules(uuid), public.save_access_rules(uuid, jsonb, jsonb, jsonb)
from public, anon;
grant execute on function
  public.read_rows(uuid, bigint, int, bigint[], text), public.acl_info(uuid, text),
  public.get_access_rules(uuid), public.save_access_rules(uuid, jsonb, jsonb, jsonb)
to authenticated;
-- Signed-out link visitors read through the same filtered path.
grant execute on function public.read_rows(uuid, bigint, int, bigint[], text), public.acl_info(uuid, text) to anon;
