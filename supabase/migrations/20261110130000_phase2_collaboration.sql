-- Phase 2: collaboration, sharing and history.
--
--   * Team sites: teams own workspaces; team roles flow down to their
--     workspaces and documents.
--   * Invites before sign-up: sharing with an unknown email stores a pending
--     invite, turned into membership once that email is confirmed.
--   * Public links: a token (sent by the app as the `x-share-token` header)
--     grants view or edit access, optionally without signing in.
--   * Trash: documents are soft-deleted and purged after 30 days.
--   * Cell comments with @mentions.
--   * Snapshots (automatic and manual), restore, copies, forks and
--     "replace the original with this copy".
--   * An email queue for invites and mentions (sent by the `notify` function).
--
-- Every access decision still goes through my_doc_ids / my_workspace_ids /
-- doc_role, which this migration extends.

create extension if not exists pg_cron;

-- ============================================================
-- Teams
-- ============================================================
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

-- Deleting a team keeps its workspaces (their own members keep access).
alter table public.workspaces add column team_id uuid references public.teams(id) on delete set null;
create index workspaces_team_idx on public.workspaces (team_id);
alter table public.workspaces add constraint workspaces_personal_not_team check (not (is_personal and team_id is not null));

create or replace function public.tg_team_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is not null then
    insert into public.team_members (team_id, user_id, role) values (new.id, new.created_by, 'owner')
    on conflict do nothing;
  end if;
  return null;
end $$;
create trigger teams_owner after insert on public.teams
  for each row execute function public.tg_team_owner();

create or replace function public.my_team_ids(p_min int)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tm.team_id), '{}')
  from public.team_members tm
  where tm.user_id = auth.uid() and public.role_rank(tm.role) >= p_min
$$;

-- ============================================================
-- Public share links
-- ============================================================
create table public.doc_share_links (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  role text not null check (role in ('viewer', 'editor')),
  allow_anonymous boolean not null default true,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index doc_share_links_doc_idx on public.doc_share_links (doc_id);

-- The document and rank granted by the share token in this request, if any.
create or replace function public.share_link_access(out doc_id uuid, out rank int)
language sql stable security definer set search_path = '' as $$
  select l.doc_id, public.role_rank(l.role)
  from public.doc_share_links l
  where l.token = nullif((nullif(current_setting('request.headers', true), '')::json ->> 'x-share-token'), '')
    and l.revoked_at is null
    and (l.expires_at is null or l.expires_at > now())
    and (l.allow_anonymous or auth.uid() is not null)
  limit 1
$$;

-- ============================================================
-- Access helpers, now with teams and share links
-- ============================================================
create or replace function public.my_workspace_ids(p_min int)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s.id), '{}')
  from (
    select wm.workspace_id as id, public.role_rank(wm.role) as r
    from public.workspace_members wm where wm.user_id = auth.uid()
    union all
    select w.id, public.role_rank(tm.role)
    from public.workspaces w join public.team_members tm on tm.team_id = w.team_id
    where tm.user_id = auth.uid()
  ) s
  where s.r >= p_min
$$;

create or replace function public.my_doc_ids(p_min int)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s.doc_id), '{}')
  from (
    select dm.doc_id, public.role_rank(dm.role) as r
    from public.document_members dm
    where dm.user_id = auth.uid()
    union all
    select d.id, public.role_rank(wm.role)
    from public.documents d
    join public.workspace_members wm on wm.workspace_id = d.workspace_id
    where wm.user_id = auth.uid()
    union all
    select d.id, public.role_rank(tm.role)
    from public.documents d
    join public.workspaces w on w.id = d.workspace_id
    join public.team_members tm on tm.team_id = w.team_id
    where tm.user_id = auth.uid()
    union all
    select l.doc_id, l.rank from public.share_link_access() l where l.doc_id is not null
  ) s
  where s.r >= p_min
$$;

