-- Tests for Phase 6: document settings, plans and limits, usage counters,
-- the audit log and the admin functions. Runs after the other test files.
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

-- ------------------------------------------------------------
-- Fixture: Kim owns "Platform", Lee edits, Max views, Nia is an administrator.
-- ------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000101', 'kim@example.com', now()),
  ('00000000-0000-0000-0000-000000000102', 'lee@example.com', now()),
  ('00000000-0000-0000-0000-000000000103', 'max@example.com', now()),
  ('00000000-0000-0000-0000-000000000104', 'nia@example.com', now());
insert into public.app_admins (user_id) values ('00000000-0000-0000-0000-000000000104');

select pg_temp.ok((select count(*) from public.doc_usage) = (select count(*) from public.documents), 'every document has a usage row');
select pg_temp.ok((select rows from public.doc_usage where doc_id = 'd0000000-0000-0000-0000-000000000007')
                  = (select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000007'), 'existing records are counted');

set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
create temp table p6ids (k text primary key, v uuid);
grant all on p6ids to authenticated;
insert into p6ids select 'ws', id from public.workspaces where owner_id = '00000000-0000-0000-0000-000000000101';
insert into public.documents (id, workspace_id, name) select 'd0000000-0000-0000-0000-000000000101', v, 'Platform' from p6ids where k = 'ws';
reset role;
insert into public.document_members (doc_id, user_id, role) values
  ('d0000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000102', 'editor'),
  ('d0000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000103', 'viewer');
insert into public.doc_tables (id, doc_id, table_id) values
  ('a0000000-0000-0000-0000-000000000101', 'd0000000-0000-0000-0000-000000000101', 'Items');
insert into public.doc_columns (id, table_ref, col_id, label, type, options, is_formula, formula, position) values
  ('c0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000101', 'Name', 'Name', 'Text', '{}', false, '', 1);

-- ------------------------------------------------------------
-- Document settings
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"locale": "nl-NL", "currency": "EUR", "timezone": "Europe/Amsterdam"}')$$) = '', 'editors change settings');
select pg_temp.ok((select settings->>'timezone' from public.documents where id = 'd0000000-0000-0000-0000-000000000101') = 'Europe/Amsterdam', 'settings saved');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"timezone": "Mars/Olympus"}')$$) like '22023%', 'unknown time zones are refused');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"currency": "euro"}')$$) like '22023%', 'currencies are ISO codes');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"locale": "<script>"}')$$) like '22023%', 'locales are checked');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"theme": "dark"}')$$) like '22023%', 'unknown settings are refused');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{"locale": 5}')$$) like '22023%', 'settings are text');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
select pg_temp.ok(pg_temp.err($$select public.set_doc_settings('d0000000-0000-0000-0000-000000000101', '{}')$$) like '42501%', 'viewers can''t change settings');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select pg_temp.ok(pg_temp.err($$update public.documents set settings = '{"currency": "euro"}' where id = 'd0000000-0000-0000-0000-000000000101'$$) like '22023%', 'direct updates are checked too');
select pg_temp.ok((select settings->>'locale' from public.documents where id = 'd0000000-0000-0000-0000-000000000101') = 'nl-NL', 'nothing changed');
reset role;
-- A new time zone asks for a full recalculation.
update public.doc_recalc set done_id = 5, requested_id = 5, running_since = null where doc_id = 'd0000000-0000-0000-0000-000000000101';
insert into public.doc_recalc (doc_id, done_id, requested_id) select 'd0000000-0000-0000-0000-000000000101', 5, 5
where not exists (select 1 from public.doc_recalc where doc_id = 'd0000000-0000-0000-0000-000000000101');
update public.documents set settings = settings || '{"timezone": "America/New_York"}' where id = 'd0000000-0000-0000-0000-000000000101';
select pg_temp.ok((select done_id from public.doc_recalc where doc_id = 'd0000000-0000-0000-0000-000000000101') = 0, 'time zone change: full recalculation');
select pg_temp.ok((select running_since is not null from public.doc_recalc where doc_id = 'd0000000-0000-0000-0000-000000000101'), 'and the worker is called');
update public.doc_recalc set done_id = 5, running_since = null where doc_id = 'd0000000-0000-0000-0000-000000000101';
update public.documents set settings = settings || '{"currency": "USD"}' where id = 'd0000000-0000-0000-0000-000000000101';
select pg_temp.ok((select done_id from public.doc_recalc where doc_id = 'd0000000-0000-0000-0000-000000000101') = 5, 'other settings don''t recalculate');

