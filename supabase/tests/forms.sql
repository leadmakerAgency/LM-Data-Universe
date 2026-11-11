-- Tests for public forms (Phase 4): layout, value checks, reference
-- choices, file uploads, rate limits, the honeypot, access rules, and what
-- signed-out visitors can and can't reach. Same harness as access_rules.sql.
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
  perform set_config('request.headers', '{}', false);
end $$;
create or replace function pg_temp.from_ip(p_ip text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-forwarded-for', p_ip || ', 10.0.0.1')::text, false);
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ------------------------------------------------------------
-- Fixture
-- ------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'erin@example.com', now()),   -- owner
  ('00000000-0000-0000-0000-0000000000e2', 'frank@example.com', now());  -- viewer
insert into public.documents (id, workspace_id, name, created_by)
select 'd0000000-0000-0000-0000-000000000005', w.id, 'Forms', w.owner_id
from public.workspaces w where w.owner_id = '00000000-0000-0000-0000-0000000000e1';
insert into public.document_members (doc_id, user_id, role) values
  ('d0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000e2', 'viewer');
insert into public.doc_tables (id, doc_id, table_id) values
  ('a0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005', 'Events'),
  ('a0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000005', 'Clients');
insert into public.doc_columns (id, table_ref, col_id, label, type, options, is_formula, formula) values
  ('c0000000-0000-0000-0000-000000000051', 'a0000000-0000-0000-0000-000000000005', 'Name', 'Name', 'Text', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000052', 'a0000000-0000-0000-0000-000000000005', 'When', 'When', 'Date', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000053', 'a0000000-0000-0000-0000-000000000005', 'Hours', 'Hours', 'Numeric', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000054', 'a0000000-0000-0000-0000-000000000005', 'Count', 'Count', 'Int', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000055', 'a0000000-0000-0000-0000-000000000005', 'Kind', 'Kind', 'Choice', '{"choices": ["A", "B"]}', false, ''),
  ('c0000000-0000-0000-0000-000000000056', 'a0000000-0000-0000-0000-000000000005', 'Tags', 'Tags', 'ChoiceList', '{"choices": ["x", "y"]}', false, ''),
  ('c0000000-0000-0000-0000-000000000057', 'a0000000-0000-0000-0000-000000000005', 'Client', 'Client', 'Ref',
   '{"refTable": "a0000000-0000-0000-0000-000000000006", "visibleCol": "c0000000-0000-0000-0000-000000000061"}', false, ''),
  ('c0000000-0000-0000-0000-000000000058', 'a0000000-0000-0000-0000-000000000005', 'Files', 'Files', 'Attachments', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000059', 'a0000000-0000-0000-0000-000000000005', 'Done', 'Done', 'Bool', '{}', false, ''),
  ('c0000000-0000-0000-0000-00000000005a', 'a0000000-0000-0000-0000-000000000005', 'Calc', 'Calc', 'Numeric', '{}', true, '$Hours * 2'),
  ('c0000000-0000-0000-0000-00000000005b', 'a0000000-0000-0000-0000-000000000005', 'At', 'At', 'DateTime', '{}', false, ''),
  ('c0000000-0000-0000-0000-000000000061', 'a0000000-0000-0000-0000-000000000006', 'Name', 'Name', 'Text', '{}', false, '');
insert into public.doc_rows (id, table_ref, manual_sort, data) values
  (61, 'a0000000-0000-0000-0000-000000000006', 1, '{"c0000000-0000-0000-0000-000000000061": "Acme"}'),
  (62, 'a0000000-0000-0000-0000-000000000006', 2, '{"c0000000-0000-0000-0000-000000000061": "Hidden Co"}');
insert into public.doc_pages (id, doc_id, name) values
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005', 'Intake');
insert into public.doc_widgets (id, page_id, table_ref, type, options) values
  ('b0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'form',
   '{"formTitle": "Book", "redirectUrl": "javascript:alert(1)", "formItems": [
      {"kind": "heading", "text": "About you"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000051", "required": true, "width": "half"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000055", "display": "radio", "width": "half"},
      {"kind": "separator"},
      {"kind": "text", "text": "**Details**"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000052"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000053"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000054"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000056"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000057"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000058"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-000000000059"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-00000000005a"},
      {"kind": "field", "col": "c0000000-0000-0000-0000-00000000005b"},
      {"kind": "field", "col": "not-a-uuid"}
   ]}'),
  ('b0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'calendar', '{}');
insert into public.form_shares (widget_id, token) values ('b0000000-0000-0000-0000-000000000005', 'tok-forms');
select pg_temp.ok((select count(*) from public.doc_widgets where type = 'calendar') = 1, 'calendar widgets can be stored');
select pg_temp.ok(pg_temp.err($$insert into public.doc_widgets (page_id, type) values ('e0000000-0000-0000-0000-000000000005', 'iframe')$$) like '23514%', 'unknown widget types are refused');

-- ------------------------------------------------------------
-- What a signed-out visitor sees
-- ------------------------------------------------------------
set role anon;
select pg_temp.act_as(null);
create temp table f as select public.get_public_form('tok-forms') as j;
grant select on f to anon;
select pg_temp.ok((select jsonb_array_length(j->'items') from f) = 13, 'heading, separator, text and 10 fields (formula and unknown columns dropped)');
select pg_temp.ok((select j->'items'->0->>'kind' from f) = 'heading', 'items keep their order');
select pg_temp.ok((select j->'items'->1->>'width' from f) = 'half' and (select (j->'items'->1->>'required')::boolean from f), 'width and required are passed on');
select pg_temp.ok(not exists (select 1 from f, jsonb_array_elements(j->'items') i where i->>'id' = 'c0000000-0000-0000-0000-00000000005a'), 'formula columns are not on the form');
select pg_temp.ok((select i->'choices' from f, jsonb_array_elements(j->'items') i where i->>'type' = 'Ref')
                  = '[{"id": 61, "label": "Acme"}, {"id": 62, "label": "Hidden Co"}]'::jsonb, 'reference picker lists the target records');
select pg_temp.ok(not exists (select 1 from f, jsonb_array_elements(j->'items') i where i->'options' ? 'refTable'), 'table ids are not exposed');
select pg_temp.ok((select j->>'redirectUrl' from f) = '', 'only http(s) redirects are passed on');
select pg_temp.ok((select jsonb_array_length(j->'fields') from f) = 8, 'the older field list leaves out reference and file fields');
select pg_temp.ok(public.get_public_form('nope') is null, 'unknown tokens show nothing');

-- ------------------------------------------------------------
-- Value checks
-- ------------------------------------------------------------
select pg_temp.from_ip('9.9.9.1');
select pg_temp.ok(public.submit_form('tok-forms', '{}') ->> 'error' like '%Name%required%', 'required fields are enforced');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "  "}') ->> 'error' like '%required%', 'blank text counts as missing');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000053": "abc"}') ->> 'error' like '%number%', 'numbers are checked');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000054": 1.5}') ->> 'error' like '%whole number%', 'integers are checked');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000055": "Z"}') ->> 'error' like '%listed options%', 'choices are checked');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000056": ["x", "nope"]}') ->> 'error' like '%listed options%', 'choice lists are checked');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000052": "2026-02-31"}') ->> 'error' like '%real date%', 'dates are checked');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000057": 999}') ->> 'error' like '%listed records%', 'references must point at a listed record');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": {"x": 1}}') ->> 'error' like '%text%', 'objects are not text');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000059": "yes"}') ->> 'error' like '%yes or no%', 'toggles take true or false');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "a", "c0000000-0000-0000-0000-000000000058": ["f0000000-0000-0000-0000-000000000001"]}') ->> 'error' like '%missing%', 'existing attachments of the document can''t be claimed');
select pg_temp.ok(public.submit_form('tok-forms', '[1]') ->> 'ok' = 'false', 'a response must be an object');
reset role;
select pg_temp.ok((select count(*) from public.doc_rows where table_ref = 'a0000000-0000-0000-0000-000000000005') = 0, 'refused responses add nothing');
select pg_temp.ok((select count(*) from public.form_submissions_log where outcome = 'invalid') = 11, 'refusals are logged');

