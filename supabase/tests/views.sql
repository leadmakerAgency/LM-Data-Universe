-- Tests for the Board / Timeline / Gallery widget types, file versions and
-- import history. Runs after integrations.sql and reuses its "Integrations"
-- document: Gina (f1) owns it, Hugo (f2) edits, Ivy (f3) views, Jo (f4) has no access.
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

insert into public.doc_pages (id, doc_id, name, position) values
  ('b0000000-0000-0000-0000-0000000000e7', 'd0000000-0000-0000-0000-000000000007', 'Views', 9);

-- ------------------------------------------------------------
-- Widget types
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', $j$[
  {"op": "Add", "entity": "widget", "row": {"id": "e0000000-0000-0000-0000-0000000000e1", "page_id": "b0000000-0000-0000-0000-0000000000e7", "table_ref": "a0000000-0000-0000-0000-000000000007", "type": "board", "options": {"boardCol": "c0000000-0000-0000-0000-000000000073", "boardWip": {"Won": 3}}}},
  {"op": "Add", "entity": "widget", "row": {"id": "e0000000-0000-0000-0000-0000000000e2", "page_id": "b0000000-0000-0000-0000-0000000000e7", "table_ref": "a0000000-0000-0000-0000-000000000007", "type": "timeline", "options": {"tlZoom": "week"}}},
  {"op": "Add", "entity": "widget", "row": {"id": "e0000000-0000-0000-0000-0000000000e3", "page_id": "b0000000-0000-0000-0000-0000000000e7", "table_ref": "a0000000-0000-0000-0000-000000000007", "type": "gallery", "link_source": "e0000000-0000-0000-0000-0000000000e1"}}
]$j$);
select pg_temp.ok((select count(*) from public.doc_widgets where type in ('board', 'timeline', 'gallery')) = 3, 'boards, timelines and galleries can be added');
select pg_temp.ok((select options->'boardWip'->>'Won' from public.doc_widgets where id = 'e0000000-0000-0000-0000-0000000000e1') = '3', 'their settings are kept in options');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000007',
  '[{"op": "Add", "entity": "widget", "row": {"page_id": "b0000000-0000-0000-0000-0000000000e7", "table_ref": "a0000000-0000-0000-0000-000000000007", "type": "mindmap"}}]')$$) like '23514%', 'unknown widget types are still refused');
-- A card dropped on another stack: the value and the position change in one logged step.
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 702, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}, "manual_sort": 0.5}]}]');
reset role;
select pg_temp.ok((select manual_sort = 0.5 and data->>'c0000000-0000-0000-0000-000000000073' = 'Won' from public.doc_rows where id = 702), 'moving a card sets its stack and its place together');
select pg_temp.ok((select jsonb_array_length(actions) from public.doc_actions order by id desc limit 1) = 1, 'as one action, so one undo');

-- ------------------------------------------------------------
-- File versions
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
insert into public.doc_attachments (id, doc_id, file_name, size, mime, path, created_by, sha256, table_info) values
  ('f0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-000000000007', 'leads.csv', 100, 'text/csv',
   'd0000000-0000-0000-0000-000000000007/f0000000-0000-0000-0000-0000000000a1/leads.csv', '00000000-0000-0000-0000-0000000000f2',
   repeat('ab', 32), '{"rows": 2, "cols": 3, "headers": ["Email", "Name", "Status"], "sheets": 1}');
insert into public.doc_attachments (id, doc_id, file_name, size, mime, path, created_by, version, replaces, note, thumb_path) values
  ('f0000000-0000-0000-0000-0000000000a2', 'd0000000-0000-0000-0000-000000000007', 'leads.csv', 120, 'text/csv',
   'd0000000-0000-0000-0000-000000000007/f0000000-0000-0000-0000-0000000000a2/leads.csv', '00000000-0000-0000-0000-0000000000f2',
   2, 'f0000000-0000-0000-0000-0000000000a1', 'Added March leads', 'd0000000-0000-0000-0000-000000000007/f0000000-0000-0000-0000-0000000000a2/thumb.webp');
