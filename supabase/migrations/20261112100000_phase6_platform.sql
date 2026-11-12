-- Phase 6: platform.
--
--  * Document settings (documents.settings): locale, default currency and time
--    zone. Validated here; owners and editors change them like the name.
--    Changing the time zone asks the formula worker for a full recalculation
--    (TODAY() depends on it). Copies and backups keep them.
--  * Administrators (app_admins) see every account in the admin panel, change
--    plans and read the whole audit log. Add the first one by hand:
--      insert into public.app_admins (user_id) select id from public.profiles where email = '<you>';
--  * Plans and limits: each account (a person's own workspaces, or a team) has
--    a plan (plans) limiting documents, records per document and attachment
--    storage. Enforced by triggers, so every write path (app, API, forms,
--    copies, backups) is covered. Documents in the trash don't count.
--  * Usage: doc_usage keeps each document's record count and attachment bytes
--    (maintained by triggers); usage_counters counts activity per day
--    (actions by source per document, API calls per person).
--  * Audit log (audit_log): sharing, membership, documents created / renamed /
--    moved / trashed / deleted, settings, access rules, integrations, API keys,
--    plans and administrators. Read through audit_events(): administrators
--    everything, team owners their team, document owners their document.
--    Kept for a year; usage counters for 400 days.

-- ============================================================
-- Document settings
-- ============================================================
alter table public.documents add column settings jsonb not null default '{}'::jsonb;

-- Checks and returns document settings; raises 22023 for anything else.
create or replace function public._check_doc_settings(p jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  k text;
  v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Document settings must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('locale', 'currency', 'timezone') then
      raise exception 'Unknown document setting "%"', k using errcode = '22023';
    end if;
    if jsonb_typeof(p -> k) <> 'string' then
      raise exception 'The document setting "%" must be text', k using errcode = '22023';
    end if;
  end loop;
  v := p ->> 'locale';
  if v is not null and (length(v) > 35 or v !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$') then
    raise exception 'Unknown locale "%"', v using errcode = '22023';
  end if;
  v := p ->> 'currency';
  if v is not null and v !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter code such as EUR' using errcode = '22023';
  end if;
  v := p ->> 'timezone';
  if v is not null then
    if length(v) > 64 or v !~ '^[A-Za-z0-9_+/-]+$' then
      raise exception 'Unknown time zone "%"', v using errcode = '22023';
    end if;
    begin
      perform now() at time zone v;
    exception when others then
      raise exception 'Unknown time zone "%"', v using errcode = '22023';
    end;
  end if;
  return p;
end $$;

create or replace function public.tg_doc_settings_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.settings := public._check_doc_settings(coalesce(new.settings, '{}'::jsonb));
  return new;
end $$;
create trigger documents_settings_check before insert or update of settings on public.documents
  for each row execute function public.tg_doc_settings_check();

-- Owners and editors of the document (also people it is shared with directly,
-- who can't update the documents row itself).
create or replace function public.set_doc_settings(p_doc uuid, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if auth.uid() is null or coalesce(public.doc_role(p_doc), '') not in ('owner', 'editor') then
    raise exception 'Only owners and editors can change document settings' using errcode = '42501';
  end if;
  update public.documents set settings = public._check_doc_settings(p_settings)
  where id = p_doc and deleted_at is null
  returning settings into v;
  if v is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  return v;
end $$;

-- A new time zone changes TODAY(): recompute every formula. (If a run is going
-- right now it may finish incrementally; the next change catches up.)
create or replace function public.tg_doc_timezone_recalc()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_start boolean := false;
begin
  if (old.settings ->> 'timezone') is not distinct from (new.settings ->> 'timezone') then
    return null;
  end if;
  insert into public.doc_recalc (doc_id) values (new.id) on conflict (doc_id) do nothing;
  update public.doc_recalc set done_id = 0, updated_at = now() where doc_id = new.id;
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
create trigger documents_timezone_recalc after update of settings on public.documents
  for each row execute function public.tg_doc_timezone_recalc();

-- Copies keep the original's settings.
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
  insert into public.documents (workspace_id, name, created_by, forked_from, settings)
  values (p_workspace, left(coalesce(nullif(btrim(p_name), ''), 'Copy'), 200), auth.uid(), case when p_fork then p_doc end,
          (select d.settings from public.documents d where d.id = p_doc))
  returning id into v_new;
  perform public._copy_content(p_doc, v_new, p_with_data);
  perform public._after_replace(v_new, jsonb_build_object('op', 'Copy', 'from', p_doc));
  return v_new;
end $$;

-- Backups carry the settings (top-level "settings"); restoring applies them.
create or replace function public.doc_backup(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
  v_settings jsonb;
  v_access jsonb;
begin
  if public.doc_role(p_doc) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  perform public._acl_require_full_access(p_doc, 'download a backup');
  select name, settings into v_name, v_settings from public.documents where id = p_doc;
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
                            'settings', coalesce(v_settings, '{}'::jsonb),
                            'content', public._doc_content(p_doc), 'access', v_access);
end $$;

alter function public.restore_backup(uuid, text, jsonb) rename to _restore_backup_content;
revoke execute on function public._restore_backup_content(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.restore_backup(p_workspace uuid, p_name text, p_backup jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_new uuid;
begin
  v_new := public._restore_backup_content(p_workspace, p_name, p_backup);
  -- Settings a file can't vouch for are dropped rather than failing the restore.
  if jsonb_typeof(p_backup -> 'settings') = 'object' then
    begin
      update public.documents set settings = public._check_doc_settings(p_backup -> 'settings') where id = v_new;
    exception when sqlstate '22023' then
      null;
    end;
  end if;
  return v_new;
end $$;
revoke execute on function public.restore_backup(uuid, text, jsonb) from public, anon;
grant execute on function public.restore_backup(uuid, text, jsonb) to authenticated;

-- ============================================================
-- Administrators
-- ============================================================
create table public.app_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (select 1 from public.app_admins a where a.user_id = auth.uid())
$$;

create or replace function public._require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_app_admin() then
    raise exception 'Only administrators can do this' using errcode = '42501';
  end if;
end $$;

-- ============================================================
-- Plans and limits
-- ============================================================
create table public.plans (
  id text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
  name text not null,
  -- null = no limit
  max_docs int check (max_docs > 0),
  max_rows_per_doc int check (max_rows_per_doc > 0),
  max_attachment_mb int check (max_attachment_mb > 0),
  position int not null default 0
);
alter table public.plans enable row level security;
create policy plans_select on public.plans for select to authenticated using (true);
revoke insert, update, delete on public.plans from anon, authenticated;
insert into public.plans (id, name, max_docs, max_rows_per_doc, max_attachment_mb, position) values
  ('free', 'Free', 100, 100000, 2048, 1),
  ('pro', 'Pro', 1000, 500000, 51200, 2),
  ('unlimited', 'Unlimited', null, null, null, 3);

alter table public.profiles add column plan text not null default 'free' references public.plans(id) on update cascade;
alter table public.teams add column plan text not null default 'free' references public.plans(id) on update cascade;

-- People may update their own profile and team owners their team, but only
-- administrators (through admin_set_plan) change a plan. Security invoker on
-- purpose: current_user is the role making the change.
create or replace function public.tg_guard_plan()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.plan is distinct from old.plan and current_user in ('anon', 'authenticated') and not public.is_app_admin() then
    raise exception 'Only administrators can change plans' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard_plan before update of plan on public.profiles
  for each row execute function public.tg_guard_plan();
create trigger teams_guard_plan before update of plan on public.teams
  for each row execute function public.tg_guard_plan();

-- The account a workspace belongs to: its team, or else its owner's own account.
create or replace function public._workspace_account(p_workspace uuid, out kind text, out account_id uuid, out plan_id text)
language sql stable security definer set search_path = '' as $$
  select case when w.team_id is null then 'user' else 'team' end,
         coalesce(w.team_id, w.owner_id),
         coalesce(case when w.team_id is null then p.plan else t.plan end, 'free')
  from public.workspaces w
  left join public.teams t on t.id = w.team_id
  left join public.profiles p on p.id = w.owner_id
  where w.id = p_workspace
$$;

-- Live (not trashed) documents of an account.
create or replace function public._account_docs(p_kind text, p_account uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.documents d join public.workspaces w on w.id = d.workspace_id
  where d.deleted_at is null
    and ((p_kind = 'team' and w.team_id = p_account) or (p_kind = 'user' and w.team_id is null and w.owner_id = p_account))
$$;

create or replace function public._doc_plan(p_doc uuid)
returns public.plans language sql stable security definer set search_path = '' as $$
  select pl.* from public.documents d
  cross join lateral public._workspace_account(d.workspace_id) a
  join public.plans pl on pl.id = a.plan_id
  where d.id = p_doc
$$;

-- Number of documents.
create or replace function public.tg_limit_docs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  a record;
  v_max int;
  v_count int;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.workspace_id is not distinct from old.workspace_id and old.deleted_at is null then
    return new;
  end if;
  select * into a from public._workspace_account(new.workspace_id);
  if a.kind is null then
    return new;
  end if;
  select max_docs into v_max from public.plans where id = a.plan_id;
  if v_max is null then
    return new;
  end if;
  select count(*) into v_count from public._account_docs(a.kind, a.account_id) x where x <> new.id;
  if v_count >= v_max then
    raise exception '% reached the % plan''s limit of % documents. Delete some or move them to the trash, or ask an administrator for a larger plan.',
      case when a.kind = 'team' then 'This team has' else 'You have' end, a.plan_id, v_max
      using errcode = '54000';
  end if;
  return new;
end $$;
create trigger documents_limit before insert or update of workspace_id, deleted_at on public.documents
  for each row execute function public.tg_limit_docs();

-- ============================================================
-- Usage
-- ============================================================
create table public.doc_usage (
  doc_id uuid primary key references public.documents(id) on delete cascade,
  rows bigint not null default 0,
  attachment_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.doc_usage enable row level security;
create policy doc_usage_select on public.doc_usage for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[]));
revoke insert, update, delete on public.doc_usage from anon, authenticated;

insert into public.doc_usage (doc_id, rows, attachment_bytes)
select d.id,
       (select count(*) from public.doc_rows r where r.doc_id = d.id),
       (select coalesce(sum(a.size), 0) from public.doc_attachments a where a.doc_id = d.id)
from public.documents d;

create or replace function public.tg_doc_usage_new()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.doc_usage (doc_id) values (new.id) on conflict do nothing;
  return null;
end $$;
create trigger documents_usage after insert on public.documents
  for each row execute function public.tg_doc_usage_new();

-- Records: counted per statement; adding past the plan's limit fails.
create or replace function public.tg_rows_usage_add()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_max int;
begin
  for r in
    with c as (select doc_id, count(*) as n from new_rows group by doc_id)
    insert into public.doc_usage as u (doc_id, rows) select doc_id, n from c
    on conflict (doc_id) do update set rows = u.rows + excluded.rows, updated_at = now()
    returning u.doc_id, u.rows
  loop
    select max_rows_per_doc into v_max from public._doc_plan(r.doc_id);
    if v_max is not null and r.rows > v_max then
      raise exception 'This document reached its plan''s limit of % records. Delete some, or ask an administrator for a larger plan.', v_max
        using errcode = '54000';
    end if;
  end loop;
  return null;
end $$;
create trigger doc_rows_usage_add after insert on public.doc_rows
  referencing new table as new_rows for each statement execute function public.tg_rows_usage_add();

create or replace function public.tg_rows_usage_remove()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.doc_usage u set rows = greatest(u.rows - c.n, 0), updated_at = now()
  from (select doc_id, count(*) as n from old_rows group by doc_id) c
  where u.doc_id = c.doc_id;
  return null;
end $$;
create trigger doc_rows_usage_remove after delete on public.doc_rows
  referencing old table as old_rows for each statement execute function public.tg_rows_usage_remove();

-- Attachment storage, per account.
create or replace function public.tg_attachments_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_max int;
  a record;
  v_total bigint;
begin
  if tg_op = 'DELETE' then
    update public.doc_usage set attachment_bytes = greatest(attachment_bytes - coalesce(old.size, 0), 0), updated_at = now()
    where doc_id = old.doc_id;
    return null;
  end if;
  insert into public.doc_usage as u (doc_id, attachment_bytes) values (new.doc_id, coalesce(new.size, 0))
  on conflict (doc_id) do update set attachment_bytes = u.attachment_bytes + excluded.attachment_bytes, updated_at = now();
  select x.* into a from public.documents d cross join lateral public._workspace_account(d.workspace_id) x where d.id = new.doc_id;
  select max_attachment_mb into v_max from public.plans where id = a.plan_id;
  if v_max is not null and coalesce(new.size, 0) > 0 then
    select coalesce(sum(u.attachment_bytes), 0) into v_total
    from public.doc_usage u where u.doc_id in (select public._account_docs(a.kind, a.account_id)) or u.doc_id = new.doc_id;
    if v_total > v_max::bigint * 1024 * 1024 then
      raise exception '% reached the % plan''s limit of % MB of attachments. Remove some files, or ask an administrator for a larger plan.',
        case when a.kind = 'team' then 'This team has' else 'You have' end, a.plan_id, v_max
        using errcode = '54000';
    end if;
  end if;
  return null;
end $$;
create trigger doc_attachments_usage after insert or delete on public.doc_attachments
  for each row execute function public.tg_attachments_usage();

-- Activity per day.
create table public.usage_counters (
  day date not null default current_date,
  scope text not null check (scope in ('doc', 'user')),
  scope_id uuid not null,
  metric text not null,
  value bigint not null default 0,
  primary key (day, scope, scope_id, metric)
);
create index usage_counters_scope_idx on public.usage_counters (scope, scope_id, day);
alter table public.usage_counters enable row level security;
revoke all on public.usage_counters from anon, authenticated;

create or replace function public._count_usage(p_scope text, p_id uuid, p_metric text, p_n bigint default 1)
returns void language sql security definer set search_path = '' as $$
  insert into public.usage_counters as c (scope, scope_id, metric, value) values (p_scope, p_id, p_metric, p_n)
  on conflict (day, scope, scope_id, metric) do update set value = c.value + excluded.value
$$;

create or replace function public.tg_count_actions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._count_usage('doc', new.doc_id, 'actions.' || new.source);
  return null;
end $$;
create trigger doc_actions_count after insert on public.doc_actions
  for each row execute function public.tg_count_actions();

-- _api_auth as in Phase 5, plus a count of API calls per person and day.
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
  perform public._count_usage('user', v_user, 'api_calls');
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return v_user;
end $$;

-- ============================================================
-- Audit log
-- ============================================================
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tx bigint not null default txid_current(),
  actor uuid,            -- null: the system (scheduled jobs, the database owner)
  actor_email text,
  event text not null,
  team_id uuid,
  workspace_id uuid,
  doc_id uuid,
  target text,           -- who or what the event is about (an email, a key label)
  details jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_team_idx on public.audit_log (team_id, at desc) where team_id is not null;
create index audit_log_doc_idx on public.audit_log (doc_id, at desc) where doc_id is not null;
create index audit_log_actor_idx on public.audit_log (actor, at desc);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

create or replace function public._audit(p_event text, p_team uuid, p_workspace uuid, p_doc uuid, p_target text default null, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
begin
  insert into public.audit_log (actor, actor_email, event, team_id, workspace_id, doc_id, target, details)
  values (v_actor, (select p.email from public.profiles p where p.id = v_actor), p_event, p_team, p_workspace, p_doc, p_target,
          coalesce(p_details, '{}'::jsonb));
end $$;

-- One event per document, event and transaction (for changes saved as many rows).
create or replace function public._audit_once(p_event text, p_doc uuid, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_team uuid;
begin
  if p_doc is null or exists (select 1 from public.audit_log l where l.doc_id = p_doc and l.event = p_event and l.tx = txid_current()) then
    return;
  end if;
  select d.workspace_id, w.team_id into v_ws, v_team
  from public.documents d join public.workspaces w on w.id = d.workspace_id where d.id = p_doc;
  if v_ws is null then
    return; -- the document is being deleted
  end if;
  perform public._audit(p_event, v_team, v_ws, p_doc, null, p_details);
end $$;

create or replace function public.tg_audit_documents()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
begin
  if tg_op = 'DELETE' then
    select team_id into v_team from public.workspaces where id = old.workspace_id;
    perform public._audit('doc.deleted', v_team, old.workspace_id, old.id, old.name, '{}');
    return null;
  end if;
  select team_id into v_team from public.workspaces where id = new.workspace_id;
  if tg_op = 'INSERT' then
    perform public._audit('doc.created', v_team, new.workspace_id, new.id, new.name,
                          jsonb_strip_nulls(jsonb_build_object('copy_of', new.forked_from)));
    return null;
  end if;
  if new.name is distinct from old.name then
    perform public._audit('doc.renamed', v_team, new.workspace_id, new.id, new.name, jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.workspace_id is distinct from old.workspace_id then
    perform public._audit('doc.moved', v_team, new.workspace_id, new.id, new.name,
                          jsonb_build_object('from_workspace', old.workspace_id, 'to_workspace', new.workspace_id));
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    perform public._audit('doc.trashed', v_team, new.workspace_id, new.id, new.name, '{}');
  elsif old.deleted_at is not null and new.deleted_at is null then
    perform public._audit('doc.restored', v_team, new.workspace_id, new.id, new.name, '{}');
  end if;
  if new.settings is distinct from old.settings then
    perform public._audit('doc.settings_changed', v_team, new.workspace_id, new.id, new.name,
                          jsonb_build_object('from', old.settings, 'to', new.settings));
  end if;
  return null;
end $$;
create trigger documents_audit after insert or update of name, workspace_id, deleted_at, settings or delete on public.documents
  for each row execute function public.tg_audit_documents();

-- Members of documents, workspaces and teams.
create or replace function public.tg_audit_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  v_kind text := case tg_table_name when 'document_members' then 'document' when 'workspace_members' then 'workspace' else 'team' end;
  v_doc uuid;
  v_ws uuid;
  v_team uuid;
  v_creator uuid;
  v_new_parent boolean := false;
  v_email text;
begin
  if v_kind = 'document' then
    v_doc := (r->>'doc_id')::uuid;
    select d.workspace_id, w.team_id, d.created_by, d.created_at = now() into v_ws, v_team, v_creator, v_new_parent
    from public.documents d join public.workspaces w on w.id = d.workspace_id where d.id = v_doc;
  elsif v_kind = 'workspace' then
    v_ws := (r->>'workspace_id')::uuid;
    select w.team_id, w.owner_id, w.created_at = now() into v_team, v_creator, v_new_parent from public.workspaces w where w.id = v_ws;
  else
    v_team := (r->>'team_id')::uuid;
    select t.created_by, t.created_at = now() into v_creator, v_new_parent from public.teams t where t.id = v_team;
  end if;
  if v_new_parent is null then
    return null; -- removed along with its document, workspace or team
  end if;
  -- The creator becoming owner of something they just created isn't news.
  if tg_op = 'INSERT' and v_new_parent and new.user_id = v_creator and new.role = 'owner' then
    return null;
  end if;
  select email into v_email from public.profiles where id = (r->>'user_id')::uuid;
  if tg_op = 'INSERT' then
    perform public._audit('member.added', v_team, v_ws, v_doc, v_email, jsonb_build_object('resource', v_kind, 'role', new.role));
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      perform public._audit('member.role_changed', v_team, v_ws, v_doc, v_email,
                            jsonb_build_object('resource', v_kind, 'from', old.role, 'to', new.role));
    end if;
  else
    perform public._audit('member.removed', v_team, v_ws, v_doc, v_email, jsonb_build_object('resource', v_kind, 'role', old.role));
  end if;
  return null;
end $$;
create trigger document_members_audit after insert or update or delete on public.document_members
  for each row execute function public.tg_audit_members();
create trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function public.tg_audit_members();
create trigger team_members_audit after insert or update or delete on public.team_members
  for each row execute function public.tg_audit_members();

create or replace function public.tg_audit_invites()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := new.workspace_id;
  v_team uuid := new.team_id;
begin
  if new.doc_id is not null then
    select d.workspace_id, w.team_id into v_ws, v_team from public.documents d join public.workspaces w on w.id = d.workspace_id where d.id = new.doc_id;
  elsif new.workspace_id is not null then
    select team_id into v_team from public.workspaces where id = new.workspace_id;
  end if;
  perform public._audit('member.invited', v_team, v_ws, new.doc_id, new.email,
                        jsonb_build_object('resource', case when new.doc_id is not null then 'document' when new.workspace_id is not null then 'workspace' else 'team' end,
                                           'role', new.role));
  return null;
end $$;
create trigger pending_invites_audit after insert on public.pending_invites
  for each row execute function public.tg_audit_invites();

create or replace function public.tg_audit_share_links()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_team uuid;
begin
  select d.workspace_id, w.team_id into v_ws, v_team from public.documents d join public.workspaces w on w.id = d.workspace_id where d.id = new.doc_id;
  if v_ws is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform public._audit('share_link.created', v_team, v_ws, new.doc_id, null,
                          jsonb_build_object('role', new.role, 'allow_anonymous', new.allow_anonymous, 'expires_at', new.expires_at));
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform public._audit('share_link.revoked', v_team, v_ws, new.doc_id, null, jsonb_build_object('role', new.role));
  end if;
  return null;
end $$;
create trigger doc_share_links_audit after insert or update of revoked_at on public.doc_share_links
  for each row execute function public.tg_audit_share_links();

create or replace function public.tg_audit_api_keys()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public._audit('api_key.created', null, null, null, new.label, jsonb_build_object('prefix', new.prefix));
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform public._audit('api_key.revoked', null, null, null, new.label, jsonb_build_object('prefix', new.prefix));
  end if;
  return null;
end $$;
create trigger api_keys_audit after insert or update of revoked_at on public.api_keys
  for each row execute function public.tg_audit_api_keys();

-- Access rules and integrations: one event per document and save.
create or replace function public.tg_audit_doc_config()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._audit_once(tg_argv[0], (to_jsonb(coalesce(new, old))->>'doc_id')::uuid, '{}');
  return null;
end $$;
create trigger doc_access_rules_audit after insert or update or delete on public.doc_access_rules
  for each row execute function public.tg_audit_doc_config('access_rules.changed');
create trigger doc_user_attributes_audit after insert or update or delete on public.doc_user_attributes
  for each row execute function public.tg_audit_doc_config('access_rules.changed');
create trigger doc_access_settings_audit after insert or update or delete on public.doc_access_settings
  for each row execute function public.tg_audit_doc_config('access_rules.changed');
create trigger doc_webhooks_audit after insert or update or delete on public.doc_webhooks
  for each row execute function public.tg_audit_doc_config('integrations.changed');
create trigger doc_automations_audit after insert or update or delete on public.doc_automations
  for each row execute function public.tg_audit_doc_config('integrations.changed');

create or replace function public.tg_audit_teams()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public._audit('team.created', new.id, null, null, new.name, '{}');
  elsif tg_op = 'DELETE' then
    perform public._audit('team.deleted', old.id, null, null, old.name, '{}');
  else
    if new.name is distinct from old.name then
      perform public._audit('team.renamed', new.id, null, null, new.name, jsonb_build_object('from', old.name, 'to', new.name));
    end if;
    if new.plan is distinct from old.plan then
      perform public._audit('plan.changed', new.id, null, null, new.name, jsonb_build_object('account', 'team', 'from', old.plan, 'to', new.plan));
    end if;
  end if;
  return null;
end $$;
create trigger teams_audit after insert or update of name, plan or delete on public.teams
  for each row execute function public.tg_audit_teams();

create or replace function public.tg_audit_profile_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._audit('plan.changed', null, null, null, new.email, jsonb_build_object('account', 'user', 'from', old.plan, 'to', new.plan));
  return null;
end $$;
create trigger profiles_plan_audit after update of plan on public.profiles
  for each row when (new.plan is distinct from old.plan) execute function public.tg_audit_profile_plan();

create or replace function public.tg_audit_admins()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._audit(case when tg_op = 'INSERT' then 'admin.added' else 'admin.removed' end, null, null, null,
                        (select email from public.profiles where id = coalesce(new.user_id, old.user_id)), '{}');
  return null;
end $$;
create trigger app_admins_audit after insert or delete on public.app_admins
  for each row execute function public.tg_audit_admins();

-- Reading the log. Administrators: everything. Team owners: their team.
-- Document owners: their document. Newest first; page with p_before (an id).
create or replace function public.audit_events(
  p_team uuid default null, p_doc uuid default null, p_from timestamptz default null, p_to timestamptz default null,
  p_event text default null, p_actor text default null, p_limit int default 500, p_before bigint default null
)
returns table (id bigint, at timestamptz, actor uuid, actor_email text, event text, team_id uuid, team_name text,
               workspace_id uuid, doc_id uuid, doc_name text, target text, details jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to read the audit log' using errcode = '42501';
  end if;
  if not public.is_app_admin() then
    if p_team is not null then
      if not (p_team = any (public.my_team_ids(3))) then
        raise exception 'Only owners of this team can read its audit log' using errcode = '42501';
      end if;
    elsif p_doc is not null then
      if public.doc_role(p_doc) is distinct from 'owner' then
        raise exception 'Only owners of this document can read its audit log' using errcode = '42501';
      end if;
    else
      raise exception 'Only administrators can read the whole audit log' using errcode = '42501';
    end if;
  end if;
  return query
  select l.id, l.at, l.actor, l.actor_email, l.event, l.team_id, t.name, l.workspace_id, l.doc_id,
         coalesce(d.name, case when l.event = 'doc.deleted' then l.target end), l.target, l.details
  from public.audit_log l
  left join public.teams t on t.id = l.team_id
  left join public.documents d on d.id = l.doc_id
  where (p_team is null or l.team_id = p_team)
    and (p_doc is null or l.doc_id = p_doc)
    and (p_from is null or l.at >= p_from)
    and (p_to is null or l.at < p_to)
    and (p_event is null or l.event like p_event || '%')
    and (p_actor is null or l.actor_email ilike '%' || p_actor || '%')
    and (p_before is null or l.id < p_before)
  order by l.id desc
  limit least(greatest(coalesce(p_limit, 500), 1), 5000);
end $$;

-- ============================================================
-- Usage for people, and the admin panel
-- ============================================================
create or replace function public._account_usage(p_kind text, p_account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with docs as (select x as id from public._account_docs(p_kind, p_account) x),
       u as (select coalesce(sum(du.rows), 0) as rows, coalesce(max(du.rows), 0) as max_rows,
                    coalesce(sum(du.attachment_bytes), 0) as bytes
             from public.doc_usage du where du.doc_id in (select id from docs)),
       act as (select coalesce(sum(c.value), 0) as n from public.usage_counters c
               where c.scope = 'doc' and c.scope_id in (select id from docs) and c.day > current_date - 30)
  select jsonb_build_object(
    'docs', (select count(*) from docs),
    'rows', u.rows, 'largest_doc_rows', u.max_rows, 'attachment_bytes', u.bytes, 'actions_30d', act.n)
  from u, act
$$;

-- The caller's own account, or a team they belong to: plan, limits and usage.
create or replace function public.my_usage(p_team uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_kind text := case when p_team is null then 'user' else 'team' end;
  v_id uuid := coalesce(p_team, auth.uid());
begin
  if auth.uid() is null then
    raise exception 'Sign in to see your usage' using errcode = '42501';
  end if;
  if p_team is not null and not (p_team = any (public.my_team_ids(1))) and not public.is_app_admin() then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  select pl.* into v_plan from public.plans pl
  where pl.id = coalesce(case when p_team is null then (select plan from public.profiles where id = v_id)
                              else (select plan from public.teams where id = v_id) end, 'free');
  return jsonb_build_object('plan', to_jsonb(v_plan), 'usage', public._account_usage(v_kind, v_id),
                            'api_calls_30d', case when p_team is null then
                              (select coalesce(sum(value), 0) from public.usage_counters
                               where scope = 'user' and scope_id = v_id and metric = 'api_calls' and day > current_date - 30) end);
end $$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'people', (select count(*) from public.profiles),
    'teams', (select count(*) from public.teams),
    'documents', (select count(*) from public.documents where deleted_at is null),
    'trashed', (select count(*) from public.documents where deleted_at is not null),
    'rows', (select coalesce(sum(rows), 0) from public.doc_usage),
    'attachment_bytes', (select coalesce(sum(attachment_bytes), 0) from public.doc_usage),
    'admins', (select count(*) from public.app_admins),
    'activity', (select coalesce(jsonb_object_agg(metric, n), '{}') from (
                   select metric, sum(value) as n from public.usage_counters where day > current_date - 30 group by metric) m),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'actions', n) order by day), '[]') from (
                select day, sum(value) as n from public.usage_counters
                where scope = 'doc' and day > current_date - 30 group by day) d));
end $$;

-- Every account (people's own workspaces and teams) with plan and usage.
create or replace function public.admin_accounts(p_search text default null)
returns table (kind text, id uuid, name text, email text, plan text, members bigint, docs bigint, rows numeric,
               largest_doc_rows bigint, attachment_bytes numeric, actions_30d numeric, api_calls_30d numeric,
               is_admin boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_admin();
  return query
  with acc as (
    select 'user'::text as kind, p.id, coalesce(p.full_name, '') as name, p.email, p.plan, 1::bigint as members,
           exists (select 1 from public.app_admins a where a.user_id = p.id) as is_admin, p.created_at
    from public.profiles p
    where p_search is null or p.email ilike '%' || p_search || '%' or p.full_name ilike '%' || p_search || '%'
    union all
    select 'team', t.id, t.name, null, t.plan, (select count(*) from public.team_members m where m.team_id = t.id), false, t.created_at
    from public.teams t
    where p_search is null or t.name ilike '%' || p_search || '%'
  ),
  docs as (
    select a.kind, a.id as account_id, d.id as doc_id
    from acc a
    join public.workspaces w on (a.kind = 'team' and w.team_id = a.id) or (a.kind = 'user' and w.team_id is null and w.owner_id = a.id)
    join public.documents d on d.workspace_id = w.id and d.deleted_at is null
  ),
  sizes as (
    select x.kind, x.account_id, count(*) as docs, coalesce(sum(u.rows), 0) as rows, coalesce(max(u.rows), 0) as largest,
           coalesce(sum(u.attachment_bytes), 0) as bytes
    from docs x left join public.doc_usage u on u.doc_id = x.doc_id
    group by x.kind, x.account_id
  ),
  act as (
    select x.kind, x.account_id, sum(c.value) as n
    from docs x join public.usage_counters c on c.scope = 'doc' and c.scope_id = x.doc_id and c.day > current_date - 30
    group by x.kind, x.account_id
  ),
  api as (
    select c.scope_id, sum(c.value) as n from public.usage_counters c
    where c.scope = 'user' and c.metric = 'api_calls' and c.day > current_date - 30 group by c.scope_id
  )
  select a.kind, a.id, a.name, a.email, a.plan, a.members, coalesce(s.docs, 0), coalesce(s.rows, 0), coalesce(s.largest, 0),
         coalesce(s.bytes, 0), coalesce(ac.n, 0), coalesce(case when a.kind = 'user' then api.n end, 0), a.is_admin, a.created_at
  from acc a
  left join sizes s on s.kind = a.kind and s.account_id = a.id
  left join act ac on ac.kind = a.kind and ac.account_id = a.id
  left join api on a.kind = 'user' and api.scope_id = a.id
  order by coalesce(s.rows, 0) desc, a.created_at desc
  limit 2000;
end $$;

create or replace function public.admin_set_plan(p_kind text, p_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  if not exists (select 1 from public.plans where id = p_plan) then
    raise exception 'Unknown plan "%"', p_plan using errcode = '22023';
  end if;
  if p_kind = 'user' then
    update public.profiles set plan = p_plan where id = p_id;
  elsif p_kind = 'team' then
    update public.teams set plan = p_plan where id = p_id;
  else
    raise exception 'Accounts are "user" or "team"' using errcode = '22023';
  end if;
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_admin boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  if p_admin then
    if not exists (select 1 from public.profiles where id = p_user) then
      raise exception 'Person not found' using errcode = 'P0002';
    end if;
    insert into public.app_admins (user_id) values (p_user) on conflict do nothing;
  else
    if p_user = auth.uid() then
      raise exception 'You can''t remove yourself as an administrator' using errcode = '22023';
    end if;
    delete from public.app_admins where user_id = p_user;
  end if;
end $$;

-- ============================================================
-- Retention
-- ============================================================
create or replace function public._purge_platform_logs()
returns void language sql security definer set search_path = '' as $$
  delete from public.audit_log where at < now() - interval '1 year';
  delete from public.usage_counters where day < current_date - 400;
$$;
select cron.schedule('lmdu-purge-platform-logs', '41 3 * * *', 'select public._purge_platform_logs()');

-- ============================================================
-- Privileges
-- ============================================================
revoke execute on function
  public._check_doc_settings(jsonb), public.tg_doc_settings_check(), public.tg_doc_timezone_recalc(),
  public._require_admin(), public.tg_guard_plan(), public._workspace_account(uuid), public._account_docs(text, uuid),
  public._doc_plan(uuid), public.tg_limit_docs(), public.tg_doc_usage_new(), public.tg_rows_usage_add(),
  public.tg_rows_usage_remove(), public.tg_attachments_usage(), public._count_usage(text, uuid, text, bigint),
  public.tg_count_actions(), public._audit(text, uuid, uuid, uuid, text, jsonb), public._audit_once(text, uuid, jsonb),
  public.tg_audit_documents(), public.tg_audit_members(), public.tg_audit_invites(), public.tg_audit_share_links(),
  public.tg_audit_api_keys(), public.tg_audit_doc_config(), public.tg_audit_teams(), public.tg_audit_profile_plan(),
  public.tg_audit_admins(), public._account_usage(text, uuid), public._purge_platform_logs()
from public, anon, authenticated;
revoke execute on function public.set_doc_settings(uuid, jsonb) from public, anon;
grant execute on function public.set_doc_settings(uuid, jsonb) to authenticated;
revoke execute on function
  public.is_app_admin(), public.audit_events(uuid, uuid, timestamptz, timestamptz, text, text, int, bigint),
  public.my_usage(uuid), public.admin_overview(), public.admin_accounts(text), public.admin_set_plan(text, uuid, text),
  public.admin_set_admin(uuid, boolean)
from public, anon;
grant execute on function
  public.is_app_admin(), public.audit_events(uuid, uuid, timestamptz, timestamptz, text, text, int, bigint),
  public.my_usage(uuid), public.admin_overview(), public.admin_accounts(text), public.admin_set_plan(text, uuid, text),
  public.admin_set_admin(uuid, boolean)
to authenticated;