-- ------------------------------------------------------------
-- File uploads
-- ------------------------------------------------------------
set role anon;
select pg_temp.act_as(null);
select pg_temp.from_ip('9.9.9.1');
select pg_temp.ok(pg_temp.err($$select public.form_upload_start('tok-forms', 'c0000000-0000-0000-0000-000000000051', 'a.txt', 5, 'text/plain')$$) like '%no such file field%', 'uploads only go to file fields');
select pg_temp.ok(pg_temp.err($$select public.form_upload_start('tok-forms', 'c0000000-0000-0000-0000-000000000058', 'a.txt', 20000000, 'text/plain')$$) like '%10 MB%', 'upload size is limited');
create temp table up as select public.form_upload_start('tok-forms', 'c0000000-0000-0000-0000-000000000058', '../../evil name?.txt', 5, 'text/plain') as j;
grant select on up to anon;
select pg_temp.ok((select j->>'path' from up) = 'd0000000-0000-0000-0000-000000000005/' || (select j->>'id' from up) || '/.._.._evil name_.txt', 'file names are made safe');
select pg_temp.ok(pg_temp.err($$insert into storage.objects (bucket_id, name, metadata) values ('attachments', 'd0000000-0000-0000-0000-000000000005/x/y.txt', '{}')$$) like '42501%', 'visitors can''t upload anywhere else');
select pg_temp.ok(pg_temp.err(format($$insert into storage.objects (bucket_id, name, metadata) values ('attachments', %L, '{"size": 5, "mimetype": "text/plain"}')$$, (select j->>'path' from up))) = '', 'visitors can upload to the issued path');
select pg_temp.ok(pg_temp.err($$select count(*) from public.form_uploads$$) like '42501%', 'upload slots are not readable');