create or replace function public.doc_role(p_doc uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case max(s.r) when 3 then 'owner' when 2 then 'editor' when 1 then 'viewer' end
  from (
    select public.role_rank(dm.role) as r
    from public.document_members dm
    where dm.doc_id = p_doc and dm.user_id = auth.uid()
    union all
    select public.role_rank(wm.role)
    from public.documents d
    join public.workspace_members wm on wm.workspace_id = d.workspace_id
    where d.id = p_doc and wm.user_id = auth.uid()
    union all
    select public.role_rank(tm.role)
    from public.documents d
    join public.workspaces w on w.id = d.workspace_id
    join public.team_members tm on tm.team_id = w.team_id
    where d.id = p_doc and tm.user_id = auth.uid()
    union all
    select l.rank from public.share_link_access() l where l.doc_id = p_doc
  ) s
$$;

create or replace function public.can_see_profile(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user = auth.uid()
    or exists (
      select 1 from public.workspace_members a
      join public.workspace_members b on b.workspace_id = a.workspace_id
      where a.user_id = auth.uid() and b.user_id = p_user
    )
    or exists (
      select 1 from public.team_members a
      join public.team_members b on b.team_id = a.team_id
      where a.user_id = auth.uid() and b.user_id = p_user
    )
    or exists (
      select 1 from public.document_members b
      where b.user_id = p_user and b.doc_id = any (public.my_doc_ids(1))
    )
$$;

grant execute on function public.my_doc_ids(int), public.doc_role(uuid), public.role_rank(text),
  public.share_link_access(), public.my_team_ids(int), public.my_workspace_ids(int) to anon, authenticated;

-- Team policies
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
create policy teams_select on public.teams for select to authenticated
  using (id = any ((select public.my_team_ids(1))::uuid[]));
create policy teams_insert on public.teams for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy teams_update on public.teams for update to authenticated
  using (id = any ((select public.my_team_ids(3))::uuid[]))
  with check (id = any ((select public.my_team_ids(3))::uuid[]));
create policy teams_delete on public.teams for delete to authenticated
  using (id = any ((select public.my_team_ids(3))::uuid[]));
create policy team_members_select on public.team_members for select to authenticated
  using (team_id = any ((select public.my_team_ids(1))::uuid[]));
revoke insert, update, delete on public.team_members from anon, authenticated;

-- Workspaces may belong to a team the creator can edit.
drop policy workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()) and not is_personal
              and (team_id is null or team_id = any ((select public.my_team_ids(2))::uuid[])));
drop policy workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update to authenticated
  using (id = any ((select public.my_workspace_ids(3))::uuid[]))
  with check (id = any ((select public.my_workspace_ids(3))::uuid[])
              and (team_id is null or team_id = any ((select public.my_team_ids(2))::uuid[])));

-- Share-link policies (owners manage links) and read access for link visitors
-- who are not signed in.
alter table public.doc_share_links enable row level security;
create policy doc_share_links_select on public.doc_share_links for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(3))::uuid[]));
create policy doc_share_links_insert on public.doc_share_links for insert to authenticated
  with check (doc_id = any ((select public.my_doc_ids(3))::uuid[]) and created_by = (select auth.uid()));
create policy doc_share_links_update on public.doc_share_links for update to authenticated
  using (doc_id = any ((select public.my_doc_ids(3))::uuid[]))
  with check (doc_id = any ((select public.my_doc_ids(3))::uuid[]));
create policy doc_share_links_delete on public.doc_share_links for delete to authenticated
  using (doc_id = any ((select public.my_doc_ids(3))::uuid[]));
revoke all on public.doc_share_links from anon;

do $$
declare
  t text;
begin
  foreach t in array array['doc_tables', 'doc_columns', 'doc_rows', 'doc_pages', 'doc_widgets', 'doc_attachments'] loop
    execute format('create policy %1$s_select_anon on public.%1$s for select to anon using (doc_id = any ((select public.my_doc_ids(1))::uuid[]))', t);
  end loop;
end $$;
create policy documents_select_anon on public.documents for select to anon
  using (id = any ((select public.my_doc_ids(1))::uuid[]));
create policy "Attachments readable by link visitors" on storage.objects for select to anon
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(1))::text[]));
-- Link editors who are not signed in edit through apply_actions like everyone else.
grant execute on function public.apply_actions(uuid, jsonb, boolean, text), public.undo_state(uuid) to anon;
revoke insert, update, delete on public.documents, public.doc_attachments, public.form_shares,
  public.document_members, public.workspace_members, public.workspaces, public.profiles from anon;

-- ============================================================
-- Pending invites (sharing with people who haven't signed up yet)
-- ============================================================
create table public.pending_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  doc_id uuid references public.documents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (num_nonnulls(doc_id, workspace_id, team_id) = 1)
);
create unique index pending_invites_target_idx on public.pending_invites
  (email, coalesce(doc_id, workspace_id, team_id));

