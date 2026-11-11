-- Security tests for access rules (Phase 3). Each test acts as a simulated
-- user: `set role authenticated` plus the JWT subject that auth.uid() reads.
-- Run against a scratch database with every migration applied; it changes
-- data, so on a real project wrap it in a transaction and roll back.

create or replace function pg_temp.ok(p boolean, p_msg text) returns void language plpgsql as $$
begin
  if p is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_msg;
  end if;
end $$;

-- Runs a statement and returns the error code it raised ('' if none).
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
  perform set_config('request.headers', '{}', false);
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ------------------------------------------------------------
-- Fixture (as the database owner)
-- ------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com', now()),  -- owner
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com', now()),    -- editor
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com', now()),  -- viewer
  ('00000000-0000-0000-0000-00000000000d', 'dave@example.com', now());   -- no access

insert into public.documents (id, workspace_id, name, created_by)
select 'd0000000-0000-0000-0000-000000000001', w.id, 'Ruled', w.owner_id
from public.workspaces w where w.owner_id = '00000000-0000-0000-0000-00000000000a';
insert into public.documents (id, workspace_id, name, created_by)
select 'd0000000-0000-0000-0000-000000000002', w.id, 'Plain', w.owner_id
from public.workspaces w where w.owner_id = '00000000-0000-0000-0000-00000000000a';
insert into public.document_members (doc_id, user_id, role) values
  ('d0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'editor'),
  ('d0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'viewer'),
  ('d0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000c', 'viewer'),
  ('d0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'editor');

insert into public.doc_tables (id, doc_id, table_id) values
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Tasks'),
  ('a0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'Teams'),
  ('a0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'People'),
  ('a0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000002', 'Plain');
insert into public.doc_columns (id, table_ref, col_id, type, options, is_formula, formula) values
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Owner', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Title', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Salary', 'Numeric', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'Team', 'Ref', '{"refTable": "a0000000-0000-0000-0000-000000000002"}', false, ''),
  ('c0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'Files', 'Attachments', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'Double', 'Numeric', '{}', true, '$Salary * 2'),
  ('c0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000002', 'Name', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000021', 'a0000000-0000-0000-0000-000000000003', 'Email', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000022', 'a0000000-0000-0000-0000-000000000003', 'Dept', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000091', 'a0000000-0000-0000-0000-000000000009', 'X', 'Text', '{}', false, '');
insert into public.doc_rows (id, table_ref, data, computed) values
  (1, 'a0000000-0000-0000-0000-000000000001', '{"c0000000-0000-0000-0000-000000000001": "bob@example.com", "c0000000-0000-0000-0000-000000000002": "Bob task", "c0000000-0000-0000-0000-000000000003": 100, "c0000000-0000-0000-0000-000000000004": 11, "c0000000-0000-0000-0000-000000000005": ["f0000000-0000-0000-0000-000000000001"]}', '{"c0000000-0000-0000-0000-000000000006": 200}'),
  (2, 'a0000000-0000-0000-0000-000000000001', '{"c0000000-0000-0000-0000-000000000001": "carol@example.com", "c0000000-0000-0000-0000-000000000002": "Carol task", "c0000000-0000-0000-0000-000000000003": 200, "c0000000-0000-0000-0000-000000000004": 12}', '{"c0000000-0000-0000-0000-000000000006": 400}'),
  (3, 'a0000000-0000-0000-0000-000000000001', '{"c0000000-0000-0000-0000-000000000001": "BOB@example.com", "c0000000-0000-0000-0000-000000000002": "Bob task 2", "c0000000-0000-0000-0000-000000000003": 300, "c0000000-0000-0000-0000-000000000004": 12}', '{}'),
  (11, 'a0000000-0000-0000-0000-000000000002', '{"c0000000-0000-0000-0000-000000000011": "Red"}', '{}'),
  (12, 'a0000000-0000-0000-0000-000000000002', '{"c0000000-0000-0000-0000-000000000011": "Blue"}', '{}'),
  (21, 'a0000000-0000-0000-0000-000000000003', '{"c0000000-0000-0000-0000-000000000021": "Carol@Example.com", "c0000000-0000-0000-0000-000000000022": "Blue"}', '{}'),
  (91, 'a0000000-0000-0000-0000-000000000009', '{"c0000000-0000-0000-0000-000000000091": "plain"}', '{}');
select setval(pg_get_serial_sequence('public.doc_rows', 'id'), 1000);
insert into public.doc_attachments (id, doc_id, file_name, path, created_by) values
  ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'bob.pdf', 'd0000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000001/bob.pdf', '00000000-0000-0000-0000-00000000000a'),
  ('f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'loose.pdf', 'd0000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000002/loose.pdf', '00000000-0000-0000-0000-00000000000a');
insert into public.doc_comments (doc_id, table_ref, row_id, col_id, body, author) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000002', 'On Bob''s row', '00000000-0000-0000-0000-00000000000a'),
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 2, 'c0000000-0000-0000-0000-000000000002', 'On Carol''s row', '00000000-0000-0000-0000-00000000000a');
-- Some history.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public._apply_and_log('d0000000-0000-0000-0000-000000000001',
  '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 2, "values": {"c0000000-0000-0000-0000-000000000002": "Carol task"}}]}]', 'do', null, true, 'app');

-- ------------------------------------------------------------
-- Before any rules: everybody with access reads rows directly
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.ok((select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000001') = 6, 'viewer reads all rows before rules');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001')) = 6, 'read_rows without rules returns everything');

-- Only owners may save rules.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok(pg_temp.err($$select public.save_access_rules('d0000000-0000-0000-0000-000000000001', '[]', '[]', '{}')$$) like '42501%', 'editor cannot save rules');
select pg_temp.ok(pg_temp.err($$select * from public.doc_access_rules$$) like '42501%', 'no direct access to the rules table');

-- ------------------------------------------------------------
-- Rules
--   1. Tasks: non-owners only see, change and delete their own tasks (case-insensitive).
--   2. Tasks.Salary (and the formula built on it): owners only.
--   3. Tasks: you may only add tasks you own (unless owner).
--   4. Teams: the team named in user.Person.Dept is read-only for its members... (exercise attributes)
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.save_access_rules('d0000000-0000-0000-0000-000000000001',
  '[
    {"table_ref": "a0000000-0000-0000-0000-000000000001", "col_ids": [],
     "condition": "user.Access != \"owner\" and rec.Owner.lower() != user.Email.lower()",
     "condition_ast": {"t": "and", "args": [
        {"t": "cmp", "op": "!=", "l": {"t": "user", "f": "Access"}, "r": {"t": "lit", "v": "owner"}},
        {"t": "cmp", "op": "!=", "l": {"t": "fn", "fn": "lower", "arg": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000001"]}},
                                  "r": {"t": "fn", "fn": "lower", "arg": {"t": "user", "f": "Email"}}}]},
     "permissions": {"read": false, "update": false, "delete": false}},
    {"table_ref": "a0000000-0000-0000-0000-000000000001", "col_ids": [],
     "condition": "user.Access != \"owner\" and newRec.Owner.lower() != user.Email.lower()",
     "condition_ast": {"t": "and", "args": [
        {"t": "cmp", "op": "!=", "l": {"t": "user", "f": "Access"}, "r": {"t": "lit", "v": "owner"}},
        {"t": "cmp", "op": "!=", "l": {"t": "fn", "fn": "lower", "arg": {"t": "rec", "which": "newRec", "path": ["c0000000-0000-0000-0000-000000000001"]}},
                                  "r": {"t": "fn", "fn": "lower", "arg": {"t": "user", "f": "Email"}}}]},
     "permissions": {"create": false, "update": false}},
    {"table_ref": "a0000000-0000-0000-0000-000000000001", "col_ids": ["c0000000-0000-0000-0000-000000000003", "c0000000-0000-0000-0000-000000000006"],
     "condition": "user.Access != \"owner\"",
     "condition_ast": {"t": "cmp", "op": "!=", "l": {"t": "user", "f": "Access"}, "r": {"t": "lit", "v": "owner"}},
     "permissions": {"read": false, "update": false}},
    {"table_ref": "a0000000-0000-0000-0000-000000000002", "col_ids": [],
     "condition": "user.Person.Dept != rec.Name and user.Access != \"owner\"",
     "condition_ast": {"t": "and", "args": [
        {"t": "cmp", "op": "!=", "l": {"t": "uattr", "a": "Person", "col": "c0000000-0000-0000-0000-000000000022"}, "r": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000011"]}},
        {"t": "cmp", "op": "!=", "l": {"t": "user", "f": "Access"}, "r": {"t": "lit", "v": "owner"}}]},
     "permissions": {"read": false}}
  ]',
  '[{"name": "Person", "user_field": "Email", "table_ref": "a0000000-0000-0000-0000-000000000003", "match_col": "c0000000-0000-0000-0000-000000000021"}]',
  '{"editors_structure": false}');

-- ------------------------------------------------------------
-- Viewer (carol)
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.ok((select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000001') = 0, 'viewer: no direct row reads in a ruled document');
select pg_temp.ok((select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000002') = 1, 'viewer: direct reads still work in a document without rules');
select pg_temp.ok((select array_agg(id order by id) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000001') = '{2}', 'viewer sees only her own task');
select pg_temp.ok((select bool_and(not (data ? 'c0000000-0000-0000-0000-000000000003') and not (computed ? 'c0000000-0000-0000-0000-000000000006'))
                   from public.read_rows('d0000000-0000-0000-0000-000000000001')), 'viewer: Salary and the formula on it are stripped');
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-000000000002' from public.read_rows('d0000000-0000-0000-0000-000000000001') where id = 2) = 'Carol task', 'viewer: other cells of her row are there');
select pg_temp.ok((select array_agg(id order by id) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000002') = '{12}', 'viewer: user attribute rule shows only her department''s team');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001', 0, 1000, '{1,2}')) = 1, 'viewer: asking for a hidden id by number returns nothing');
select pg_temp.ok(not exists (select 1 from public.doc_columns where id = 'c0000000-0000-0000-0000-000000000003'), 'viewer: hidden column metadata is not visible');
select pg_temp.ok(exists (select 1 from public.doc_columns where id = 'c0000000-0000-0000-0000-000000000002'), 'viewer: other columns are visible');
select pg_temp.ok((public.acl_info('d0000000-0000-0000-0000-000000000001')->'hidden_cols') @> '["c0000000-0000-0000-0000-000000000003"]', 'acl_info lists the hidden column');
select pg_temp.ok((public.acl_info('d0000000-0000-0000-0000-000000000001')->'tables'->'a0000000-0000-0000-0000-000000000001'->'read') = 'null'::jsonb, 'acl_info: Tasks read depends on the record');
select pg_temp.ok((select count(*) from public.doc_actions where doc_id = 'd0000000-0000-0000-0000-000000000001') = 0, 'viewer: activity log hidden');
select pg_temp.ok(pg_temp.err($$select public.doc_content('d0000000-0000-0000-0000-000000000001')$$) like '42501%', 'viewer: compare blocked');
select pg_temp.ok((select array_agg(row_id) from public.doc_comments where doc_id = 'd0000000-0000-0000-0000-000000000001') = '{2}', 'viewer: only comments on visible rows');
select pg_temp.ok(pg_temp.err($$insert into public.doc_comments (doc_id, table_ref, row_id, col_id, body) values ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 1, null, 'peek')$$) like '42501%', 'viewer: cannot comment on a hidden row');
select pg_temp.ok(pg_temp.err($$select public.read_rows('d0000000-0000-0000-0000-000000000001', 0, 10, null, 'bob@example.com')$$) like '42501%', 'viewer: cannot view as someone else');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 2, "values": {"c0000000-0000-0000-0000-000000000002": "x"}}]}]')$$) like '42501%', 'viewer: still cannot write');

-- ------------------------------------------------------------
-- Editor (bob)
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select array_agg(id order by id) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000001') = '{1,3}', 'editor sees his tasks (case-insensitive match)');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000002') = 0, 'editor without a Person record sees no teams');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 1, "values": {"c0000000-0000-0000-0000-000000000002": "Renamed"}}]}]')$$) = '', 'editor updates his own task');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 2, "values": {"c0000000-0000-0000-0000-000000000002": "Hijack"}}]}]')$$) like '42501%', 'editor cannot update a task he cannot see');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 1, "values": {"c0000000-0000-0000-0000-000000000001": "carol@example.com"}}]}]')$$) like '42501%', 'editor cannot give his task away (newRec check)');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 1, "values": {"c0000000-0000-0000-0000-000000000003": 999}}]}]')$$) like '42501%', 'editor cannot write the hidden Salary cell');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"data": {"c0000000-0000-0000-0000-000000000001": "bob@example.com", "c0000000-0000-0000-0000-000000000002": "New"}}]}]')$$) = '', 'editor adds a task he owns');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"data": {"c0000000-0000-0000-0000-000000000001": "carol@example.com"}}]}]')$$) like '42501%', 'editor cannot add a task for someone else');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "RemoveRecords", "table": "a0000000-0000-0000-0000-000000000001", "ids": [2]}]')$$) like '42501%', 'editor cannot delete a hidden task');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000001", "records": [{"id": 1, "values": {"c0000000-0000-0000-0000-000000000002": "ok"}}, {"id": 2, "values": {"c0000000-0000-0000-0000-000000000002": "sneak"}}]}]')$$) like '42501%', 'a bundle with one forbidden record is rejected whole');
reset role;
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-000000000002' from public.doc_rows where id = 1) = 'Renamed'
                  and (select data->>'c0000000-0000-0000-0000-000000000002' from public.doc_rows where id = 2) = 'Carol task', 'rejected bundles changed nothing');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "Add", "entity": "column", "row": {"table_ref": "a0000000-0000-0000-0000-000000000001", "col_id": "Extra"}}]')$$) like '42501%', 'editor cannot change structure when the setting says so');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "Update", "entity": "widget", "id": "00000000-0000-0000-0000-000000000000", "patch": {}}]')$$) not like '42501%', 'editor can still work with pages and widgets');