-- ------------------------------------------------------------
-- A full response
-- ------------------------------------------------------------
create temp table res as select public.submit_form('tok-forms', jsonb_build_object(
  'c0000000-0000-0000-0000-000000000051', 'Ann',
  'c0000000-0000-0000-0000-000000000052', '2026-11-20',
  'c0000000-0000-0000-0000-000000000053', '2.5',
  'c0000000-0000-0000-0000-000000000054', 3,
  'c0000000-0000-0000-0000-000000000055', 'A',
  'c0000000-0000-0000-0000-000000000056', '["x", "y"]'::jsonb,
  'c0000000-0000-0000-0000-000000000057', '61',
  'c0000000-0000-0000-0000-000000000058', jsonb_build_array((select j->>'id' from up)),
  'c0000000-0000-0000-0000-000000000059', true,
  'c0000000-0000-0000-0000-00000000005b', '2026-11-20T10:30:00+02:00',
  'c0000000-0000-0000-0000-00000000005a', 99,
  'c0000000-0000-0000-0000-000000000099', 'not on the form')) as j;
grant select on res to anon;
select pg_temp.ok((select (j->>'ok')::boolean from res), 'a valid response is accepted: ' || (select j::text from res));
reset role;
create temp table rec as select data from public.doc_rows where id = (select (j->>'row')::bigint from res);
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-000000000051' from rec) = 'Ann', 'text saved');
select pg_temp.ok((select data->'c0000000-0000-0000-0000-000000000053' from rec) = '2.5'::jsonb, 'number text becomes a number');
select pg_temp.ok((select data->'c0000000-0000-0000-0000-000000000057' from rec) = '61'::jsonb, 'reference saved as a record id');
select pg_temp.ok((select data->>'c0000000-0000-0000-0000-00000000005b' from rec) = '2026-11-20T08:30:00.000Z', 'date-times are stored in UTC');
select pg_temp.ok(not (select data ? 'c0000000-0000-0000-0000-00000000005a' from rec), 'formula columns are never written');
select pg_temp.ok(not (select data ? 'c0000000-0000-0000-0000-000000000099' from rec), 'values for columns not on the form are ignored');
select pg_temp.ok((select data->'c0000000-0000-0000-0000-000000000058' from rec) = jsonb_build_array((select j->>'id' from up)), 'the upload becomes the cell''s attachment');
select pg_temp.ok(exists (select 1 from public.doc_attachments where id = (select (j->>'id')::uuid from up) and created_by is null and size = 5), 'attachment recorded');
select pg_temp.ok((select source from public.doc_actions where doc_id = 'd0000000-0000-0000-0000-000000000005' order by id desc limit 1) = 'form', 'logged as a form action (so trigger formulas run)');
set role anon;
select pg_temp.act_as(null);
select pg_temp.from_ip('9.9.9.1');
select pg_temp.ok(public.submit_form('tok-forms', jsonb_build_object('c0000000-0000-0000-0000-000000000051', 'Again',
  'c0000000-0000-0000-0000-000000000058', jsonb_build_array((select j->>'id' from up)))) ->> 'error' like '%missing%', 'an upload can only be used once');
select pg_temp.ok(pg_temp.err(format($$insert into storage.objects (bucket_id, name, metadata) values ('attachments', %L || '2', '{}')$$, (select j->>'path' from up))) like '42501%', 'a used upload path opens nothing else');

