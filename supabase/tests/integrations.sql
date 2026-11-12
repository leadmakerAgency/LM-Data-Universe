-- Tests for Phase 5: API keys, the API functions, webhooks, automations and
-- the job queue. Same harness as access_rules.sql (the file runs as one
-- transaction, so each API call is preceded by pg_temp.act_as to reset who we are).
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
-- Fixture: Gina owns "Integrations", Hugo edits, Ivy views, Jo has no access.
-- ------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'gina@example.com', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'hugo@example.com', now()),
  ('00000000-0000-0000-0000-0000000000f3', 'ivy@example.com', now()),
  ('00000000-0000-0000-0000-0000000000f4', 'jo@example.com', now());
insert into public.documents (id, workspace_id, name, created_by)
select 'd0000000-0000-0000-0000-000000000007', w.id, 'Integrations', w.owner_id
from public.workspaces w where w.owner_id = '00000000-0000-0000-0000-0000000000f1';
insert into public.document_members (doc_id, user_id, role) values
  ('d0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-0000000000f2', 'editor'),
  ('d0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-0000000000f3', 'viewer');
insert into public.doc_tables (id, doc_id, table_id) values
  ('a0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000007', 'Leads');
insert into public.doc_columns (id, table_ref, col_id, label, type, options, is_formula, formula, position) values
  ('c0000000-0000-0000-0000-000000000071', 'a0000000-0000-0000-0000-000000000007', 'Email', 'Email', 'Text', '{}', false, '', 1),
  ('c0000000-0000-0000-0000-000000000072', 'a0000000-0000-0000-0000-000000000007', 'Name', 'Name', 'Text', '{}', false, '', 2),
  ('c0000000-0000-0000-0000-000000000073', 'a0000000-0000-0000-0000-000000000007', 'Status', 'Status', 'Choice', '{"choices": ["New", "Won"]}', false, '', 3),
  ('c0000000-0000-0000-0000-000000000074', 'a0000000-0000-0000-0000-000000000007', 'Amount', 'Amount', 'Numeric', '{}', false, '', 4),
  ('c0000000-0000-0000-0000-000000000075', 'a0000000-0000-0000-0000-000000000007', 'Ready', 'Ready', 'Bool', '{}', false, '', 5),
  ('c0000000-0000-0000-0000-000000000076', 'a0000000-0000-0000-0000-000000000007', 'Score', 'Score', 'Numeric', '{}', true, '$Amount * 2', 6);
insert into public.doc_rows (id, table_ref, manual_sort, data, computed) values
  (701, 'a0000000-0000-0000-0000-000000000007', 1, '{"c0000000-0000-0000-0000-000000000071": "ann@example.com", "c0000000-0000-0000-0000-000000000072": "Ann", "c0000000-0000-0000-0000-000000000073": "New", "c0000000-0000-0000-0000-000000000074": 100, "c0000000-0000-0000-0000-000000000075": false}', '{"c0000000-0000-0000-0000-000000000076": 200}'),
  (702, 'a0000000-0000-0000-0000-000000000007', 2, '{"c0000000-0000-0000-0000-000000000071": "bob@example.com", "c0000000-0000-0000-0000-000000000072": "Bob", "c0000000-0000-0000-0000-000000000073": "Won", "c0000000-0000-0000-0000-000000000074": 300, "c0000000-0000-0000-0000-000000000075": true}', '{"c0000000-0000-0000-0000-000000000076": 600}');
insert into vault.decrypted_secrets (name, decrypted_secret) values
  ('doc_worker_secret', 'sek'), ('doc_worker_url', 'https://example.supabase.co/functions/v1/doc-worker');