-- Copies and backups keep them.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
insert into p6ids select 'copy', public.copy_document('d0000000-0000-0000-0000-000000000101', (select v from p6ids where k = 'ws'), 'Platform copy', true, false);
select pg_temp.ok((select settings->>'timezone' from public.documents where id = (select v from p6ids where k = 'copy')) = 'America/New_York', 'copies keep settings');
insert into p6ids select 'restored', public.restore_backup((select v from p6ids where k = 'ws'), 'Restored', public.doc_backup('d0000000-0000-0000-0000-000000000101'));
select pg_temp.ok((select settings->>'locale' from public.documents where id = (select v from p6ids where k = 'restored')) = 'nl-NL', 'backups keep settings');
insert into p6ids select 'restored2', public.restore_backup((select v from p6ids where k = 'ws'), 'Restored 2',
  public.doc_backup('d0000000-0000-0000-0000-000000000101') || '{"settings": {"timezone": "Nowhere/Land"}}');
select pg_temp.ok((select settings from public.documents where id = (select v from p6ids where k = 'restored2')) = '{}', 'bad settings in a file are dropped');
select pg_temp.ok(pg_temp.err($$select public._restore_backup_content(null, null, null)$$) like '42501%', 'the inner restore isn''t callable');
reset role;

-- ------------------------------------------------------------
-- Plans and limits
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select pg_temp.ok(pg_temp.err($$update public.profiles set plan = 'unlimited' where id = '00000000-0000-0000-0000-000000000101'$$) like '42501%', 'people can''t change their own plan');
select pg_temp.ok(pg_temp.err($$update public.profiles set full_name = 'Kim' where id = '00000000-0000-0000-0000-000000000101'$$) = '', 'but can still edit their profile');
select pg_temp.ok(pg_temp.err($$select public.admin_set_plan('user', '00000000-0000-0000-0000-000000000101', 'pro')$$) like '42501%', 'only administrators set plans');
select pg_temp.ok(pg_temp.err($$insert into public.plans (id, name) values ('mine', 'Mine')$$) like '42501%', 'plans are read-only');
select pg_temp.ok((select count(*) from public.plans) = 3, 'everyone can read the plans');
reset role;

-- Documents: Kim has 4 live documents now; allow 4.
update public.plans set max_docs = 4 where id = 'free';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select pg_temp.ok(pg_temp.err($$insert into public.documents (workspace_id, name) select v, 'One too many' from p6ids where k = 'ws'$$) like '54000%', 'document limit');
select public.trash_document((select v from p6ids where k = 'restored2'));
select pg_temp.ok(pg_temp.err($$insert into public.documents (workspace_id, name) select v, 'Fits again' from p6ids where k = 'ws'$$) = '', 'trashed documents don''t count');
select pg_temp.ok(pg_temp.err($$select public.restore_document((select v from p6ids where k = 'restored2'))$$) like '54000%', 'restoring from the trash is checked');
select pg_temp.ok(pg_temp.err($$select public.copy_document('d0000000-0000-0000-0000-000000000101', (select v from p6ids where k = 'ws'), 'x', true, false)$$) like '54000%', 'copies are checked');
reset role;
update public.plans set max_docs = 100 where id = 'free';