-- ------------------------------------------------------------
-- Honeypot and rate limits
-- ------------------------------------------------------------
select pg_temp.ok((public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "bot"}', '{"hp": "http://spam"}') ->> 'ok')::boolean, 'honeypot answers like a success');
select pg_temp.from_ip('7.7.7.7');
select public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "r"}') from generate_series(1, 5);
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "r"}') ->> 'error' like 'Too many%', 'a 6th response within a minute is refused');
select pg_temp.from_ip('7.7.7.8');
select pg_temp.ok((public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "s"}') ->> 'ok')::boolean, 'other visitors are not affected');
reset role;
select pg_temp.ok((select count(*) from public.doc_rows where table_ref = 'a0000000-0000-0000-0000-000000000005') = 7, 'one + five + one responses saved, the bot''s not');
select pg_temp.ok(not exists (select 1 from public.doc_rows where data::text like '%bot%'), 'honeypot responses are dropped');
select pg_temp.ok((select count(*) from public.form_submissions_log where outcome = 'rate_limited') = 1, 'rate limiting is logged');
select pg_temp.ok(not exists (select 1 from public.form_submissions_log where client_hash like '%7.7.7%'), 'addresses are stored only as hashes');

-- ------------------------------------------------------------
-- Visitors can't reach the internals
-- ------------------------------------------------------------
set role anon;
select pg_temp.act_as(null);
select pg_temp.ok(pg_temp.err($$select count(*) from public.form_submissions_log$$) like '42501%', 'the log is not readable');
select pg_temp.ok(pg_temp.err($$select public._form_ref_choices('d0000000-0000-0000-0000-000000000001', c) from public.doc_columns c limit 1$$) like '42501%', 'helpers can''t be called directly');
select pg_temp.ok(pg_temp.err($$select public._form_cleanup()$$) like '42501%', 'cleanup can''t be called');
select pg_temp.ok(pg_temp.err($$select public.form_stats('b0000000-0000-0000-0000-000000000005')$$) like '42501%', 'visitors get no statistics');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok(pg_temp.err($$select public.form_stats('b0000000-0000-0000-0000-000000000005')$$) like 'P0002%', 'viewers get no statistics');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.form_stats('b0000000-0000-0000-0000-000000000005') ->> 'ok_7d')::int = 7, 'owners see how the form is doing');
select pg_temp.ok((public.form_stats('b0000000-0000-0000-0000-000000000005') -> 'last_refusal' ->> 'outcome') = 'rate_limited', 'and the latest refusal');

-- ------------------------------------------------------------
-- Documents with access rules
--   Clients: "Hidden Co" can't be read.
--   Events: signed-out people can't add events of kind B.
-- ------------------------------------------------------------
reset role;
insert into public.doc_access_rules (doc_id, table_ref, condition, condition_ast, permissions, position) values
  ('d0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000006', 'rec.Name == "Hidden Co"',
   '{"t": "cmp", "op": "==", "l": {"t": "rec", "which": "rec", "path": ["c0000000-0000-0000-0000-000000000061"]}, "r": {"t": "lit", "v": "Hidden Co"}}',
   '{"read": false}', 1),
  ('d0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'not user.IsLoggedIn and newRec.Kind == "B"',
   '{"t": "and", "args": [{"t": "not", "arg": {"t": "user", "f": "IsLoggedIn"}},
                          {"t": "cmp", "op": "==", "l": {"t": "rec", "which": "newRec", "path": ["c0000000-0000-0000-0000-000000000055"]}, "r": {"t": "lit", "v": "B"}}]}',
   '{"create": false}', 2);
set role anon;
select pg_temp.act_as(null);
select pg_temp.from_ip('5.5.5.5');
select pg_temp.ok((select i->'choices' from jsonb_array_elements(public.get_public_form('tok-forms')->'items') i where i->>'type' = 'Ref')
                  = '[{"id": 61, "label": "Acme"}]'::jsonb, 'reference picker leaves out records a signed-out viewer can''t read');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "x", "c0000000-0000-0000-0000-000000000057": 62}') ->> 'error' like '%listed records%', 'and refuses them on submit');
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "x", "c0000000-0000-0000-0000-000000000055": "B"}') ->> 'error' = 'This form can''t accept responses right now.', 'create rules apply to form responses');
select pg_temp.ok((public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "x", "c0000000-0000-0000-0000-000000000055": "A"}') ->> 'ok')::boolean, 'allowed responses still go through');
reset role;
select pg_temp.ok((select detail from public.form_submissions_log where outcome = 'invalid' order by id desc limit 1) like '%permission%', 'the log keeps the real reason for owners');

-- ------------------------------------------------------------
-- Older page and closed forms
-- ------------------------------------------------------------
set role anon;
select pg_temp.act_as(null);
select pg_temp.from_ip('5.5.5.6');
select pg_temp.ok(public.submit_public_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "old page", "c0000000-0000-0000-0000-000000000055": "A"}'), 'the older submit call still works');
select pg_temp.ok(pg_temp.err($$select public.submit_public_form('tok-forms', '{}')$$) like '%required%', 'and still reports problems');
reset role;
update public.form_shares set is_active = false where token = 'tok-forms';
set role anon;
select pg_temp.ok(public.submit_form('tok-forms', '{"c0000000-0000-0000-0000-000000000051": "late"}') ->> 'error' like '%not accepting%', 'closed forms refuse responses');
select pg_temp.ok(pg_temp.err($$select public.form_upload_start('tok-forms', 'c0000000-0000-0000-0000-000000000058', 'a.txt', 5, 'text/plain')$$) like '%not accepting%', 'and uploads');
reset role;

select 'forms: all checks passed' as out;