select pg_temp.ok(pg_temp.err($$select public.copy_document('d0000000-0000-0000-0000-000000000001', (select id from public.workspaces where owner_id = '00000000-0000-0000-0000-00000000000b'), 'Leak')$$) like '42501%', 'editor cannot copy a ruled document');
select pg_temp.ok((select count(*) from public.doc_snapshots where doc_id = 'd0000000-0000-0000-0000-000000000001') = 0, 'editor: snapshots hidden');
select pg_temp.ok((select count(*) from public.doc_attachments where doc_id = 'd0000000-0000-0000-0000-000000000001') = 1, 'editor: sees the attachment in his visible row only');
select pg_temp.ok(public._acl_attachment_path_visible('d0000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000001/bob.pdf')
                  and not public._acl_attachment_path_visible('d0000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000002/loose.pdf'), 'editor: file access follows the cell');

-- Undo of something you may no longer do is checked too.
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select public.undo_state('d0000000-0000-0000-0000-000000000001')->>'can_undo') = 'true', 'editor has undo steps');
set role authenticated;
select pg_temp.ok(pg_temp.err($$select public.undo_action('d0000000-0000-0000-0000-000000000001')$$) = '', 'undo of an allowed change works');

-- ------------------------------------------------------------
-- Owner (alice)
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000001') = 3, 'owner sees every task (the editor''s added task was undone)');
select pg_temp.ok((select data->'c0000000-0000-0000-0000-000000000003' from public.read_rows('d0000000-0000-0000-0000-000000000001') where id = 2) = '200', 'owner sees Salary');
select pg_temp.ok((select array_agg(id order by id) from public.read_rows('d0000000-0000-0000-0000-000000000001', 0, 1000, null, 'carol@example.com') where table_ref = 'a0000000-0000-0000-0000-000000000001') = '{2}', 'owner can view as carol');
select pg_temp.ok((public.acl_info('d0000000-0000-0000-0000-000000000001', 'carol@example.com')->>'access') = 'viewer', 'view-as reports carol''s role');
select pg_temp.ok(pg_temp.err($$select public.read_rows('d0000000-0000-0000-0000-000000000001', 0, 10, null, 'dave@example.com')$$) like 'P0002%', 'view as someone without access fails');
select pg_temp.ok((select count(*) from public.doc_actions where doc_id = 'd0000000-0000-0000-0000-000000000001') > 0, 'owner still sees the activity log');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "Remove", "entity": "column", "id": "c0000000-0000-0000-0000-000000000003"}]')$$) like '42501%used by access rules%', 'a column used by rules cannot be removed');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "Remove", "entity": "table", "id": "a0000000-0000-0000-0000-000000000003"}]')$$) like '42501%used by access rules%', 'a table used by a user attribute cannot be removed');
select pg_temp.ok((public.get_access_rules('d0000000-0000-0000-0000-000000000001')->'rules'->0->>'valid') = 'true', 'rules report as valid');