select pg_temp.ok((select version = 1 and replaces is null from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a1'), 'a first upload is version 1');
select pg_temp.ok((select version = 2 and replaces = 'f0000000-0000-0000-0000-0000000000a1' and note = 'Added March leads' from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a2'), 'a new version points at the one it replaces');
select pg_temp.ok((select count(*) from public.doc_attachments where id in ('f0000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000a2')) = 2, 'the earlier version is kept');
select pg_temp.ok(pg_temp.err($$insert into public.doc_attachments (doc_id, file_name, path, created_by, thumb_path) values
  ('d0000000-0000-0000-0000-000000000007', 'x.png', 'd0000000-0000-0000-0000-000000000007/x/x.png', '00000000-0000-0000-0000-0000000000f2', 'someone-else/x/thumb.webp')$$) like '23514%',
  'a preview image must sit in the document''s own folder');
select pg_temp.ok(pg_temp.err($$insert into public.doc_attachments (doc_id, file_name, path, created_by, sha256) values
  ('d0000000-0000-0000-0000-000000000007', 'x.png', 'd0000000-0000-0000-0000-000000000007/y/x.png', '00000000-0000-0000-0000-0000000000f2', 'nothex')$$) like '23514%',
  'content hashes are checked');
select pg_temp.ok(pg_temp.err($$update public.doc_attachments set note = 'changed' where id = 'f0000000-0000-0000-0000-0000000000a2'$$) <> ''
  or (select note from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a2') = 'Added March leads', 'versions can''t be rewritten afterwards');

-- ------------------------------------------------------------
-- Import history
-- ------------------------------------------------------------
insert into public.doc_imports (doc_id, attachment_id, file_name, file_version, sheet, table_ref, mode, mapping, key_cols, rows_added, rows_updated, created_by) values
  ('d0000000-0000-0000-0000-000000000007', 'f0000000-0000-0000-0000-0000000000a1', 'leads.csv', 1, 'leads', 'a0000000-0000-0000-0000-000000000007', 'update',
   '[{"header": "Email", "col": "c0000000-0000-0000-0000-000000000071"}]', '{c0000000-0000-0000-0000-000000000071}', 2, 1, '00000000-0000-0000-0000-0000000000f2');
select pg_temp.ok((select count(*) from public.doc_imports) = 1, 'editors record and see imports');
select pg_temp.ok(pg_temp.err($$insert into public.doc_imports (doc_id, file_name, mode, created_by) values ('d0000000-0000-0000-0000-000000000007', 'x.csv', 'add', '00000000-0000-0000-0000-0000000000f1')$$) like '42501%', 'only under their own name');
select pg_temp.ok(pg_temp.err($$insert into public.doc_imports (doc_id, file_name, mode, created_by) values ('d0000000-0000-0000-0000-000000000007', 'x.csv', 'replace', '00000000-0000-0000-0000-0000000000f2')$$) like '23514%', 'with a known mode');
select pg_temp.ok(pg_temp.err($$update public.doc_imports set rows_added = 99$$) like '42501%', 'the history can''t be changed');
select pg_temp.ok(pg_temp.err($$delete from public.doc_imports$$) like '42501%', 'or deleted');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.ok((select count(*) from public.doc_imports) = 0, 'viewers don''t see the import history');
select pg_temp.ok(pg_temp.err($$insert into public.doc_imports (doc_id, file_name, mode, created_by) values ('d0000000-0000-0000-0000-000000000007', 'x.csv', 'add', '00000000-0000-0000-0000-0000000000f3')$$) like '42501%', 'and can''t add to it');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select pg_temp.ok((select count(*) from public.doc_imports) = 0, 'people without access see nothing');
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select count(*) from public.doc_imports$$) like '42501%', 'signed-out visitors can''t read it');
reset role;
-- Removing the file keeps the history row (it names the file).
delete from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a1';
select pg_temp.ok((select attachment_id is null and file_name = 'leads.csv' from public.doc_imports limit 1), 'the history outlives the file');
select pg_temp.ok((select replaces is null from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a2'), 'and a later version outlives an earlier one');

delete from public.doc_imports;
delete from public.doc_attachments where id = 'f0000000-0000-0000-0000-0000000000a2';
delete from public.doc_widgets where page_id = 'b0000000-0000-0000-0000-0000000000e7';
delete from public.doc_pages where id = 'b0000000-0000-0000-0000-0000000000e7';

select 'views and files: all checks passed' as out;