-- ------------------------------------------------------------
-- API keys
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
create temp table keys (who text, key text);
grant all on keys to anon, authenticated;
insert into keys select 'gina', public.create_api_key('n8n') ->> 'key';
select pg_temp.ok((select key from keys where who = 'gina') ~ '^lmdu_[0-9a-f]{48}$', 'keys look like lmdu_ + 48 hex');
select pg_temp.ok((select count(*) from public.api_keys) = 1 and (select prefix from public.api_keys) = left((select key from keys where who = 'gina'), 13), 'owners list their keys by prefix');
select pg_temp.ok(pg_temp.err($$select hash from public.api_keys$$) like '42501%', 'the hash is not readable');
select pg_temp.ok(pg_temp.err($$select public.create_api_key('')$$) like '%name%', 'keys need a name');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
insert into keys select 'hugo', public.create_api_key('hugo') ->> 'key';
select pg_temp.ok((select count(*) from public.api_keys) = 1, 'people only see their own keys');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
insert into keys select 'ivy', public.create_api_key('ivy') ->> 'key';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
insert into keys select 'jo', public.create_api_key('jo') ->> 'key';
insert into keys select 'jo-old', public.create_api_key('old') ->> 'key';
select public.revoke_api_key((select id from public.api_keys where label = 'old'));
select pg_temp.ok(pg_temp.err($$select public.revoke_api_key((select id from public.api_keys where label = 'old'))$$) like 'P0002%', 'a revoked key cannot be revoked again');

-- ------------------------------------------------------------
-- Who an API call is
-- ------------------------------------------------------------
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select public.api_tables('nope', 'd0000000-0000-0000-0000-000000000007')$$) like 'PT401%', 'malformed keys are refused');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select public.api_tables('lmdu_' || repeat('0', 48), 'd0000000-0000-0000-0000-000000000007')$$) like 'PT401%', 'unknown keys are refused');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_tables(%L, 'd0000000-0000-0000-0000-000000000007')$$, (select key from keys where who = 'jo-old'))) like 'PT401%', 'revoked keys are refused');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_tables(%L, 'd0000000-0000-0000-0000-000000000007')$$, (select key from keys where who = 'jo'))) like 'PT404%', 'people without access get "not found"');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_tables((select key from keys where who = 'ivy'), 'd0000000-0000-0000-0000-000000000007') -> 'tables' -> 0 ->> 'id' = 'Leads', 'viewers can list tables');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_add_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"fields": {"Name": "x"}}]')$$, (select key from keys where who = 'ivy'))) like '42501%', 'viewers cannot write');

-- ------------------------------------------------------------
-- Reading
-- ------------------------------------------------------------
select pg_temp.act_as(null);
create temp table cols as select public.api_columns((select key from keys where who = 'gina'), 'd0000000-0000-0000-0000-000000000007', 'Leads') as j;
select pg_temp.ok((select jsonb_array_length(j->'columns') from cols) = 6, 'columns are listed');
select pg_temp.ok((select c->'fields'->>'formula' from cols, jsonb_array_elements(j->'columns') c where c->>'id' = 'Score') = '$Amount * 2', 'formulas are shown');
select pg_temp.act_as(null);
create temp table recs as select public.api_records((select key from keys where who = 'gina'), 'd0000000-0000-0000-0000-000000000007', 'Leads') as j;
select pg_temp.ok((select jsonb_array_length(j->'records') from recs) = 2, 'records are listed');
select pg_temp.ok((select j->'records'->0->'fields'->>'Email' from recs) = 'ann@example.com', 'fields are keyed by column id');
select pg_temp.ok((select j->'records'->1->'fields'->'Score' from recs) = '600', 'formula values come along');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_records((select key from keys where who = 'gina'), 'd0000000-0000-0000-0000-000000000007', 'Leads', '{"Status": ["Won"]}') -> 'records' -> 0 ->> 'id' = '702', 'filter by value');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_records((select key from keys where who = 'gina'), 'd0000000-0000-0000-0000-000000000007', 'Leads', null, '-Amount', 1) -> 'records' = '[{"id": 702, "fields": {"Name": "Bob", "Email": "bob@example.com", "Ready": true, "Score": 600, "Amount": 300, "Status": "Won"}}]'::jsonb, 'sort and limit');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Nope')$$, (select key from keys where who = 'gina'))) like 'PT404%', 'unknown tables are 404');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '{"Nope": [1]}')$$, (select key from keys where who = 'gina'))) like 'PT400%', 'unknown filter columns are 400');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', null, 'x; drop table keys')$$, (select key from keys where who = 'gina'))) like 'PT400%', 'sort can''t inject SQL');