-- Rules are checked when saved.
select pg_temp.ok(pg_temp.err($$select public.save_access_rules('d0000000-0000-0000-0000-000000000001',
  '[{"table_ref": null, "condition_ast": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000001"]}, "permissions": {"read": false}}]', '[]', '{}')$$) like '%only be used in rules for a specific table%', 'rec in a default rule is rejected');
select pg_temp.ok(pg_temp.err($$select public.save_access_rules('d0000000-0000-0000-0000-000000000001',
  '[{"table_ref": "a0000000-0000-0000-0000-000000000001", "condition_ast": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000091"]}, "permissions": {"read": false}}]', '[]', '{}')$$) like '%no longer exists%', 'a column of another table is rejected');
select pg_temp.ok(pg_temp.err($$select public.save_access_rules('d0000000-0000-0000-0000-000000000001',
  '[{"table_ref": "a0000000-0000-0000-0000-000000000001", "condition_ast": {"t": "raw", "sql": "true"}, "permissions": {"read": false}}]', '[]', '{}')$$) like '%Invalid condition%', 'unknown node types are rejected');
select pg_temp.ok(pg_temp.err($$select public.save_access_rules('d0000000-0000-0000-0000-000000000001',
  '[{"table_ref": "a0000000-0000-0000-0000-000000000001", "permissions": {"read": "nope"}}]', '[]', '{}')$$) like '%invalid permission%', 'non-boolean permissions are rejected');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000001') = 3, 'a rejected save left the rules as they were');

