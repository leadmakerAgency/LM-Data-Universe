-- Tests for email: tags (formats, fallbacks, references, renames), previews,
-- suppressions, limits, delivery events and who may see what. Runs after
-- integrations.sql and reuses its "Integrations" document (Gina owns it).
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
-- Fixture: Leads gets formatted columns and a reference to People.
-- ------------------------------------------------------------
delete from public.job_queue;
delete from public.doc_automations;
delete from public.doc_webhooks;
insert into public.doc_tables (id, doc_id, table_id) values
  ('a0000000-0000-0000-0000-0000000000b7', 'd0000000-0000-0000-0000-000000000007', 'People');
insert into public.doc_columns (id, table_ref, col_id, label, type, options, position) values
  ('c0000000-0000-0000-0000-0000000000b1', 'a0000000-0000-0000-0000-0000000000b7', 'Name', 'Name', 'Text', '{}', 1),
  ('c0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000007', 'Due', 'Due date', 'Date', '{"dateFormat": "MMM D, YYYY"}', 11),
  ('c0000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-000000000007', 'Price', 'Price', 'Numeric', '{"numMode": "currency", "currency": "EUR"}', 12),
  ('c0000000-0000-0000-0000-0000000000a3', 'a0000000-0000-0000-0000-000000000007', 'Rate', 'Rate', 'Numeric', '{"numMode": "percent"}', 13),
  ('c0000000-0000-0000-0000-0000000000a4', 'a0000000-0000-0000-0000-000000000007', 'Owner', 'Owner', 'Ref', '{"refTable": "a0000000-0000-0000-0000-0000000000b7", "visibleCol": "c0000000-0000-0000-0000-0000000000b1"}', 14),
  ('c0000000-0000-0000-0000-0000000000a5', 'a0000000-0000-0000-0000-000000000007', 'Seen', 'Seen', 'DateTime', '{}', 15),
  ('c0000000-0000-0000-0000-0000000000a6', 'a0000000-0000-0000-0000-000000000007', 'Nickname', 'Nickname', 'Text', '{}', 16);
insert into public.doc_rows (id, table_ref, manual_sort, data) values
  (751, 'a0000000-0000-0000-0000-0000000000b7', 1, '{"c0000000-0000-0000-0000-0000000000b1": "Olga"}');
update public.doc_rows set data = '{"c0000000-0000-0000-0000-000000000071": "ann@example.com", "c0000000-0000-0000-0000-000000000072": "Ann", "c0000000-0000-0000-0000-000000000073": "New", "c0000000-0000-0000-0000-000000000074": 100, "c0000000-0000-0000-0000-0000000000a1": "2026-03-05", "c0000000-0000-0000-0000-0000000000a2": 1234.5, "c0000000-0000-0000-0000-0000000000a3": 0.256, "c0000000-0000-0000-0000-0000000000a4": 751, "c0000000-0000-0000-0000-0000000000a5": "2026-03-05T23:30:00.000Z"}'
where id = 701;
update public.doc_rows set data = '{"c0000000-0000-0000-0000-000000000071": "bob@example.com", "c0000000-0000-0000-0000-000000000072": "Bob", "c0000000-0000-0000-0000-000000000073": "New"}'
where id = 702;

-- ------------------------------------------------------------
-- Saving checks tags
-- ------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok(pg_temp.err($$select public.save_automation('d0000000-0000-0000-0000-000000000007',
  '{"table_ref": "a0000000-0000-0000-0000-000000000007", "name": "x", "actions": [{"type": "email", "to": "{{Email}}", "subject": "Hi {{Nmae}}", "body": "b"}]}')$$)
  like '%Unknown placeholder {{Nmae}}%', 'a mistyped tag is refused by name');
select pg_temp.ok(pg_temp.err($$select public.save_automation('d0000000-0000-0000-0000-000000000007',
  '{"table_ref": "a0000000-0000-0000-0000-000000000007", "name": "x", "actions": [{"type": "email", "to": "{{Email}}", "subject": "s", "body": "{{Owner.Nope}}"}]}')$$)
  like '%Unknown placeholder {{Owner.Nope}}%', 'so is an unknown field of a reference');
select pg_temp.ok(pg_temp.err($$select public.save_automation('d0000000-0000-0000-0000-000000000007',
  '{"table_ref": "a0000000-0000-0000-0000-000000000007", "name": "x", "actions": [{"type": "email", "to": "nobody", "subject": "s", "body": "b"}]}')$$)
  like '%needs an email address%', '"To" needs an address or a tag');