-- ------------------------------------------------------------
-- Writing
-- ------------------------------------------------------------
select pg_temp.act_as(null);
create temp table added as select public.api_add_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads',
  '[{"fields": {"Email": "cy@example.com", "Name": "Cy", "Status": "New", "Amount": 50}}]') as j;
reset role;
select pg_temp.ok((select (j->'records'->0->>'id')::bigint from added) > 702, 'adding returns the new ids');
select pg_temp.ok((select source from public.doc_actions where doc_id = 'd0000000-0000-0000-0000-000000000007' order by id desc limit 1) = 'api', 'logged as an API change');
select pg_temp.ok((select author from public.doc_actions where doc_id = 'd0000000-0000-0000-0000-000000000007' order by id desc limit 1) = '00000000-0000-0000-0000-0000000000f2', 'by the key''s owner');
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_add_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"fields": {"Score": 1}}]')$$, (select key from keys where who = 'hugo'))) like 'PT400%formula%', 'formula columns can''t be written');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_add_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"fields": {"Nope": 1}}]')$$, (select key from keys where who = 'hugo'))) like 'PT400%Unknown column%', 'unknown columns are refused');
select pg_temp.act_as(null);
select public.api_update_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"id": 701, "fields": {"Amount": 120}}]');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_update_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"id": 999999, "fields": {"Amount": 1}}]')$$, (select key from keys where who = 'hugo'))) like 'PT404%', 'updating a missing record is 404');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_upsert_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads',
  '[{"require": {"Email": "ann@example.com"}, "fields": {"Name": "Ann B"}}, {"require": {"Email": "dee@example.com"}, "fields": {"Name": "Dee", "Status": "New"}}]')
  = '{"added": 1, "updated": 1}'::jsonb, 'upsert updates matches and adds the rest');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_upsert_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads',
  '[{"require": {"Email": "zed@example.com"}, "fields": {"Name": "Zed"}}]', 'first', false, true) = '{"added": 0, "updated": 0}'::jsonb, 'noadd');
reset role;
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-000000000072' from public.doc_rows where id = 701) = 'Ann B', 'upsert changed Ann');
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-000000000071' from public.doc_rows where data->>'c0000000-0000-0000-0000-000000000072' = 'Dee') = 'dee@example.com', 'upsert added Dee with the required value');
create temp table dee as select jsonb_build_array(id) as ids from public.doc_rows where table_ref = 'a0000000-0000-0000-0000-000000000007' and data->>'c0000000-0000-0000-0000-000000000072' = 'Dee';
grant select on dee to anon;
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_delete_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', null)$$, (select key from keys where who = 'hugo'))) like 'PT400%', 'a missing id list is refused');
select pg_temp.act_as(null);
select public.api_delete_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads', (select ids from dee));
reset role;
select pg_temp.ok(not exists (select 1 from public.doc_rows where data->>'c0000000-0000-0000-0000-000000000072' = 'Dee'), 'delete removes records');
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_delete_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[1]')$$, (select key from keys where who = 'hugo'))) like 'PT404%', 'deleting a record of another table is refused');

-- Rate limit
reset role;
update public.api_keys set window_start = now(), window_count = 600 where label = 'hugo';
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_tables(%L, 'd0000000-0000-0000-0000-000000000007')$$, (select key from keys where who = 'hugo'))) like 'PT429%', 'more than 600 calls a minute are refused');
reset role;
update public.api_keys set window_count = 0 where label = 'hugo';