-- The compiler is internal.
select pg_temp.ok(pg_temp.err($$select public._acl_bool('{"t": "lit", "v": true}', null, null, '{}', 0)$$) like '42501%', 'users cannot call the compiler');
-- Values are data, never SQL.
reset role;
select pg_temp.ok(pg_temp.err('select ' || public._acl_bool(
                    '{"t": "cmp", "op": "==", "l": {"t": "lit", "v": "x''); drop table public.documents; --"}, "r": {"t": "user", "f": "Email"}}',
                    'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', public._acl_ctx_me('d0000000-0000-0000-0000-000000000001'), 0)) = ''
                  and to_regclass('public.documents') is not null, 'literals are quoted');
select pg_temp.ok(pg_temp.err($$select public._acl_bool('{"t": "rec", "which": "rec", "path": ["x; drop table public.documents"]}', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '{}', 0)$$)
                  like '%no longer exists%', 'column ids that are not this table''s columns are rejected');
select pg_temp.ok(pg_temp.err($$select public._acl_bool('{"t": "rec", "which": "r.id) or (true", "path": ["c0000000-0000-0000-0000-000000000001"]}', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '{}', 0)$$)
                  like '%Invalid record reference%', 'only rec/newRec aliases');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');

-- ------------------------------------------------------------
-- Broken rules fail closed
-- ------------------------------------------------------------
reset role;
insert into public.doc_access_rules (doc_id, table_ref, condition_ast, permissions, position) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   '{"t": "cmp", "op": "==", "l": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-0000000000ff"]}, "r": {"t": "lit", "v": 1}}', '{"read": false}', 0),
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003',
   '{"t": "cmp", "op": "==", "l": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-0000000000ff"]}, "r": {"t": "lit", "v": 1}}', '{"read": true}', 0),
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', null, '{"read": false}', 1);
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000002') = 0, 'a broken deny rule always applies');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000003') = 0, 'a broken allow rule never applies');
select pg_temp.ok((public.get_access_rules('d0000000-0000-0000-0000-000000000001')->'rules') @> '[{"valid": false}]', 'broken rules are reported');
reset role;
delete from public.doc_access_rules where table_ref in ('a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003') and position in (0, 1) and condition = '';

