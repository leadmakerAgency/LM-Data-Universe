-- Tests for backup files and restoring them (Phase 5). Runs after forms.sql (alphabetical order) and uses its
-- "Forms" document (owner Erin, viewer Frank), which has a reference
-- column, an attachments column, form widgets and access rules by now.
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
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- Give one event a reference and a file so both are exercised.
update public.doc_rows set data = data || '{"c0000000-0000-0000-0000-000000000057": 61, "c0000000-0000-0000-0000-000000000058": ["f0000000-0000-0000-0000-000000000001"]}'
where id = (select min(id) from public.doc_rows where table_ref = 'a0000000-0000-0000-0000-000000000005');

set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok(pg_temp.err($$select public.doc_backup('d0000000-0000-0000-0000-000000000005')$$) like '42501%', 'with access rules, only owners download backups');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
create temp table bk as select public.doc_backup('d0000000-0000-0000-0000-000000000005') as j;
grant select on bk to authenticated;
select pg_temp.ok((select j->>'format' from bk) = 'lmdu-backup' and (select (j->>'version')::int from bk) = 1, 'backup format');
select pg_temp.ok((select jsonb_array_length(j->'access'->'rules') from bk) = 2, 'owners'' backups carry the access rules');

-- Bad files are refused before anything is created.
select pg_temp.ok(pg_temp.err($$select public.restore_backup((select id from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000e1'), 'x', '{"format": "nope"}')$$) like '22023%', 'only backup files are accepted');
select pg_temp.ok(pg_temp.err($$select public.restore_backup((select id from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000e1'), 'x', '{"format": "lmdu-backup", "version": 1, "content": {"tables": [{"id": "not-a-uuid"}]}}')$$) like '22023%', 'damaged files are refused');
select pg_temp.ok(pg_temp.err(format($$select public.restore_backup((select id from public.workspaces where owner_id = '00000000-0000-0000-0000-00000000000a'), 'x', %L)$$, (select j from bk))) like '42501%', 'only into your own workspaces');

create temp table restored as select public.restore_backup((select id from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000e1'), 'Forms (restored)', (select j from bk)) as id;
reset role;
select pg_temp.ok((select name from public.documents where id = (select id from restored)) = 'Forms (restored)', 'a new document is created');
select pg_temp.ok((select count(*) from public.doc_tables where doc_id = (select id from restored)) = 2, 'tables restored');
select pg_temp.ok((select count(*) from public.doc_columns where doc_id = (select id from restored))
                  = (select count(*) from public.doc_columns where doc_id = 'd0000000-0000-0000-0000-000000000005'), 'columns restored');
select pg_temp.ok((select count(*) from public.doc_rows where doc_id = (select id from restored))
                  = (select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000005'), 'rows restored');
select pg_temp.ok(not exists (select 1 from public.doc_columns where doc_id = (select id from restored)
                              and id in (select id from public.doc_columns where doc_id = 'd0000000-0000-0000-0000-000000000005')), 'everything gets new ids');
-- The restored reference points at the restored "Acme".
select pg_temp.ok((select c.data->>(select k.id::text from public.doc_columns k where k.doc_id = (select id from restored) and k.col_id = 'Name' and k.table_ref in (select id from public.doc_tables where doc_id = (select id from restored) and table_id = 'Clients'))
                   from public.doc_rows e
                   join public.doc_columns rc on rc.doc_id = e.doc_id and rc.col_id = 'Client'
                   join public.doc_rows c on c.id = (e.data->>rc.id::text)::bigint
                   where e.doc_id = (select id from restored) and e.data ? rc.id::text limit 1) = 'Acme', 'references point at the restored records');
select pg_temp.ok(not exists (select 1 from public.doc_rows r join public.doc_columns k on k.doc_id = r.doc_id and k.type = 'Attachments'
                              where r.doc_id = (select id from restored) and r.data ? k.id::text), 'attachment cells are emptied (files aren''t in backups)');
select pg_temp.ok((select count(*) from public.doc_widgets where doc_id = (select id from restored)) = 2, 'widgets restored');
select pg_temp.ok((select count(*) from public.doc_access_rules where doc_id = (select id from restored)) = 2, 'rules restored');
select pg_temp.ok(not exists (select 1 from public.doc_access_rules r where r.doc_id = (select id from restored)
                              and r.condition_ast::text like '%c0000000-0000-0000-0000-00000000006%'), 'rules point at the restored columns');
select pg_temp.ok((select source from public.doc_actions where doc_id = (select id from restored) order by id desc limit 1) = 'system', 'the restore is logged');
select pg_temp.ok((select public._role_of((select id from restored), '00000000-0000-0000-0000-0000000000e1')) = 'owner', 'the restorer owns the new document');

-- Without rules, viewers may download a backup; it carries no rules.
reset role;
delete from public.doc_access_rules where doc_id = 'd0000000-0000-0000-0000-000000000005';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok((public.doc_backup('d0000000-0000-0000-0000-000000000005') -> 'access') = 'null'::jsonb, 'viewers'' backups have no rules');
select pg_temp.act_as(null);
reset role;
set role anon;
select pg_temp.ok(pg_temp.err($$select public.doc_backup('d0000000-0000-0000-0000-000000000005')$$) like '42501%', 'signed-out callers get nothing');
reset role;

select 'backup: all checks passed' as out;