alter table public.pending_invites enable row level security;
create policy pending_invites_select on public.pending_invites for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(3))::uuid[])
      or workspace_id = any ((select public.my_workspace_ids(3))::uuid[])
      or team_id = any ((select public.my_team_ids(3))::uuid[]));
create policy pending_invites_delete on public.pending_invites for delete to authenticated
  using (doc_id = any ((select public.my_doc_ids(3))::uuid[])
      or workspace_id = any ((select public.my_workspace_ids(3))::uuid[])
      or team_id = any ((select public.my_team_ids(3))::uuid[]));
revoke insert, update on public.pending_invites from anon, authenticated;

-- ============================================================
-- Email queue (sent by the `notify` Edge Function; no client access)
-- ============================================================
create table public.notification_queue (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('invite', 'shared', 'mention')),
  to_email text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index notification_queue_pending_idx on public.notification_queue (id) where sent_at is null;
alter table public.notification_queue enable row level security;
revoke all on public.notification_queue from anon, authenticated;

create or replace function public._queue_email(p_kind text, p_email text, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notification_queue (kind, to_email, payload) values (p_kind, lower(btrim(p_email)), p_payload)
$$;

create or replace function public._my_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.full_name, ''), p.email, 'Someone') from public.profiles p where p.id = auth.uid()
$$;

