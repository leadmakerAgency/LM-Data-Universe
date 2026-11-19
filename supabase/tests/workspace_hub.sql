-- Tests for workspace hubs, client links on documents and personal views.
-- Reuses integrations.sql's people: Gina (f1) owns her workspace; Hugo (f2),
-- Ivy (f3) and Jo (f4) have their own.
reset role;

create or replace function pg_temp.ok(p boolean, p_msg text) returns void language plpgsql as $$
begin
  if p is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_msg;
  end if;
end $$;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '{}', false);
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

create temp table ctx (k text primary key, v text);
grant all on ctx to anon, authenticated;
insert into ctx select 'ws', id::text from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000f1' and is_personal;
-- Ivy can read Gina's workspace, Hugo can edit it.
insert into public.workspace_members (workspace_id, user_id, role)
select (select v::uuid from ctx where k = 'ws'), '00000000-0000-0000-0000-0000000000f3', 'viewer';

set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.ok(pg_temp.err($$select public.ensure_hub((select v::uuid from ctx where k = 'ws'))$$) like '42501%no hub yet%', 'a viewer can''t create the hub');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select pg_temp.ok(pg_temp.err($$select public.ensure_hub((select v::uuid from ctx where k = 'ws'))$$) like 'P0002%', 'outsiders don''t see the workspace');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
insert into ctx select 'first', public.ensure_hub((select v::uuid from ctx where k = 'ws'))::text;
select pg_temp.ok(((select v from ctx where k = 'first')::jsonb->>'created')::boolean, 'the first call creates the hub');
insert into ctx select 'hub', (select v from ctx where k = 'first')::jsonb->>'id';
select pg_temp.ok((public.ensure_hub((select v::uuid from ctx where k = 'ws'))->>'id') = (select v from ctx where k = 'hub')
  and not (public.ensure_hub((select v::uuid from ctx where k = 'ws'))->>'created')::boolean, 'later calls return the same hub');
select pg_temp.ok((select kind from public.documents where id = (select v::uuid from ctx where k = 'hub')) = 'hub', 'it is a hub');
select pg_temp.ok(public.doc_role((select v::uuid from ctx where k = 'hub')) = 'owner', 'its creator owns it');
select pg_temp.ok(pg_temp.err($$insert into public.documents (workspace_id, name, created_by, kind) values ((select v::uuid from ctx where k = 'ws'), 'Fake', '00000000-0000-0000-0000-0000000000f1', 'hub')$$) like '42501%', 'hubs can''t be inserted directly');
select pg_temp.ok(pg_temp.err($$select public.trash_document((select v::uuid from ctx where k = 'hub'))$$) like '42501%trash%', 'the hub can''t be trashed');
select pg_temp.ok(pg_temp.err($$delete from public.documents where id = (select v::uuid from ctx where k = 'hub')$$) like '42501%', 'or deleted');
select pg_temp.ok(pg_temp.err($$update public.documents set kind = 'document' where id = (select v::uuid from ctx where k = 'hub')$$) like '42501%', 'or turned into a document');
select public.set_hub_config((select v::uuid from ctx where k = 'hub'), '{"sections": [{"key": "pipeline", "label": "Pipeline"}]}');
select pg_temp.ok((select hub_config->'sections'->0->>'label' from public.documents where id = (select v::uuid from ctx where k = 'hub')) = 'Pipeline', 'sections are saved');
select pg_temp.ok((public.ensure_hub((select v::uuid from ctx where k = 'ws'))->>'ready')::boolean, 'and the hub counts as ready');
select pg_temp.ok(pg_temp.err($$select public.set_hub_config((select id from public.documents where kind = 'document' and created_by = '00000000-0000-0000-0000-0000000000f1' limit 1), '{"sections": []}')$$) like 'P0002%', 'only hubs have sections');
reset role;
select pg_temp.ok((select count(*) from public._account_docs('user', '00000000-0000-0000-0000-0000000000f1') x where x = (select v::uuid from ctx where k = 'hub')) = 0, 'hubs don''t count against the plan');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');

-- A client in the hub, and a document linked to it.
insert into ctx values ('table', gen_random_uuid()::text), ('page', gen_random_uuid()::text);
select public.apply_actions((select v::uuid from ctx where k = 'hub'), jsonb_build_array(
  jsonb_build_object('op', 'Add', 'entity', 'table', 'row', jsonb_build_object('id', (select v from ctx where k = 'table'), 'table_id', 'Clients')),
  jsonb_build_object('op', 'Add', 'entity', 'page', 'row', jsonb_build_object('id', (select v from ctx where k = 'page'), 'name', 'Clients'))));
insert into ctx select 'client', (public.apply_actions((select v::uuid from ctx where k = 'hub'), jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', (select v from ctx where k = 'table'), 'records', '[{"data": {}}]'::jsonb)))->'results'->0->>0);
insert into public.documents (workspace_id, name, created_by, hub_client)
values ((select v::uuid from ctx where k = 'ws'), 'Acme data', '00000000-0000-0000-0000-0000000000f1', (select v::bigint from ctx where k = 'client'));
select pg_temp.ok((select hub_client from public.documents where name = 'Acme data') = (select v::bigint from ctx where k = 'client'), 'a document can belong to a client');
update public.documents set hub_client = 999999 where name = 'Acme data';
select pg_temp.ok((select hub_client from public.documents where name = 'Acme data') is null, 'but only to a client of its own workspace');

-- Personal views
insert into public.user_views (doc_id, page_id, name, type, options)
values ((select v::uuid from ctx where k = 'hub'), (select v::uuid from ctx where k = 'page'), 'Mine', 'board', '{"boardCol": null}');
select pg_temp.ok((select count(*) from public.user_views) = 1, 'people save their own views');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.ok((select count(*) from public.user_views) = 0, 'others don''t see them');
select pg_temp.ok(pg_temp.err($$insert into public.user_views (user_id, doc_id, page_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', (select v::uuid from ctx where k = 'hub'), (select v::uuid from ctx where k = 'page'), 'x', 'table')$$) like '42501%', 'or save views as someone else');
insert into public.user_views (doc_id, page_id, name, type)
values ((select v::uuid from ctx where k = 'hub'), (select v::uuid from ctx where k = 'page'), 'Ivy''s', 'table');
select pg_temp.ok((select count(*) from public.user_views) = 1, 'viewers can keep personal views of what they can read');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select pg_temp.ok(pg_temp.err($$insert into public.user_views (doc_id, page_id, name, type) values ((select v::uuid from ctx where k = 'hub'), (select v::uuid from ctx where k = 'page'), 'x', 'table')$$) like '42501%', 'outsiders can''t attach views to the hub');
reset role;

-- Deleting the workspace takes its hub with it.
delete from public.user_views;
delete from public.documents where name = 'Acme data';
delete from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000f3' and workspace_id = (select v::uuid from ctx where k = 'ws');
select pg_temp.ok(pg_temp.err($$delete from public.workspaces where id = (select v::uuid from ctx where k = 'ws')$$) = '', 'a workspace with a hub can still be deleted');
select pg_temp.ok(not exists (select 1 from public.documents where id = (select v::uuid from ctx where k = 'hub')), 'and its hub goes with it');

select 'hub: all checks passed' as out;