create temp table auto (id uuid);
grant all on auto to anon, authenticated;
insert into auto select public.save_automation('d0000000-0000-0000-0000-000000000007', $j${
  "table_ref": "a0000000-0000-0000-0000-000000000007", "name": "Mail test", "trigger": "update",
  "watch_cols": ["c0000000-0000-0000-0000-000000000073"],
  "actions": [{"type": "email", "to": "{{Email}}; boss@example.com", "cc": "cc@example.com, {{Email}}", "bcc": "", "reply_to": "sales@example.com",
               "from_name": "{{Owner.Name}} at Acme",
               "subject": "{{ Name }} owes {{Price}}",
               "body": "Hi {{Nickname|there}}, due {{Due}} ({{Rate}}), owner {{Owner.Name}}, seen {{Seen}}. {{doc}}/{{table}}/{{automation}} by {{changed_by}} {{record_link}} #{{id}}"}]}$j$::jsonb);

-- ------------------------------------------------------------
-- Preview: the same filling, nothing sent
-- ------------------------------------------------------------
create temp table pv as select public.preview_automation('d0000000-0000-0000-0000-000000000007',
  (select to_jsonb(a) from (select 'a0000000-0000-0000-0000-000000000007'::uuid as table_ref, 'Mail test' as name,
     (public.get_integrations('d0000000-0000-0000-0000-000000000007')->'automations'->0->'actions') as actions) a), 701) as p;
grant all on pv to anon, authenticated;
select pg_temp.ok((select p->'emails'->0->>'subject' from pv) = 'Ann owes EUR 1,234.50', 'currency formatted as the grid shows it: ' || (select p->'emails'->0->>'subject' from pv));
select pg_temp.ok((select p->'emails'->0->>'body' from pv)
  = 'Hi there, due Mar 5, 2026 (25.6%), owner Olga, seen 2026-03-05 23:30. Integrations/Leads/Mail test by gina@example.com {{record_link}} #701',
  'dates, percentages, references, fallbacks and document tags filled: ' || (select p->'emails'->0->>'body' from pv));
select pg_temp.ok((select p->'emails'->0->'to' from pv) = '["ann@example.com", "boss@example.com"]'::jsonb, 'recipients split on commas and semicolons');
select pg_temp.ok((select p->'emails'->0->>'from_name' from pv) = 'Olga at Acme' and (select p->'emails'->0->>'reply_to' from pv) = 'sales@example.com', 'sender name and reply-to filled');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.ok(pg_temp.err($$select public.preview_automation('d0000000-0000-0000-0000-000000000007', '{"table_ref": "a0000000-0000-0000-0000-000000000007", "actions": []}')$$) like '42501%', 'only owners preview');

-- ------------------------------------------------------------
-- Renaming a column rewrites the tags
-- ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "Update", "entity": "column", "id": "c0000000-0000-0000-0000-000000000072", "patch": {"col_id": "FullName"}}]');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "Update", "entity": "column", "id": "c0000000-0000-0000-0000-0000000000b1", "patch": {"col_id": "Person"}}]');
reset role;
select pg_temp.ok((select actions->0->>'subject' from public.doc_automations) = '{{ FullName }} owes {{Price}}', 'a renamed column is renamed in the tags: ' || (select actions->0->>'subject' from public.doc_automations));
select pg_temp.ok((select actions->0->>'body' from public.doc_automations) like '%owner {{Owner.Person}}, seen%' and (select actions->0->>'from_name' from public.doc_automations) = '{{Owner.Person}} at Acme',
  'and through references: ' || (select actions->0->>'body' from public.doc_automations));
select pg_temp.ok((select actions->0->>'body' from public.doc_automations) like 'Hi {{Nickname|there}}%', 'other tags are left alone');