-- ============================================================
-- Sharing RPCs: unknown emails become pending invites
-- ============================================================
create or replace function public.share_document(p_doc uuid, p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_email text := lower(btrim(p_email));
  v_name text;
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can share this document' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Invalid role %', p_role;
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  select name into v_name from public.documents where id = p_doc;
  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is null then
    insert into public.pending_invites (email, doc_id, role) values (v_email, p_doc, p_role)
    on conflict (email, coalesce(doc_id, workspace_id, team_id)) do update set role = excluded.role;
    perform public._queue_email('invite', v_email, jsonb_build_object('target', 'document', 'id', p_doc, 'name', v_name, 'role', p_role, 'by', public._my_name()));
    return null;
  end if;
  insert into public.document_members (doc_id, user_id, role) values (p_doc, v_user, p_role)
  on conflict (doc_id, user_id) do update set role = excluded.role;
  if v_user <> auth.uid() then
    perform public._queue_email('shared', v_email, jsonb_build_object('target', 'document', 'id', p_doc, 'name', v_name, 'role', p_role, 'by', public._my_name()));
  end if;
  return v_user;
end $$;

create or replace function public.share_workspace(p_workspace uuid, p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_email text := lower(btrim(p_email));
  v_name text;
begin
  if not (p_workspace = any (public.my_workspace_ids(3))) then
    raise exception 'Only owners can share this workspace' using errcode = '42501';
  end if;
  if exists (select 1 from public.workspaces where id = p_workspace and is_personal) then
    raise exception 'Personal workspaces cannot be shared; share individual documents instead';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Invalid role %', p_role;
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  select name into v_name from public.workspaces where id = p_workspace;
  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is null then
    insert into public.pending_invites (email, workspace_id, role) values (v_email, p_workspace, p_role)
    on conflict (email, coalesce(doc_id, workspace_id, team_id)) do update set role = excluded.role;
    perform public._queue_email('invite', v_email, jsonb_build_object('target', 'workspace', 'id', p_workspace, 'name', v_name, 'role', p_role, 'by', public._my_name()));
    return null;
  end if;
  insert into public.workspace_members (workspace_id, user_id, role) values (p_workspace, v_user, p_role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;
  if v_user <> auth.uid() then
    perform public._queue_email('shared', v_email, jsonb_build_object('target', 'workspace', 'id', p_workspace, 'name', v_name, 'role', p_role, 'by', public._my_name()));
  end if;
  return v_user;
end $$;

create or replace function public.share_team(p_team uuid, p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_email text := lower(btrim(p_email));
  v_name text;
begin
  if not (p_team = any (public.my_team_ids(3))) then
    raise exception 'Only team owners can add members' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Invalid role %', p_role;
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  select name into v_name from public.teams where id = p_team;
  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is null then
    insert into public.pending_invites (email, team_id, role) values (v_email, p_team, p_role)
    on conflict (email, coalesce(doc_id, workspace_id, team_id)) do update set role = excluded.role;
    perform public._queue_email('invite', v_email, jsonb_build_object('target', 'team', 'id', p_team, 'name', v_name, 'role', p_role, 'by', public._my_name()));
    return null;
  end if;
  insert into public.team_members (team_id, user_id, role) values (p_team, v_user, p_role)
  on conflict (team_id, user_id) do update set role = excluded.role;
  if v_user <> auth.uid() then
    perform public._queue_email('shared', v_email, jsonb_build_object('target', 'team', 'id', p_team, 'name', v_name, 'role', p_role, 'by', public._my_name()));
  end if;
  return v_user;
end $$;

create or replace function public.remove_team_member(p_team uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (p_team = any (public.my_team_ids(3))) and p_user is distinct from auth.uid() then
    raise exception 'Only team owners can remove members' using errcode = '42501';
  end if;
  if (select count(*) from public.team_members where team_id = p_team and role = 'owner' and user_id <> p_user) = 0
     and exists (select 1 from public.team_members where team_id = p_team and user_id = p_user and role = 'owner') then
    raise exception 'A team needs at least one owner';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
end $$;

-- Turn a confirmed user's pending invites into memberships.
create or replace function public._accept_invites(p_user uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email = '' then return; end if;
  insert into public.document_members (doc_id, user_id, role)
  select doc_id, p_user, role from public.pending_invites where email = v_email and doc_id is not null
  on conflict (doc_id, user_id) do nothing;
  insert into public.workspace_members (workspace_id, user_id, role)
  select workspace_id, p_user, role from public.pending_invites where email = v_email and workspace_id is not null
  on conflict (workspace_id, user_id) do nothing;
  insert into public.team_members (team_id, user_id, role)
  select team_id, p_user, role from public.pending_invites where email = v_email and team_id is not null
  on conflict (team_id, user_id) do nothing;
  delete from public.pending_invites where email = v_email;
end $$;

-- New users: profile, personal workspace, and invites if the email is already confirmed.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), nullif(new.raw_user_meta_data->>'full_name', ''));
  insert into public.workspaces (name, owner_id, is_personal)
  values ('Home', new.id, true);
  if new.email_confirmed_at is not null then
    perform public._accept_invites(new.id, new.email);
  end if;
  return new;
end $$;

-- Invites are accepted only once the address is confirmed, so nobody can claim
-- someone else's invite by signing up with their email.
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    perform public._accept_invites(new.id, new.email);
  end if;
  return new;
end $$;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- ============================================================
-- Trash
-- ============================================================
alter table public.documents add column deleted_at timestamptz;
alter table public.documents add column deleted_by uuid references public.profiles(id) on delete set null;
alter table public.documents add column forked_from uuid references public.documents(id) on delete set null;
create index documents_deleted_idx on public.documents (deleted_at) where deleted_at is not null;

create or replace function public.trash_document(p_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can delete this document' using errcode = '42501';
  end if;
  update public.documents set deleted_at = now(), deleted_by = auth.uid() where id = p_doc and deleted_at is null;
end $$;

create or replace function public.restore_document(p_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can restore this document' using errcode = '42501';
  end if;
  update public.documents set deleted_at = null, deleted_by = null where id = p_doc;
end $$;

create or replace function public.delete_document_forever(p_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is distinct from 'owner' then
    raise exception 'Only owners can delete this document' using errcode = '42501';
  end if;
  if not exists (select 1 from public.documents where id = p_doc and deleted_at is not null) then
    raise exception 'Move the document to the trash first';
  end if;
  delete from public.documents where id = p_doc;
end $$;

-- Documents in the trash can be read and restored, not edited.
create or replace function public._require_editor(p_doc uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.doc_role(p_doc), '') not in ('owner', 'editor') then
    raise exception 'You don''t have permission to edit this document' using errcode = '42501';
  end if;
  if exists (select 1 from public.documents where id = p_doc and deleted_at is not null) then
    raise exception 'This document is in the trash. Restore it to edit.' using errcode = '42501';
  end if;
end $$;

-- ============================================================
-- Cell comments
-- ============================================================
create table public.doc_comments (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  table_ref uuid references public.doc_tables(id) on delete cascade,
  row_id bigint,
  col_id uuid references public.doc_columns(id) on delete cascade,
  parent_id uuid references public.doc_comments(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 10000),
  mentions uuid[] not null default '{}',
  resolved boolean not null default false,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  author uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_comments_doc_idx on public.doc_comments (doc_id, created_at);
create index doc_comments_cell_idx on public.doc_comments (table_ref, row_id, col_id);

create or replace function public.tg_comment_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  p public.doc_comments;
begin
  if tg_op = 'INSERT' then
    if new.parent_id is not null then
      -- Replies live on their thread's cell.
      select * into p from public.doc_comments where id = new.parent_id;
      if p.id is null or p.parent_id is not null then
        raise exception 'Replies must answer a top-level comment';
      end if;
      new.doc_id := p.doc_id;
      new.table_ref := p.table_ref;
      new.row_id := p.row_id;
      new.col_id := p.col_id;
    end if;
    if new.table_ref is not null and not exists (select 1 from public.doc_tables t where t.id = new.table_ref and t.doc_id = new.doc_id) then
      raise exception 'Table belongs to another document';
    end if;
    if new.col_id is not null and not exists (select 1 from public.doc_columns c where c.id = new.col_id and c.table_ref = new.table_ref) then
      raise exception 'Column belongs to another table';
    end if;
    new.resolved := false;
    new.resolved_by := null;
    new.resolved_at := null;
    new.created_at := now();
  else
    new.id := old.id;
    new.doc_id := old.doc_id;
    new.table_ref := old.table_ref;
    new.row_id := old.row_id;
    new.col_id := old.col_id;
    new.parent_id := old.parent_id;
    new.author := old.author;
    new.created_at := old.created_at;
    -- Only the author edits the text; others (editors) may only resolve.
    if auth.uid() is distinct from old.author then
      new.body := old.body;
      new.mentions := old.mentions;
    end if;
    if new.resolved is distinct from old.resolved then
      new.resolved_by := case when new.resolved then auth.uid() end;
      new.resolved_at := case when new.resolved then now() end;
    else
      new.resolved_by := old.resolved_by;
      new.resolved_at := old.resolved_at;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger doc_comments_integrity before insert or update on public.doc_comments
  for each row execute function public.tg_comment_integrity();

-- @mentions: email each mentioned person who can read the document.
create or replace function public.tg_comment_mentions()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_email text;
  v_doc text;
  v_new uuid[] := coalesce(new.mentions, '{}');
  v_old uuid[] := case when tg_op = 'UPDATE' then coalesce(old.mentions, '{}') else '{}' end;
begin
  select name into v_doc from public.documents where id = new.doc_id;
  foreach v_user in array v_new loop
    continue when v_user = any (v_old) or v_user = new.author;
    select p.email into v_email from public.profiles p where p.id = v_user;
    continue when v_email is null;
    -- Only people with access to the document.
    continue when not exists (
      select 1 from public.document_members dm where dm.doc_id = new.doc_id and dm.user_id = v_user
      union all
      select 1 from public.documents d join public.workspace_members wm on wm.workspace_id = d.workspace_id
      where d.id = new.doc_id and wm.user_id = v_user
      union all
      select 1 from public.documents d join public.workspaces w on w.id = d.workspace_id
      join public.team_members tm on tm.team_id = w.team_id where d.id = new.doc_id and tm.user_id = v_user
    );
    perform public._queue_email('mention', v_email, jsonb_build_object(
      'doc_id', new.doc_id, 'doc', v_doc, 'comment_id', coalesce(new.parent_id, new.id),
      'by', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = new.author),
      'body', left(new.body, 500)));
  end loop;
  return null;
end $$;
create trigger doc_comments_mentions after insert or update of mentions on public.doc_comments
  for each row execute function public.tg_comment_mentions();

alter table public.doc_comments enable row level security;
create policy doc_comments_select on public.doc_comments for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[]));
create policy doc_comments_insert on public.doc_comments for insert to authenticated
  with check (doc_id = any ((select public.my_doc_ids(1))::uuid[]) and author = (select auth.uid()));
create policy doc_comments_update on public.doc_comments for update to authenticated
  using (author = (select auth.uid()) or doc_id = any ((select public.my_doc_ids(2))::uuid[]))
  with check (author = (select auth.uid()) or doc_id = any ((select public.my_doc_ids(2))::uuid[]));
create policy doc_comments_delete on public.doc_comments for delete to authenticated
  using (author = (select auth.uid()) or doc_id = any ((select public.my_doc_ids(3))::uuid[]));
revoke all on public.doc_comments from anon;

alter table public.doc_comments replica identity full;
alter publication supabase_realtime add table public.doc_comments;

-- ============================================================
-- Snapshots, restore, copies and forks
-- ============================================================
create table public.doc_snapshots (
  id bigint generated always as identity primary key,
  doc_id uuid not null references public.documents(id) on delete cascade,
  kind text not null check (kind in ('auto', 'manual', 'before-restore', 'before-replace')),
  label text check (label is null or length(label) <= 200),
  last_action_id bigint,
  content jsonb not null,
  size_bytes int not null default 0,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index doc_snapshots_doc_idx on public.doc_snapshots (doc_id, created_at desc);

alter table public.doc_snapshots enable row level security;
-- Editors and owners see the history; content is read through get_snapshot.
create policy doc_snapshots_select on public.doc_snapshots for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(2))::uuid[]));
-- Listing shows metadata only; the content column is read through get_snapshot.
revoke all on public.doc_snapshots from anon, authenticated;
grant select (id, doc_id, kind, label, last_action_id, size_bytes, created_by, created_at) on public.doc_snapshots to authenticated;

-- Everything a document contains, as JSON (no computed values: they're recomputed).
create or replace function public._doc_content(p_doc uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tables', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'table_id', t.table_id, 'position', t.position) order by t.position)
                        from public.doc_tables t where t.doc_id = p_doc), '[]'),
    'columns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'table_ref', c.table_ref, 'col_id', c.col_id, 'label', c.label,
                          'type', c.type, 'is_formula', c.is_formula, 'formula', c.formula, 'options', c.options, 'position', c.position) order by c.position)
                         from public.doc_columns c where c.doc_id = p_doc), '[]'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'table_ref', r.table_ref, 'manual_sort', r.manual_sort, 'data', r.data,
                       'created_by', r.created_by) order by r.id)
                      from public.doc_rows r where r.doc_id = p_doc), '[]'),
    'pages', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'position', p.position, 'layout', p.layout) order by p.position)
                       from public.doc_pages p where p.doc_id = p_doc), '[]'),
    'widgets', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'page_id', w.page_id, 'table_ref', w.table_ref, 'type', w.type,
                          'title', w.title, 'position', w.position, 'width', w.width, 'height', w.height, 'options', w.options,
                          'link_source', w.link_source, 'link_col', w.link_col) order by w.position)
                         from public.doc_widgets w where w.doc_id = p_doc), '[]')
  )