-- ------------------------------------------------------------
-- Signed-out link visitor and outsiders
-- ------------------------------------------------------------
insert into public.doc_share_links (doc_id, token, role, created_by) values
  ('d0000000-0000-0000-0000-000000000001', 'tok-view', 'viewer', '00000000-0000-0000-0000-00000000000a');
set role anon;
select pg_temp.act_as(null);
select set_config('request.headers', '{"x-share-token": "tok-view"}', false);
select pg_temp.ok((select count(*) from public.doc_rows) = 0, 'link visitor: no direct row reads');
select pg_temp.ok((select count(*) from public.read_rows('d0000000-0000-0000-0000-000000000001') where table_ref = 'a0000000-0000-0000-0000-000000000001') = 0, 'link visitor: rules apply (no email, no own tasks)');
select pg_temp.ok(not exists (select 1 from public.doc_columns where id = 'c0000000-0000-0000-0000-000000000003'), 'link visitor: hidden column metadata not visible');
select set_config('request.headers', '{}', false);
select pg_temp.ok(pg_temp.err($$select public.read_rows('d0000000-0000-0000-0000-000000000001')$$) like 'P0002%', 'without the link: nothing');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(pg_temp.err($$select public.read_rows('d0000000-0000-0000-0000-000000000001')$$) like 'P0002%', 'outsider: nothing');
select pg_temp.ok(pg_temp.err($$select public.acl_info('d0000000-0000-0000-0000-000000000001')$$) like 'P0002%', 'outsider: no acl info');

