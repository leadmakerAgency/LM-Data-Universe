-- Tests for invoices: settings, drafts, the issue checklist, numbering, totals,
-- immutability, payments, credit notes, voiding, quotes, sending and the
-- online page. Runs after integrations.sql (its people): Gina (f1) owns her
-- workspace, Hugo (f2) edits it, Ivy (f3) views it, Jo (f4) is an outsider.
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

create temp table k (k text primary key, v text);
grant all on k to anon, authenticated;
insert into public.workspaces (id, name, owner_id) values ('a0000000-0000-0000-0000-0000000000c1', 'Agency', '00000000-0000-0000-0000-0000000000f1');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('a0000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f2', 'editor'),
  ('a0000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f3', 'viewer');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
insert into k select 'hub', public.ensure_hub('a0000000-0000-0000-0000-0000000000c1')->>'id';
select pg_temp.ok(pg_temp.err($$insert into public.invoice_profiles (doc_id) values ('d0000000-0000-0000-0000-000000000007')$$) <> '', 'invoice data only lives in a hub');

-- Settings (owner)
insert into public.invoice_profiles (doc_id, name, legal_name, address, country, vat_id, iban, terms_days, is_default)
values ((select v::uuid from k where k = 'hub'), 'Agency', 'Agency d.o.o.', 'Main street 1, Ljubljana', 'SI', 'SI12345678', 'SI56 1234 5678 9012 345', 30, true)
;
insert into k values ('profile', (select id::text from public.invoice_profiles limit 1));
insert into public.invoice_tax_rates (doc_id, name, rate, category) values ((select v::uuid from k where k = 'hub'), 'Standard 22%', 22, 'S'), ((select v::uuid from k where k = 'hub'), 'Reduced 9.5%', 9.5, 'S');
insert into public.invoice_tax_rates (doc_id, name, rate, category, note) values ((select v::uuid from k where k = 'hub'), 'Reverse charge', 0, 'AE', 'Reverse charge - Article 196 Directive 2006/112/EC');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select pg_temp.ok(pg_temp.err($$update public.invoice_profiles set name = 'Hacked'$$) = '' and (select name from public.invoice_profiles limit 1) = 'Agency', 'editors can''t change the business profile');

-- A draft (editor)
insert into public.invoices (doc_id, profile_id, client_row, bill_name, currency, discount_pct)
values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'profile'), 1, 'Acme Ltd', 'EUR', 5);
insert into k select 'inv', id::text from public.invoices limit 1;
insert into public.invoice_lines (invoice_id, position, description, quantity, unit_price, discount_pct, tax_rate, tax_category) values
  ((select v::uuid from k where k = 'inv'), 1, 'Strategy', 3, 33.3333, 0, 22, 'S'),
  ((select v::uuid from k where k = 'inv'), 2, 'Design days', 2.5, 80, 10, 22, 'S'),
  ((select v::uuid from k where k = 'inv'), 3, 'Printed report', 1, 50, 0, 9.5, 'S');
select pg_temp.ok((select doc_id::text from public.invoice_lines limit 1) = (select v from k where k = 'hub'), 'lines take the invoice''s document');
select pg_temp.ok(pg_temp.err($$insert into public.invoices (doc_id, status, number) values ((select v::uuid from k where k = 'hub'), 'issued', 'X-1')$$) like '42501%', 'invoices can''t be inserted as issued');
select pg_temp.ok(pg_temp.err($$update public.invoices set number = '2026-9999'$$) like '42501%', 'numbers come from issuing');
select pg_temp.ok(array_to_string(public.invoice_problems((select v::uuid from k where k = 'inv')), '|') = 'The client''s address is missing', 'the checklist names what is missing: ' || array_to_string(public.invoice_problems((select v::uuid from k where k = 'inv')), '|'));
select pg_temp.ok(pg_temp.err($$select public.invoice_issue((select v::uuid from k where k = 'inv'))$$) like '22023%address%', 'an incomplete invoice can''t be issued');
update public.invoices set bill_address = 'Elm street 5, London', issue_date = '2026-03-10';

-- Issue
select public.invoice_issue((select v::uuid from k where k = 'inv'));
select pg_temp.ok((select number from public.invoices where id = (select v::uuid from k where k = 'inv')) = '2026-0001', 'numbered from the series');
select pg_temp.ok((select subtotal = 330.00 and discount_total = 16.50 and tax_total = 63.03 and total = 376.53 from public.invoices where id = (select v::uuid from k where k = 'inv')),
  'totals per rate with an invoice discount: ' || (select subtotal || '/' || discount_total || '/' || tax_total || '/' || total from public.invoices where id = (select v::uuid from k where k = 'inv')));