$$;

create or replace function public._last_action(p_doc uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select max(id) from public.doc_actions where doc_id = p_doc
$$;

create or replace function public._take_snapshot(p_doc uuid, p_kind text, p_label text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_content jsonb := public._doc_content(p_doc);
  v_id bigint;
begin
  insert into public.doc_snapshots (doc_id, kind, label, last_action_id, content, size_bytes)
  values (p_doc, p_kind, p_label, public._last_action(p_doc), v_content, pg_column_size(v_content))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.take_snapshot(p_doc uuid, p_label text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_editor(p_doc);
  return public._take_snapshot(p_doc, 'manual', nullif(btrim(coalesce(p_label, '')), ''));
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
  return jsonb_build_object('id', s.id, 'doc_id', s.doc_id, 'kind', s.kind, 'label', s.label, 'created_at', s.created_at, 'content', s.content);
end $$;

-- Current content of a document the caller can read (used to compare versions).
create or replace function public.doc_content(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.doc_role(p_doc) is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  return public._doc_content(p_doc);
end $$;

-- Removes a document's content (tables cascade to columns and rows).
create or replace function public._clear_content(p_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.doc_widgets where doc_id = p_doc;
  delete from public.doc_pages where doc_id = p_doc;
  delete from public.doc_tables where doc_id = p_doc;
end $$;

-- Writes snapshot content back into its own document, keeping every id.
create or replace function public._load_content(p_doc uuid, p_content jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.doc_tables (id, doc_id, table_id, position)
  select (t->>'id')::uuid, p_doc, t->>'table_id', (t->>'position')::double precision
  from jsonb_array_elements(p_content->'tables') t;
  insert into public.doc_columns (id, doc_id, table_ref, col_id, label, type, is_formula, formula, options, position)
  select (c->>'id')::uuid, p_doc, (c->>'table_ref')::uuid, c->>'col_id', c->>'label', c->>'type', (c->>'is_formula')::boolean,
         coalesce(c->>'formula', ''), coalesce(c->'options', '{}'), (c->>'position')::double precision
  from jsonb_array_elements(p_content->'columns') c;
  insert into public.doc_rows (id, doc_id, table_ref, manual_sort, data, created_by)
  select (r->>'id')::bigint, p_doc, (r->>'table_ref')::uuid, (r->>'manual_sort')::double precision, coalesce(r->'data', '{}'),
         nullif(r->>'created_by', '')::uuid
  from jsonb_array_elements(p_content->'rows') r;
  insert into public.doc_pages (id, doc_id, name, position, layout)
  select (p->>'id')::uuid, p_doc, p->>'name', (p->>'position')::double precision, coalesce(p->'layout', '{}')
  from jsonb_array_elements(p_content->'pages') p;
  -- Widgets first without links (a link may point at a widget not inserted yet).
  insert into public.doc_widgets (id, doc_id, page_id, table_ref, type, title, position, width, height, options)
  select (w->>'id')::uuid, p_doc, (w->>'page_id')::uuid, nullif(w->>'table_ref', '')::uuid, w->>'type', coalesce(w->>'title', ''),
         (w->>'position')::double precision, (w->>'width')::int, (w->>'height')::int, coalesce(w->'options', '{}')
  from jsonb_array_elements(p_content->'widgets') w;
  update public.doc_widgets d set link_source = nullif(w->>'link_source', '')::uuid, link_col = nullif(w->>'link_col', '')::uuid
  from jsonb_array_elements(p_content->'widgets') w
  where d.id = (w->>'id')::uuid and (w->>'link_source' is not null or w->>'link_col' is not null);
end $$;

-- After replacing content: old undo steps no longer apply, and every formula
-- must be recomputed (the unknown op makes the worker recompute everything).
create or replace function public._after_replace(p_doc uuid, p_what jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.doc_actions set undoable = false where doc_id = p_doc and undoable;
  insert into public.doc_actions (doc_id, author, kind, undoable, source, actions, inverse)
  values (p_doc, auth.uid(), 'do', false, 'system', jsonb_build_array(p_what), '[]'::jsonb);
end $$;

create or replace function public.restore_snapshot(p_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s public.doc_snapshots;
  v_backup bigint;
  v_shares jsonb;
begin
  select * into s from public.doc_snapshots where id = p_id;
  if s.id is null or public.doc_role(s.doc_id) is distinct from 'owner' then
    raise exception 'Only owners can restore a snapshot' using errcode = '42501';
  end if;
  perform public._require_editor(s.doc_id);
  perform 1 from public.documents where id = s.doc_id for update;
  v_backup := public._take_snapshot(s.doc_id, 'before-restore', 'Before restoring ' || to_char(s.created_at, 'YYYY-MM-DD HH24:MI'));
  -- Form links survive when their widget comes back.
  select coalesce(jsonb_agg(to_jsonb(f)), '[]') into v_shares from public.form_shares f where f.doc_id = s.doc_id;
  perform public._clear_content(s.doc_id);
  perform public._load_content(s.doc_id, s.content);
  insert into public.form_shares (id, token, doc_id, widget_id, is_active)
  select (f->>'id')::uuid, f->>'token', s.doc_id, (f->>'widget_id')::uuid, (f->>'is_active')::boolean
  from jsonb_array_elements(v_shares) f
  where exists (select 1 from public.doc_widgets w where w.id = (f->>'widget_id')::uuid and w.type = 'form')
  on conflict do nothing;
  perform public._after_replace(s.doc_id, jsonb_build_object('op', 'Restore', 'snapshot', s.id, 'backup', v_backup));
  return v_backup;
end $$;

-- Replaces every uuid in a JSON value using a map {old: new}. UUIDs are random,
-- so a plain text replacement can't hit anything else.
create or replace function public._remap(p_value jsonb, p_map jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_text text := p_value::text;
  k text;
  v text;
begin
  if p_value is null then return null; end if;
  for k, v in select * from jsonb_each_text(p_map) loop
    if position(k in v_text) > 0 then
      v_text := replace(v_text, k, v);
    end if;
  end loop;
  return v_text::jsonb;
end $$;

-- Copies a document's structure (and optionally its data) into another
-- document with fresh ids. Attachment cells are left empty: files belong to
-- the source document.
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
end $$;

-- Save a copy (optionally structure only, e.g. as a template), or start
-- "working on a copy" (a fork that can later replace the original).
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

-- Replace a document with a copy made from it ("work on a copy").
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
  perform 1 from public.documents where id = v_orig for update;
  v_backup := public._take_snapshot(v_orig, 'before-replace', 'Before replacing with a copy');
  perform public._clear_content(v_orig);
  perform public._copy_content(p_copy, v_orig, true);
  perform public._after_replace(v_orig, jsonb_build_object('op', 'Replace', 'from', p_copy, 'backup', v_backup));
  return v_backup;
end $$;

-- ============================================================
-- Automatic snapshots and clean-up (pg_cron)
-- ============================================================
-- Hourly: snapshot documents changed since their last snapshot. Then thin out:
-- everything from the last day, one per day for 30 days, one per week for six
-- months. Manual snapshots are kept until the document is deleted.
create or replace function public._auto_snapshots()
returns void language plpgsql security definer set search_path = '' as $$
declare
  d record;
begin
  for d in
    select doc.id from public.documents doc
    where doc.deleted_at is null
      and exists (select 1 from public.doc_actions a where a.doc_id = doc.id
                  and a.id > coalesce((select max(s.last_action_id) from public.doc_snapshots s where s.doc_id = doc.id), 0))
  loop
    perform public._take_snapshot(d.id, 'auto', null);
  end loop;

  delete from public.doc_snapshots s
  using (
    select id,
      row_number() over (partition by doc_id, date_trunc('day', created_at) order by created_at desc) as nday,
      row_number() over (partition by doc_id, date_trunc('week', created_at) order by created_at desc) as nweek,
      created_at
    from public.doc_snapshots where kind in ('auto', 'before-restore', 'before-replace')
  ) k
  where s.id = k.id and (
    k.created_at < now() - interval '180 days'
    or (k.created_at < now() - interval '30 days' and k.nweek > 1)
    or (k.created_at < now() - interval '1 day' and k.nday > 1)
  );
end $$;

create or replace function public._purge_trash()
returns void language sql security definer set search_path = '' as $$
  delete from public.documents where deleted_at < now() - interval '30 days'
$$;

revoke execute on function
  public._auto_snapshots(), public._purge_trash(), public._take_snapshot(uuid, text, text), public._doc_content(uuid),
  public._clear_content(uuid), public._load_content(uuid, jsonb), public._after_replace(uuid, jsonb), public._remap(jsonb, jsonb),
  public._copy_content(uuid, uuid, boolean), public._accept_invites(uuid, text), public._queue_email(text, text, jsonb),
  public._my_name(), public._last_action(uuid), public.handle_user_confirmed(), public.tg_comment_integrity(),
  public.tg_comment_mentions(), public.tg_team_owner()
from public, anon, authenticated;
revoke execute on function
  public.share_document(uuid, text, text), public.share_workspace(uuid, text, text), public.share_team(uuid, text, text),
  public.remove_team_member(uuid, uuid), public.trash_document(uuid), public.restore_document(uuid),
  public.delete_document_forever(uuid), public.take_snapshot(uuid, text), public.get_snapshot(bigint),
  public.doc_content(uuid), public.restore_snapshot(bigint), public.copy_document(uuid, uuid, text, boolean, boolean),
  public.replace_with_copy(uuid)
from public, anon;
grant execute on function
  public.share_document(uuid, text, text), public.share_workspace(uuid, text, text), public.share_team(uuid, text, text),
  public.remove_team_member(uuid, uuid), public.trash_document(uuid), public.restore_document(uuid),
  public.delete_document_forever(uuid), public.take_snapshot(uuid, text), public.get_snapshot(bigint),
  public.doc_content(uuid), public.restore_snapshot(bigint), public.copy_document(uuid, uuid, text, boolean, boolean),
  public.replace_with_copy(uuid)
to authenticated;
-- Signed-out link visitors may read the current content (for "compare") but nothing else here.
grant execute on function public.doc_content(uuid) to anon;

select cron.schedule('lmdu-auto-snapshots', '7 * * * *', 'select public._auto_snapshots()');
select cron.schedule('lmdu-purge-trash', '23 3 * * *', 'select public._purge_trash()');