-- Access rules apply to API calls: non-owners don't see won leads.
insert into public.doc_access_rules (doc_id, table_ref, condition, condition_ast, permissions, position) values
  ('d0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000007', 'user.Access != "owner" and rec.Status == "Won"',
   '{"t": "and", "args": [{"t": "cmp", "op": "!=", "l": {"t": "user", "f": "Access"}, "r": {"t": "lit", "v": "owner"}},
                          {"t": "cmp", "op": "==", "l": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000073"]}, "r": {"t": "lit", "v": "Won"}}]}',
   '{"read": false, "update": false}', 1);
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(not (public.api_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads') -> 'records' @> '[{"id": 702}]'), 'rules hide records from API readers');
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err(format($$select public.api_update_records(%L, 'd0000000-0000-0000-0000-000000000007', 'Leads', '[{"id": 702, "fields": {"Amount": 1}}]')$$, (select key from keys where who = 'hugo'))) like 'PT404%', 'hidden records can''t be updated');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_upsert_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads',
  '[{"require": {"Email": "bob@example.com"}, "fields": {"Amount": 1}}]', 'first', false, true) = '{"added": 0, "updated": 0}'::jsonb, 'upsert can''t find hidden records');
select pg_temp.act_as(null);
select pg_temp.ok(public.api_records((select key from keys where who = 'gina'), 'd0000000-0000-0000-0000-000000000007', 'Leads') -> 'records' @> '[{"id": 702}]', 'the owner still sees them');
reset role;
delete from public.doc_access_rules where doc_id = 'd0000000-0000-0000-0000-000000000007';

-- ------------------------------------------------------------
-- Managing integrations
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.ok(pg_temp.err($$select public.get_integrations('d0000000-0000-0000-0000-000000000007')$$) like '42501%', 'editors can''t manage integrations');
select pg_temp.ok(pg_temp.err($$select public.save_webhook('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "url": "https://hooks.example.com/x"}')$$) like '42501%', 'editors can''t add webhooks');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok(pg_temp.err($$select public.save_webhook('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "url": "http://hooks.example.com/x"}')$$) like '%https%', 'webhooks need https');
select pg_temp.ok(pg_temp.err($$select public.save_webhook('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "url": "https://localhost/x"}')$$) like '%public internet%', 'no local addresses');
select pg_temp.ok(pg_temp.err($$select public.save_webhook('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "url": "https://169.254.169.254/latest"}')$$) like '%public internet%', 'no cloud metadata addresses');
select pg_temp.ok(pg_temp.err($$select public.save_webhook('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "url": "https://192.168.1.10/x"}')$$) like '%public internet%', 'no private networks');
create temp table ids (kind text, id uuid);
grant all on ids to authenticated;
insert into ids select 'hook', public.save_webhook('d0000000-0000-0000-0000-000000000007',
  '{"table_ref": "a0000000-0000-0000-0000-000000000007", "name": "CRM", "url": "https://hooks.example.com/crm", "events": ["add", "update"]}');
insert into ids select 'ready-hook', public.save_webhook('d0000000-0000-0000-0000-000000000007',
  '{"table_ref": "a0000000-0000-0000-0000-000000000007", "name": "Ready only", "url": "https://hooks.example.com/ready", "events": ["update"], "ready_col": "c0000000-0000-0000-0000-000000000075"}');