-- Records per document.
update public.plans set max_rows_per_doc = 3 where id = 'free';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000101', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000101", "records": [{"data": {"c0000000-0000-0000-0000-000000000101": "a"}}, {"data": {"c0000000-0000-0000-0000-000000000101": "b"}}]}]')$$) = '', 'adding within the limit');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000101', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000101", "records": [{"data": {}}, {"data": {}}]}]')$$) like '54000%', 'record limit');
select pg_temp.ok((select rows from public.doc_usage where doc_id = 'd0000000-0000-0000-0000-000000000101') = 2, 'a refused save changes nothing');
select pg_temp.ok((select count(*) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000101') = 2, 'no records were added');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000101', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000101", "records": [{"data": {}}]}]')$$) = '', 'up to the limit');
select pg_temp.ok(pg_temp.err(format($$select public.apply_actions('d0000000-0000-0000-0000-000000000101', '[{"op": "RemoveRecords", "table": "a0000000-0000-0000-0000-000000000101", "ids": [%s]}]')$$,
  (select max(id) from public.doc_rows where doc_id = 'd0000000-0000-0000-0000-000000000101'))) = '', 'removing a record');
select pg_temp.ok((select rows from public.doc_usage where doc_id = 'd0000000-0000-0000-0000-000000000101') = 2, 'removals are counted');
reset role;
update public.plans set max_rows_per_doc = 100000 where id = 'free';

-- An administrator raises the plan.
update public.plans set max_rows_per_doc = 2 where id = 'free';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
select public.admin_set_plan('user', '00000000-0000-0000-0000-000000000101', 'pro');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select pg_temp.ok(pg_temp.err($$select public.apply_actions('d0000000-0000-0000-0000-000000000101', '[{"op": "AddRecords", "table": "a0000000-0000-0000-0000-000000000101", "records": [{"data": {}}]}]')$$) = '', 'the owner''s plan applies, not the editor''s');
reset role;
update public.plans set max_rows_per_doc = 100000 where id = 'free';

-- Attachment storage (per account).
update public.plans set max_attachment_mb = 1 where id = 'pro';
insert into public.doc_attachments (doc_id, file_name, size, path, created_by) values
  ('d0000000-0000-0000-0000-000000000101', 'a.pdf', 700000, 'd0000000-0000-0000-0000-000000000101/x1/a.pdf', '00000000-0000-0000-0000-000000000101');
select pg_temp.ok((select attachment_bytes from public.doc_usage where doc_id = 'd0000000-0000-0000-0000-000000000101') = 700000, 'attachment bytes counted');
select pg_temp.ok(pg_temp.err($$insert into public.doc_attachments (doc_id, file_name, size, path, created_by) select v, 'b.pdf', 700000, v::text || '/x2/b.pdf', '00000000-0000-0000-0000-000000000101' from p6ids where k = 'copy'$$) like '54000%', 'storage limit across the account''s documents');
delete from public.doc_attachments where path = 'd0000000-0000-0000-0000-000000000101/x1/a.pdf';
select pg_temp.ok((select attachment_bytes from public.doc_usage where doc_id = 'd0000000-0000-0000-0000-000000000101') = 0, 'deleted files are subtracted');
update public.plans set max_attachment_mb = 51200 where id = 'pro';

-- Activity counters.
select pg_temp.ok((select value from public.usage_counters where scope = 'doc' and scope_id = 'd0000000-0000-0000-0000-000000000101' and metric = 'actions.app' and day = current_date) >= 3,
                  'actions are counted per document and source');

-- ------------------------------------------------------------
-- Teams
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
insert into public.teams (id, name) values ('70000000-0000-0000-0000-000000000101', 'Kim''s team');
select pg_temp.ok(pg_temp.err($$update public.teams set plan = 'unlimited' where id = '70000000-0000-0000-0000-000000000101'$$) like '42501%', 'team owners can''t change the team''s plan');
reset role;
insert into public.team_members (team_id, user_id, role) values ('70000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000103', 'viewer');
set role authenticated;
select pg_temp.ok((public.my_usage('70000000-0000-0000-0000-000000000101') -> 'plan' ->> 'id') = 'free', 'team usage shows the team''s plan');
select pg_temp.ok((public.my_usage() -> 'plan' ->> 'id') = 'pro', 'own usage shows one''s own plan');
select pg_temp.ok((public.my_usage() -> 'usage' ->> 'docs')::int >= 3, 'own usage counts documents');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select pg_temp.ok(pg_temp.err($$select public.my_usage('70000000-0000-0000-0000-000000000101')$$) like 'P0002%', 'other teams'' usage is private');
reset role;

-- ------------------------------------------------------------
-- Audit log
-- ------------------------------------------------------------
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'doc.created' and doc_id = 'd0000000-0000-0000-0000-000000000101' and actor = '00000000-0000-0000-0000-000000000101'), 'document creation is logged with its author');
select pg_temp.ok(not exists (select 1 from public.audit_log where event = 'member.added' and doc_id = 'd0000000-0000-0000-0000-000000000101' and target = 'kim@example.com'), 'the creator becoming owner is not logged');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'member.added' and doc_id = 'd0000000-0000-0000-0000-000000000101' and target = 'lee@example.com' and details->>'role' = 'editor'), 'sharing is logged');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'doc.settings_changed' and doc_id = 'd0000000-0000-0000-0000-000000000101' and actor = '00000000-0000-0000-0000-000000000102'), 'settings changes are logged');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'plan.changed' and target = 'kim@example.com' and actor = '00000000-0000-0000-0000-000000000104'), 'plan changes are logged');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'doc.trashed'), 'trashing is logged');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'member.added' and team_id = '70000000-0000-0000-0000-000000000101' and target = 'max@example.com'), 'team members are logged');