-- ------------------------------------------------------------
-- Sending: escaped values, extra fields, delivery state
-- ------------------------------------------------------------
update public.doc_rows set data = data || '{"c0000000-0000-0000-0000-0000000000a6": "A*b [x](http://evil.example)"}' where id = 701;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
reset role;
create temp table c1 as select public.jobs_claim('sek', 10) -> 0 as j;
select pg_temp.ok((select j->>'kind' from c1) = 'email' and (select j->'to' from c1) = '["ann@example.com", "boss@example.com"]'::jsonb, 'the email is claimed: ' || coalesce((select j::text from c1), 'nothing'));
select pg_temp.ok((select j->'cc' from c1) = '["cc@example.com"]'::jsonb, 'CC drops addresses already in To');
select pg_temp.ok(position('Hi A\*b \[x\]\(http://evil.example\), due' in (select j->>'text' from c1)) = 1, 'values can''t add formatting or links of their own: ' || (select j->>'text' from c1));
select pg_temp.ok((select j->>'subject' from c1) = 'Ann owes EUR 1,234.50', 'the subject is plain text');
select pg_temp.ok((select (j->>'row')::int from c1) = 701 and (select j->>'automation' from c1) = 'Mail test' and (select j->>'from_name' from c1) = 'Olga at Acme', 'record, automation and sender name go to the sender');
select pg_temp.ok((select delivery from public.job_queue where id = (select (j->>'id')::bigint from c1)) = 'queued', 'a claimed email is "queued"');
select public.jobs_done('sek', (select (j->>'id')::bigint from c1), null, 202);
select pg_temp.ok((select delivery from public.job_queue where id = (select (j->>'id')::bigint from c1)) = 'sent', 'accepted by SendGrid: "sent"');

-- ------------------------------------------------------------
-- Events from SendGrid
-- ------------------------------------------------------------
select pg_temp.ok(public.mail_events_in(jsonb_build_array(
  jsonb_build_object('event', 'delivered', 'email', 'Ann@Example.com', 'sg_event_id', 'e1', 'timestamp', 1795000000, 'lmdu_env', 'lmdu', 'lmdu_job', (select j->>'id' from c1)),
  jsonb_build_object('event', 'delivered', 'email', 'x@example.com', 'sg_event_id', 'e2', 'timestamp', 1795000000),
  jsonb_build_object('event', 'open', 'email', 'ann@example.com', 'sg_event_id', 'e3', 'lmdu_env', 'lmdu'))) = 1, 'only our own delivery events are kept');
select pg_temp.ok((select delivery from public.job_queue where id = (select (j->>'id')::bigint from c1)) = 'delivered', 'the delivery log shows "delivered"');
select pg_temp.ok(public.mail_events_in(jsonb_build_array(
  jsonb_build_object('event', 'delivered', 'email', 'ann@example.com', 'sg_event_id', 'e1', 'lmdu_env', 'lmdu', 'lmdu_job', (select j->>'id' from c1)))) = 0, 'an event delivered twice counts once');
select pg_temp.ok(public.mail_events_in(jsonb_build_array(
  jsonb_build_object('event', 'bounce', 'type', 'bounce', 'email', 'boss@example.com', 'reason', '550 no such user', 'sg_event_id', 'e4', 'lmdu_env', 'lmdu', 'lmdu_job', (select j->>'id' from c1)),
  jsonb_build_object('event', 'bounce', 'type', 'blocked', 'email', 'cc@example.com', 'sg_event_id', 'e5', 'lmdu_env', 'lmdu', 'lmdu_job', (select j->>'id' from c1)),
  jsonb_build_object('event', 'deferred', 'email', 'ann@example.com', 'sg_event_id', 'e6', 'lmdu_env', 'lmdu', 'lmdu_job', (select j->>'id' from c1)))) = 3, 'bounces, blocks and deferrals recorded');
select pg_temp.ok((select delivery from public.job_queue where id = (select (j->>'id')::bigint from c1)) = 'bounced', 'a bounce outranks "delivered", a later deferral doesn''t hide it');
select pg_temp.ok((select array_agg(email order by email) from public.mail_suppressions) = array['boss@example.com'], 'hard bounces are suppressed, blocks are not');
select pg_temp.ok((select detail from public.mail_suppressions) = '550 no such user', 'with the reason');

-- Suppressed addresses are left out; when nobody is left, nothing is sent.
update public.job_queue set started_at = now() - interval '2 minutes';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "New"}}]}]');
reset role;
create temp table c2 as select public.jobs_claim('sek', 10) -> 0 as j;
select pg_temp.ok((select j->'to' from c2) = '["ann@example.com"]'::jsonb, 'a bounced address is dropped from later emails: ' || coalesce((select j::text from c2), 'nothing'));
select public.jobs_done('sek', (select (j->>'id')::bigint from c2), 'SendGrid 403: sender not verified', 403, false);
select pg_temp.ok((select status || '/' || delivery from public.job_queue where id = (select (j->>'id')::bigint from c2)) = 'failed/failed', 'errors that won''t get better aren''t retried');
insert into public.mail_suppressions (email, reason) values ('ann@example.com', 'spam');
update public.job_queue set started_at = now() - interval '2 minutes';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
reset role;
select pg_temp.ok(jsonb_array_length(public.jobs_claim('sek', 10)) = 0, 'nobody left to write to: nothing is sent');
select pg_temp.ok((select last_error from public.job_queue order by id desc limit 1) like 'Not sent: %bounced or reported spam before', 'and the log says why: ' || (select last_error from public.job_queue order by id desc limit 1));
delete from public.mail_suppressions;