select pg_temp.ok(pg_temp.err($$select public.save_automation('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "actions": []}')$$) like '%between 1 and 5%', 'automations need actions');
select pg_temp.ok(pg_temp.err($$select public.save_automation('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "actions": [{"type": "webhook", "url": "https://10.1.2.3/x"}]}')$$) like '%public internet%', 'automation webhooks are checked too');
insert into ids select 'auto', public.save_automation('d0000000-0000-0000-0000-000000000007', '{
  "table_ref": "a0000000-0000-0000-0000-000000000007", "name": "Won lead", "trigger": "update",
  "watch_cols": ["c0000000-0000-0000-0000-000000000073"], "condition": "rec.Status == \"Won\"",
  "condition_ast": {"t": "cmp", "op": "==", "l": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000073"]}, "r": {"t": "lit", "v": "Won"}},
  "actions": [{"type": "email", "to": "{{Email}}, boss@example.com, not-an-email", "subject": "Won: {{ Name }}", "body": "{{Name}} is worth {{Amount}} ({{Ready}}). {{link}}"},
              {"type": "webhook", "url": "https://hooks.example.com/won"}]}');

-- ------------------------------------------------------------
-- Changes become jobs
-- ------------------------------------------------------------
reset role;
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue where kind = 'webhook' and source_id = (select id from ids where kind = 'hook')) = 1, 'a change queues the table''s webhook');
select pg_temp.ok((select count(*) from public.job_queue where source_id = (select id from ids where kind = 'ready-hook')) = 0, 'a webhook with a "ready" column waits until it is true');
select pg_temp.ok((select count(*) from public.job_queue where kind = 'automation') = 2, 'a status change to Won runs both automation actions');
select pg_temp.ok((select payload->>'event' from public.job_queue where kind = 'automation' limit 1) = 'update', 'event recorded');
select pg_temp.ok(exists (select 1 from net.calls where url = 'https://example.supabase.co/functions/v1/deliver'), 'the delivery function is woken right away');
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000072": "Ann C"}}]}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue where kind = 'automation') = 0, 'changing an unwatched column doesn''t run the automation');
select pg_temp.ok((select count(*) from public.job_queue where kind = 'webhook') = 1, 'but the webhook still sends it');
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue) = 0, 'saving the same value is not a change');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "New"}}]}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue where kind = 'automation') = 0, 'the condition must hold');
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000075": true}}]}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue where source_id = (select id from ids where kind = 'ready-hook')) = 1, 'once ready, the ready-only webhook sends');
delete from public.job_queue;
-- API changes run integrations too (an n8n flow upserting a status).
set role anon;
select pg_temp.act_as(null);
select public.api_upsert_records((select key from keys where who = 'hugo'), 'd0000000-0000-0000-0000-000000000007', 'Leads',
  '[{"require": {"Email": "ann@example.com"}, "fields": {"Status": "Won"}}]');
reset role;
select pg_temp.ok((select count(*) from public.job_queue where kind = 'automation') = 2, 'API changes run automations');
-- The worker's own fills don't.
delete from public.job_queue;
insert into public.doc_actions (doc_id, kind, undoable, source, actions, inverse) values ('d0000000-0000-0000-0000-000000000007', 'do', false, 'system',
  '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 702, "values": {"c0000000-0000-0000-0000-000000000072": "Bobby"}}]}]', '[]');
select pg_temp.ok((select count(*) from public.job_queue) = 0, 'system changes don''t trigger integrations');
select pg_temp.ok(public._touched('[{"op": "UpdateRecords", "table": "t", "records": [{"id": null, "values": {"c": 1}}]}]', '[]') = '{}'::jsonb, 'updates without a record id are ignored');