select pg_temp.ok((select tax_breakdown->0->>'base' = '266.00' and tax_breakdown->0->>'tax' = '58.52' and tax_breakdown->1->>'tax' = '4.51' from public.invoices where id = (select v::uuid from k where k = 'inv')), 'tax shown per rate');
select pg_temp.ok((select due_date = '2026-04-09' and seller->>'vat_id' = 'SI12345678' and length(public_token) = 48 from public.invoices where id = (select v::uuid from k where k = 'inv')), 'due date from the terms, seller copied, a link token made');
select pg_temp.ok(pg_temp.err($$update public.invoices set bill_name = 'Other' where id = (select v::uuid from k where k = 'inv')$$) like '42501%', 'an issued invoice can''t be changed');
select pg_temp.ok(pg_temp.err($$update public.invoice_lines set unit_price = 1$$) like '42501%', 'nor its lines');
select pg_temp.ok(pg_temp.err($$delete from public.invoices where id = (select v::uuid from k where k = 'inv')$$) like '42501%', 'nor deleted');
select public.invoice_attach_files((select v::uuid from k where k = 'inv'), (select v from k where k = 'hub') || '/' || (select v from k where k = 'inv') || '/2026-0001.pdf', repeat('ab', 32), null);
select pg_temp.ok(pg_temp.err($$select public.invoice_attach_files((select v::uuid from k where k = 'inv'), 'x/y.pdf', repeat('ab', 32), null)$$) <> '', 'the PDF is stored once, in the invoice''s folder');

-- A second invoice gets the next number; a new year starts again.
insert into public.invoices (doc_id, profile_id, bill_name, bill_address, issue_date) values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'profile'), 'Beta', 'Somewhere 2', '2026-05-01');
insert into k select 'inv2', id::text from public.invoices where bill_name = 'Beta';
insert into public.invoice_lines (invoice_id, description, quantity, unit_price, tax_rate) values ((select v::uuid from k where k = 'inv2'), 'Work', 1, 100, 22);
select public.invoice_issue((select v::uuid from k where k = 'inv2'));
select pg_temp.ok((select number from public.invoices where id = (select v::uuid from k where k = 'inv2')) = '2026-0002', 'the next number');
insert into public.invoices (doc_id, profile_id, bill_name, bill_address, issue_date) values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'profile'), 'Gamma', 'Road 3', '2027-01-02');
insert into public.invoice_lines (invoice_id, description, quantity, unit_price, tax_rate) select id, 'Work', 1, 10, 22 from public.invoices where bill_name = 'Gamma';
select public.invoice_issue((select id from public.invoices where bill_name = 'Gamma'));
select pg_temp.ok((select number from public.invoices where bill_name = 'Gamma') = '2027-0001', 'numbering restarts with the year');

-- Reverse charge needs the client's VAT number.
insert into public.invoices (doc_id, profile_id, bill_name, bill_address) values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'profile'), 'EU Client', 'Berlin');
insert into public.invoice_lines (invoice_id, description, quantity, unit_price, tax_rate, tax_category, tax_note) select id, 'Consulting', 1, 500, 0, 'AE', 'Reverse charge' from public.invoices where bill_name = 'EU Client';
select pg_temp.ok(array_to_string(public.invoice_problems((select id from public.invoices where bill_name = 'EU Client')), '|') like '%client''s VAT number%', 'reverse charge asks for the client''s VAT number');

-- Payments
select public.invoice_record_payment((select v::uuid from k where k = 'inv'), '2026-03-20', 200, 'bank transfer', 'TRX1', '');
select pg_temp.ok((select status = 'issued' and paid_amount = 200 from public.invoices where id = (select v::uuid from k where k = 'inv')), 'a partial payment keeps it open');
select public.invoice_record_payment((select v::uuid from k where k = 'inv'), '2026-03-25', 176.53, 'card');
select pg_temp.ok((select status = 'paid' and paid_at is not null from public.invoices where id = (select v::uuid from k where k = 'inv')), 'paid in full');
select public.invoice_delete_payment((select id from public.invoice_payments where reference = 'TRX1'));
select pg_temp.ok((select status = 'issued' and paid_amount = 176.53 and paid_at is null from public.invoices where id = (select v::uuid from k where k = 'inv')), 'removing a payment reopens it');
select pg_temp.ok(pg_temp.err($$insert into public.invoice_payments (invoice_id, amount) values ((select v::uuid from k where k = 'inv'), 1)$$) like '42501%', 'payments only through the function');

-- Credit note and void
insert into k select 'cn', public.invoice_credit_note((select v::uuid from k where k = 'inv2'))::text;
select pg_temp.ok((select kind = 'credit_note' and status = 'draft' and credit_of = (select v::uuid from k where k = 'inv2') and total = -122 from public.invoices where id = (select v::uuid from k where k = 'cn')), 'a credit note copies the lines negated');
select public.invoice_issue((select v::uuid from k where k = 'cn'));
select pg_temp.ok((select number from public.invoices where id = (select v::uuid from k where k = 'cn')) = 'CN-2026-0001' or (select number from public.invoices where id = (select v::uuid from k where k = 'cn')) like 'CN-%-0001', 'credit notes have their own series');
select pg_temp.ok((select status = 'paid' and credited_amount = 122 from public.invoices where id = (select v::uuid from k where k = 'inv2')), 'fully credited invoices are settled');
select pg_temp.ok(pg_temp.err($$select public.invoice_void((select v::uuid from k where k = 'inv'), 'mistake')$$) like '%payments%', 'invoices with payments can''t be voided');
select public.invoice_void((select id from public.invoices where bill_name = 'Gamma'), 'Sent to the wrong client');
select pg_temp.ok((select status = 'void' and public_token is null from public.invoices where bill_name = 'Gamma'), 'voided, and its link no longer works');