-- Access rule saves: one event per save.
update public.document_members set role = 'viewer' where doc_id = 'd0000000-0000-0000-0000-000000000101' and user_id = '00000000-0000-0000-0000-000000000102';
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'member.role_changed' and target = 'lee@example.com' and details->>'to' = 'viewer'), 'role changes are logged');
insert into public.doc_access_settings (doc_id, block_copies) values ('d0000000-0000-0000-0000-000000000101', true);
update public.doc_access_settings set public_rules = true where doc_id = 'd0000000-0000-0000-0000-000000000101';
select pg_temp.ok((select count(*) from public.audit_log where event = 'access_rules.changed' and doc_id = 'd0000000-0000-0000-0000-000000000101') = 1, 'one event per transaction');

-- Deleting a document logs the deletion but not each membership going with it.
delete from public.documents where id = (select v from p6ids where k = 'restored');
select pg_temp.ok(exists (select 1 from public.audit_log where event = 'doc.deleted' and doc_id = (select v from p6ids where k = 'restored')), 'deletions are logged');
select pg_temp.ok(not exists (select 1 from public.audit_log where event = 'member.removed' and doc_id = (select v from p6ids where k = 'restored')), 'cascaded removals are not');

-- Reading it.
set role authenticated;
select pg_temp.ok(pg_temp.err($$select * from public.audit_log$$) like '42501%', 'the table itself is closed');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select pg_temp.ok(pg_temp.err($$select * from public.audit_events()$$) like '42501%', 'only administrators read everything');
select pg_temp.ok((select count(*) from public.audit_events(p_doc => 'd0000000-0000-0000-0000-000000000101')) >= 4, 'owners read their document''s log');
select pg_temp.ok((select count(*) from public.audit_events(p_team => '70000000-0000-0000-0000-000000000101')) >= 2, 'team owners read their team''s log');
select pg_temp.ok((select bool_and(doc_id = 'd0000000-0000-0000-0000-000000000101') from public.audit_events(p_doc => 'd0000000-0000-0000-0000-000000000101')), 'filtered to that document');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
select pg_temp.ok(pg_temp.err($$select * from public.audit_events(p_doc => 'd0000000-0000-0000-0000-000000000101')$$) like '42501%', 'viewers can''t');
select pg_temp.ok(pg_temp.err($$select * from public.audit_events(p_team => '70000000-0000-0000-0000-000000000101')$$) like '42501%', 'nor team viewers');
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
select pg_temp.ok((select count(*) from public.audit_events()) > 10, 'administrators read everything');
select pg_temp.ok((select count(*) from public.audit_events(p_event => 'doc.', p_limit => 2)) = 2, 'filter and limit');
select pg_temp.ok((select min(id) from public.audit_events(p_limit => 3)) > (select max(id) from public.audit_events(p_limit => 3, p_before => (select min(id) from public.audit_events(p_limit => 3)))), 'paging');

-- ------------------------------------------------------------
-- Admin panel
-- ------------------------------------------------------------
select pg_temp.ok(public.is_app_admin(), 'Nia is an administrator');
select pg_temp.ok((public.admin_overview() ->> 'people')::int >= 4, 'overview');
select pg_temp.ok((select plan from public.admin_accounts('kim@') where kind = 'user') = 'pro', 'accounts with plans');
select pg_temp.ok((select docs from public.admin_accounts('kim@') where kind = 'user') >= 3, 'accounts with usage');
select pg_temp.ok(exists (select 1 from public.admin_accounts('Kim''s') where kind = 'team' and members = 2), 'teams are accounts too');
select pg_temp.ok(pg_temp.err($$select public.admin_set_plan('user', '00000000-0000-0000-0000-000000000101', 'gold')$$) like '22023%', 'unknown plans');
select pg_temp.ok(pg_temp.err($$select public.admin_set_admin('00000000-0000-0000-0000-000000000104', false)$$) like '22023%', 'administrators can''t remove themselves');
select public.admin_set_admin('00000000-0000-0000-0000-000000000101', true);
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select pg_temp.ok(public.is_app_admin(), 'new administrator');
select public.admin_set_admin('00000000-0000-0000-0000-000000000104', false);
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
select pg_temp.ok(not public.is_app_admin(), 'removed administrator');
select pg_temp.ok(pg_temp.err($$select public.admin_overview()$$) like '42501%', 'non-administrators get no overview');
select pg_temp.ok(pg_temp.err($$select * from public.admin_accounts()$$) like '42501%', 'nor the account list');
reset role;
select pg_temp.ok((select count(*) from public.audit_log where event in ('admin.added', 'admin.removed')) >= 3, 'administrator changes are logged');

select 'platform: all checks passed' as out;