-- ------------------------------------------------------------
-- Limits
-- ------------------------------------------------------------
delete from public.job_queue;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 702, "values": {"c0000000-0000-0000-0000-000000000073": "Won"}}]}]');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 702, "values": {"c0000000-0000-0000-0000-000000000073": "New"}}]}]');
reset role;
select pg_temp.ok(jsonb_array_length(public.jobs_claim('sek', 10)) = 1, 'two changes to one record within a minute send one email');
select pg_temp.ok((select last_error from public.job_queue where status = 'skipped') = 'Already sent for this record in the last minute', 'the second is skipped with the reason');
update public.plans set max_emails_per_day = 1 where id = 'free';
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.apply_actions('d0000000-0000-0000-0000-000000000007', '[{"op": "UpdateRecords", "table": "a0000000-0000-0000-0000-000000000007", "records": [{"id": 701, "values": {"c0000000-0000-0000-0000-000000000073": "New"}}]}]');
reset role;
select pg_temp.ok(jsonb_array_length(public.jobs_claim('sek', 10)) = 0, 'over the plan''s daily limit nothing more is sent');
select pg_temp.ok((select last_error from public.job_queue order by id desc limit 1) = 'Daily email limit reached (1 a day on this plan)', 'with the reason: ' || (select last_error from public.job_queue order by id desc limit 1));
-- "Send test" is exempt from both.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.test_integration('automation', (select id from auto));
reset role;
select pg_temp.ok((select (public.jobs_claim('sek', 10)->0->>'test')::boolean), 'tests go out regardless of limits');
update public.plans set max_emails_per_day = 100 where id = 'free';

-- ------------------------------------------------------------
-- Status and who may see what
-- ------------------------------------------------------------
select pg_temp.ok(pg_temp.err($$select public.mail_report('wrong', true, 'a@b.c', 'https://app.example.com', null)$$) like '42501%', 'only the senders report status');
select public.mail_report('sek', true, 'noreply@mail.example.com', 'https://app.example.com', null);
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.ok((public.email_status()->>'configured')::boolean and public.email_status()->>'from' = 'noreply@mail.example.com', 'anyone signed in can see whether email works');
select pg_temp.ok(not (public.email_status() ? 'error'), 'but not the error text');
select pg_temp.ok(pg_temp.err($$select count(*) from public.mail_events$$) like '42501%', 'events are private');
select pg_temp.ok(pg_temp.err($$select count(*) from public.mail_suppressions$$) like '42501%', 'the bounce list is private');
select pg_temp.ok(pg_temp.err($$select count(*) from public.mail_config$$) like '42501%', 'the settings row is private');
select pg_temp.ok(pg_temp.err($$select public.mail_events_in('[]')$$) like '42501%', 'events can''t be injected');
select pg_temp.ok(pg_temp.err($$select public.admin_mail()$$) like '42501%', 'the mail overview is for administrators');
select pg_temp.ok(pg_temp.err($$select public.admin_test_email()$$) like '42501%', 'so is the test email');
select pg_temp.ok(pg_temp.err($$select public._fill_template('x', 'a0000000-0000-0000-0000-000000000007', '{}')$$) like '42501%', 'helpers can''t be called');
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select public.email_status()$$) like '42501%', 'status needs signing in');
reset role;
insert into public.app_admins (user_id) values ('00000000-0000-0000-0000-0000000000f1') on conflict do nothing;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok(public.admin_test_email() = 'gina@example.com', 'administrators queue a test email to themselves');
select pg_temp.ok((public.admin_mail()->'waiting'->>'notices')::int >= 1 and public.admin_mail()->'status' ? 'error', 'and see the overview');
reset role;
select pg_temp.ok(exists (select 1 from public.notification_queue where kind = 'test' and to_email = 'gina@example.com'), 'the test is in the queue');
delete from public.notification_queue where kind = 'test';
delete from public.app_admins where user_id = '00000000-0000-0000-0000-0000000000f1';
delete from public.job_queue;

select 'mail: all checks passed' as out;