-- Quotes become invoices
insert into public.invoices (doc_id, profile_id, kind, bill_name) values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'profile'), 'quote', 'Prospect');
insert into public.invoice_lines (invoice_id, description, quantity, unit_price, tax_rate) select id, 'Proposal', 1, 1000, 22 from public.invoices where bill_name = 'Prospect';
select public.invoice_issue((select id from public.invoices where bill_name = 'Prospect'));
insert into k select 'fromq', public.invoice_from_quote((select id from public.invoices where bill_name = 'Prospect'))::text;
select pg_temp.ok((select status from public.invoices where bill_name = 'Prospect' and kind = 'quote') = 'accepted' and (select kind = 'invoice' and status = 'draft' and total = 1220 from public.invoices where id = (select v::uuid from k where k = 'fromq')), 'an accepted quote becomes a draft invoice');

-- Sending and the online page
select pg_temp.ok(pg_temp.err($$select public.invoice_send((select v::uuid from k where k = 'inv2'), array['x@example.com'], '{}', '{}', 's', 'b', true, false)$$) like '%PDF%', 'sending needs the stored PDF');
select public.invoice_send((select v::uuid from k where k = 'inv'), array['Acme@Example.com', 'nope'], array['cc@example.com'], '{}', 'Invoice {{number}}', 'Total {{total}} due {{due_date}}', true, false);
reset role;
select pg_temp.ok((select payload->>'subject' = 'Invoice 2026-0001' and payload->'to' = '["acme@example.com"]'::jsonb and payload->>'text' like 'Total EUR 376.53 due 09 Apr 2026%' and payload->>'pdf' like '%2026-0001.pdf'
  from public.notification_queue where kind = 'invoice'), 'the email is queued with tags filled: ' || (select payload::text from public.notification_queue where kind = 'invoice'));
update public.notification_queue set sent_at = now() where kind = 'invoice';
select pg_temp.ok((select sent_at is not null from public.invoices where id = (select v::uuid from k where k = 'inv')), 'marked sent once it has gone');
set role anon;
select pg_temp.act_as(null);
reset role;
insert into k select 'token', public_token from public.invoices where id = (select v::uuid from k where k = 'inv');
set role anon;
select pg_temp.ok((public.invoice_public((select v from k where k = 'token'))->>'number') = '2026-0001', 'the online page shows the invoice by its token');
select pg_temp.ok(not (public.invoice_public((select v from k where k = 'token')) ? 'pdf_path') and jsonb_array_length(public.invoice_public((select v from k where k = 'token'))->'lines') = 3, 'with its lines, without internal fields');
select pg_temp.ok(public.invoice_public('nope') is null and public.invoice_public(repeat('0', 48)) is null, 'wrong tokens show nothing');
select pg_temp.ok(pg_temp.err($$select count(*) from public.invoices$$) like '42501%', 'signed-out visitors can''t read invoices');
reset role;
select pg_temp.ok((select viewed_at is not null from public.invoices where id = (select v::uuid from k where k = 'inv')), 'opening the link marks it viewed');

-- Who sees what
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select pg_temp.ok((select count(*) from public.invoices) >= 5, 'viewers read invoices');
select pg_temp.ok(pg_temp.err($$select public.invoice_record_payment((select v::uuid from k where k = 'inv'), null, 1, 'cash')$$) like '42501%', 'but can''t record payments');
select pg_temp.ok(pg_temp.err($$insert into public.invoices (doc_id, bill_name) values ((select v::uuid from k where k = 'hub'), 'x')$$) like '42501%', 'or write drafts');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select pg_temp.ok((select count(*) from public.invoices) = 0 and (select count(*) from public.invoice_profiles) = 0, 'outsiders see nothing');
reset role;

-- Recurring: a draft on the run date.
insert into public.invoice_recurring (doc_id, template_id, every, next_run, created_by) values ((select v::uuid from k where k = 'hub'), (select v::uuid from k where k = 'inv2'), 'month', current_date, '00000000-0000-0000-0000-0000000000f2');
select public._invoice_daily();
select pg_temp.ok((select count(*) from public.invoices where recurring_id is not null and status = 'draft') = 1, 'the daily run makes the recurring draft');
select pg_temp.ok((select next_run from public.invoice_recurring) = (current_date + interval '1 month')::date, 'and schedules the next one');

select 'invoices: all checks passed' as out;
