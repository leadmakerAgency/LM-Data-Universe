-- Workspace hub (docs/workspace-hub-plan.md): every workspace has one hidden
-- document, kind 'hub', holding its Clients, Deals, Tasks and Files. The app
-- shows its pages as permanent sidebar sections (Pipeline, Planning, Files…).
-- Schema public only, additive.

alter table public.documents
  add column kind text not null default 'document' check (kind in ('document', 'hub')),
  -- The hub's sections: [{"key": "pipeline", "label": "Pipeline", "icon": "kanban", "page": "<page uuid>", "table": "<table uuid>", "hidden": false}, …]
  add column hub_config jsonb not null default '{}'::jsonb check (jsonb_typeof(hub_config) = 'object' and pg_column_size(hub_config) < 65536),
  -- An ordinary document can belong to a client of its workspace's hub (a row of the hub's Clients table).
  add column hub_client bigint;
create unique index documents_one_hub_per_workspace on public.documents (workspace_id) where kind = 'hub';
create index documents_hub_client_idx on public.documents (hub_client) where hub_client is not null;

-- Hubs are made only by ensure_hub, and stay put: no trash, no moving, no deleting on their own.
create or replace function public.tg_document_hub()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'hub' and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
      raise exception 'A workspace''s hub can''t be deleted on its own' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.kind = 'hub' and coalesce(current_setting('lmdu.making_hub', true), '') <> 'on' then
      raise exception 'Hubs are created by the app' using errcode = '42501';
    end if;
    if new.kind = 'hub' then
      new.hub_client := null;
    end if;
    return new;
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'A document''s kind can''t be changed' using errcode = '42501';
  end if;
  if old.kind = 'hub' then
    if new.deleted_at is not null then
      raise exception 'A workspace''s hub can''t be moved to the trash' using errcode = '42501';
    end if;
    if new.workspace_id is distinct from old.workspace_id then
      raise exception 'A workspace''s hub can''t be moved' using errcode = '42501';
    end if;
    new.hub_client := null;
  end if;
  return new;
end $$;
create trigger documents_hub before insert or update or delete on public.documents
  for each row execute function public.tg_document_hub();

-- The client a document belongs to must be a record of its own workspace's hub.
create or replace function public.tg_document_hub_client()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.hub_client is null or (tg_op = 'UPDATE' and new.hub_client is not distinct from old.hub_client and new.workspace_id = old.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from public.doc_rows r join public.documents h on h.id = r.doc_id
    where r.id = new.hub_client and h.kind = 'hub' and h.workspace_id = new.workspace_id
  ) then
    new.hub_client := null; -- not a client of this workspace (or moved to another one): unlink
  end if;
  return new;
end $$;
create trigger documents_hub_client before insert or update of hub_client, workspace_id on public.documents
  for each row execute function public.tg_document_hub_client();

-- Hubs don't count as documents against the plan.
create or replace function public._account_docs(p_kind text, p_account uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.documents d join public.workspaces w on w.id = d.workspace_id
  where d.deleted_at is null and d.kind = 'document'
    and ((p_kind = 'team' and w.team_id = p_account) or (p_kind = 'user' and w.team_id is null and w.owner_id = p_account))
$$;

-- The workspace's hub: {id, created}. Made the first time (by an editor or owner of the
-- workspace); "created" tells the caller to add its tables and sections.
create or replace function public.ensure_hub(p_workspace uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_ws public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into v_ws from public.workspaces where id = p_workspace for update;
  if v_ws.id is null or not (p_workspace = any (public.my_workspace_ids(1))) then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  select id into v_id from public.documents where workspace_id = p_workspace and kind = 'hub';
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', false, 'ready', (select hub_config ? 'sections' from public.documents where id = v_id));
  end if;
  if not (p_workspace = any (public.my_workspace_ids(2))) then
    raise exception 'This workspace has no hub yet; an editor has to open it first' using errcode = '42501';
  end if;
  perform set_config('lmdu.making_hub', 'on', true);
  insert into public.documents (workspace_id, name, created_by, kind)
  values (p_workspace, v_ws.name || ' hub', auth.uid(), 'hub')
  returning id into v_id;
  perform set_config('lmdu.making_hub', 'off', true);
  return jsonb_build_object('id', v_id, 'created', true, 'ready', false);
end $$;

-- Saves the hub's sections (editors and owners).
create or replace function public.set_hub_config(p_doc uuid, p_config jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.doc_role(p_doc), '') not in ('owner', 'editor') then
    raise exception 'You don''t have permission to change this workspace''s sections' using errcode = '42501';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or jsonb_typeof(coalesce(p_config->'sections', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid sections';
  end if;
  update public.documents set hub_config = p_config where id = p_doc and kind = 'hub';
  if not found then
    raise exception 'Not a hub' using errcode = 'P0002';
  end if;
end $$;

-- ============================================================
-- Personal saved views (shared views are widgets on the section's page)
-- ============================================================
create table public.user_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  doc_id uuid not null references public.documents(id) on delete cascade,
  page_id uuid not null references public.doc_pages(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  type text not null check (type in ('table', 'board', 'timeline', 'gallery', 'calendar', 'card_list')),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object' and pg_column_size(options) < 65536),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index user_views_owner_idx on public.user_views (user_id, page_id);
create index user_views_doc_idx on public.user_views (doc_id);
create index user_views_page_idx on public.user_views (page_id);
alter table public.user_views enable row level security;
create policy user_views_own on public.user_views for all to authenticated
  using (user_id = (select auth.uid()) and doc_id = any ((select public.my_doc_ids(1))::uuid[]))
  with check (user_id = (select auth.uid()) and doc_id = any ((select public.my_doc_ids(1))::uuid[])
              and exists (select 1 from public.doc_pages p where p.id = page_id and p.doc_id = user_views.doc_id));
revoke all on public.user_views from anon;

revoke execute on function public.tg_document_hub(), public.tg_document_hub_client() from public, anon, authenticated;
revoke execute on function public.ensure_hub(uuid), public.set_hub_config(uuid, jsonb) from public, anon;
grant execute on function public.ensure_hub(uuid), public.set_hub_config(uuid, jsonb) to authenticated;

comment on column public.documents.kind is 'LM Data Universe: ''hub'' is the hidden document behind a workspace''s sidebar sections (one per workspace).';
comment on table public.user_views is 'LM Data Universe: personal saved views of a hub section.';