-- ------------------------------------------------------------
-- Delivery
-- ------------------------------------------------------------
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "New"}}, {"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
select pg_temp.ok(pg_temp.err($$select public.jobs_claim('sek')$$) like '42501%', 'only the delivery function may claim jobs');
reset role;
select pg_temp.ok(pg_temp.err($$select public.jobs_claim('wrong')$$) like '42501%', 'the secret is checked');
create temp table claimed as select public.jobs_claim('sek', 10) as j;
select pg_temp.ok((select jsonb_array_length(j) from claimed) = 4, 'both webhooks (Ann is ready now), the email and the automation webhook claimed: ' || (select j::text from claimed));
select pg_temp.ok((select count(*) from public.job_queue where status = 'running') = 4, 'claimed jobs are running');
select pg_temp.ok((select x->'body'->'records'->0->>'Email' from claimed, jsonb_array_elements(j) x where x->>'url' = 'https://hooks.example.com/crm') = 'ann@example.com', 'webhooks send the records by column id');
select pg_temp.ok((select x->>'secret' from claimed, jsonb_array_elements(j) x where x->>'url' = 'https://hooks.example.com/crm') = (select secret from public.doc_webhooks where id = (select id from ids where kind = 'hook')), 'with the webhook''s signing secret');
select pg_temp.ok((select x->'to' from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email') = '["ann@example.com", "boss@example.com"]'::jsonb, 'email recipients filled from the record, invalid ones dropped');
select pg_temp.ok((select x->>'subject' from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email') = 'Won: Ann C', 'subject placeholders filled');
select pg_temp.ok((select x->>'text' from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email') = 'Ann C is worth 120 (Yes). {{link}}', 'body placeholders filled, unknown ones left: ' || (select x->>'text' from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email'));
select pg_temp.ok((select x->'body'->>'event' from claimed, jsonb_array_elements(j) x where x->>'kind' = 'webhook' and x->'body' ? 'record') = 'update', 'automation webhooks say what happened');
select pg_temp.ok((select jsonb_array_length(public.jobs_claim('sek')) ) = 0, 'running jobs are not claimed twice');

-- Results: success, retry with backoff, give up.
select public.jobs_done('sek', (select (x->>'id')::bigint from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email'), null, 202);
select pg_temp.ok((select status from public.job_queue where id = (select (x->>'id')::bigint from claimed, jsonb_array_elements(j) x where x->>'kind' = 'email')) = 'done', 'success marks the job done');
create temp table hook_job as select (x->>'id')::bigint as id from claimed, jsonb_array_elements(j) x where x->>'url' = 'https://hooks.example.com/crm';
grant select on hook_job to authenticated;
select public.jobs_done('sek', (select id from hook_job), 'HTTP 500', 500);
select pg_temp.ok((select status = 'pending' and next_run_at > now() and last_status = 500 from public.job_queue where id = (select id from hook_job)), 'a failure is retried later');
update public.job_queue set attempts = 8, status = 'running' where id = (select id from hook_job);
select public.jobs_done('sek', (select id from hook_job), 'HTTP 500', 500);
select pg_temp.ok((select status from public.job_queue where id = (select id from hook_job)) = 'failed', 'after the last attempt it fails');

-- Owner tools
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok((public.get_integrations('d0000000-0000-0000-0000-000000000007') ->> 'queued')::int >= 1, 'owners see the queue');
select public.retry_job((select id from hook_job));
reset role;
select pg_temp.ok((select status from public.job_queue where id = (select id from hook_job)) = 'pending', 'failed deliveries can be retried');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.test_integration('automation', (select id from ids where kind = 'auto'));
select public.delete_integration('webhook', (select id from ids where kind = 'hook'));
reset role;
select pg_temp.ok((select count(*) from public.job_queue where payload->>'event' = 'test') = 2, 'a test run queues each action');
select pg_temp.ok((select status from public.job_queue where id = (select id from hook_job)) = 'skipped', 'removing a webhook drops its waiting deliveries');
select pg_temp.ok(not exists (select 1 from public.doc_webhooks where id = (select id from ids where kind = 'hook')), 'webhook removed');

-- Signed-out callers can't reach any of the internals.
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select count(*) from public.job_queue$$) like '42501%', 'the queue is private');
select pg_temp.ok(pg_temp.err($$select count(*) from public.doc_webhooks$$) like '42501%', 'webhooks are private');
select pg_temp.ok(pg_temp.err($$select public._api_auth('x')$$) like '42501%', 'helpers can''t be called');
select pg_temp.ok(pg_temp.err($$select public.get_integrations('d0000000-0000-0000-0000-000000000007')$$) like '42501%', 'management needs signing in');
reset role;

select 'integrations: all checks passed' as out;