-- ------------------------------------------------------------
-- Change notices carry ids only, on the document's private topic
-- ------------------------------------------------------------
reset role;
select pg_temp.ok(exists (select 1 from realtime.messages where topic = 'doc:d0000000-0000-0000-0000-000000000001' and event = 'changes' and private), 'changes are broadcast privately');
select pg_temp.ok(not exists (select 1 from realtime.messages where payload::text like '%task%' or payload::text like '%example.com%'), 'notices carry no cell values');
select pg_temp.ok(exists (select 1 from realtime.messages where event = 'acl'), 'saving rules is announced');
set role authenticated;
select set_config('realtime.topic', 'doc:d0000000-0000-0000-0000-000000000001', false);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.ok((select count(*) from realtime.messages) > 0, 'a reader may listen');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) from realtime.messages) = 0, 'an outsider may not listen');

-- ------------------------------------------------------------
-- Copies by the owner keep the rules; snapshots restore without losing them
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok(pg_temp.err($$select count(*) from public.doc_access_rules$$) like '42501%', 'no direct access to the rules table for owners either');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table copy_id as select public.copy_document('d0000000-0000-0000-0000-000000000001',
  (select id from public.workspaces where owner_id = '00000000-0000-0000-0000-00000000000a'), 'Copy') as id;
select pg_temp.ok((select count(*) from public.doc_access_rules where doc_id = (select id from copy_id)) = 4, 'copy has the rules');
select pg_temp.ok(not exists (select 1 from public.doc_access_rules r where r.doc_id = (select id from copy_id)
                  and (r.table_ref in (select id from public.doc_tables where doc_id = 'd0000000-0000-0000-0000-000000000001')
                       or r.condition_ast::text like '%c0000000-0000-0000-0000-000000000001%')), 'copied rules point at the copy''s tables and columns');
select public.take_snapshot('d0000000-0000-0000-0000-000000000001', 'test');
select public.restore_snapshot((select max(id) from public.doc_snapshots where doc_id = 'd0000000-0000-0000-0000-000000000001' and kind = 'manual'));
select pg_temp.ok((select count(*) from public.doc_access_rules where doc_id = 'd0000000-0000-0000-0000-000000000001') = 4, 'restoring a snapshot keeps the rules');
select pg_temp.ok((select count(*) from public.doc_user_attributes where doc_id = 'd0000000-0000-0000-0000-000000000001') = 1, 'restoring a snapshot keeps user attributes');

-- Without a saved setting, editors can't change structure once there are rules
-- (a formula column could otherwise show hidden values).
reset role;
delete from public.doc_access_settings where doc_id = 'd0000000-0000-0000-0000-000000000001';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000001', '[{"op": "Add", "entity": "column", "row": {"table_ref": "a0000000-0000-0000-0000-000000000001", "col_id": "Peek", "is_formula": true, "formula": "$Salary"}}]')$$) like '42501%', 'editors cannot add a formula column once there are rules');
select pg_temp.ok((public.acl_info('d0000000-0000-0000-0000-000000000001')->>'structure') = 'false', 'acl_info agrees');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000002', '[{"op": "Add", "entity": "column", "row": {"table_ref": "a0000000-0000-0000-0000-000000000009", "col_id": "Fine"}}]')$$) = '', 'editors still change structure in documents without rules');

select 'access rules: all checks passed' as out;
