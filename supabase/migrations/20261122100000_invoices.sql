-- Invoice generator (docs/invoice-generator-plan.md). Everything belongs to a
-- workspace hub (doc_id), so access follows the workspace through my_doc_ids():
-- viewers read, editors write drafts, issue, send and record payments.
-- Issued invoices can't be changed or deleted (only voided or credited).
-- Schema public only; the email app is not touched.

-- ============================================================
-- Settings
-- ============================================================
create table public.invoice_profiles (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  name text not null default 'My company' check (length(name) between 1 and 120),
  legal_name text not null default '' check (length(legal_name) <= 200),
  address text not null default '' check (length(address) <= 500),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  vat_id text not null default '' check (length(vat_id) <= 40),
  reg_no text not null default '' check (length(reg_no) <= 60),
  email text not null default '' check (length(email) <= 200),
  phone text not null default '' check (length(phone) <= 60),
  website text not null default '' check (length(website) <= 200),
  iban text not null default '' check (length(iban) <= 50),
  bic text not null default '' check (length(bic) <= 20),
  bank_name text not null default '' check (length(bank_name) <= 120),
  logo_url text not null default '' check (length(logo_url) <= 1000),
  color text not null default '#5a43d9' check (color ~ '^#[0-9a-fA-F]{6}$'),
  template text not null default 'classic' check (template in ('classic', 'modern', 'minimal', 'bold')),
  language text not null default 'en' check (language ~ '^[a-z]{2}$'),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  terms_days int not null default 14 check (terms_days between 0 and 365),
  vat_registered boolean not null default true,
  notes text not null default '' check (length(notes) <= 4000),
  terms text not null default '' check (length(terms) <= 4000),
  footer text not null default '' check (length(footer) <= 1000),
  show_qr boolean not null default true,
  reminders_on boolean not null default false,
  reminder_days int[] not null default '{-3,3,10}',
  email_subject text not null default 'Invoice {{number}} from {{company}}' check (length(email_subject) <= 300),
  email_body text not null default E'Hello,\n\nplease find invoice {{number}} for {{total}} attached, due on {{due_date}}.\nYou can also view it online: {{link}}\n\nThank you,\n{{company}}' check (length(email_body) <= 8000),
  reminder_subject text not null default 'Reminder: invoice {{number}} is due {{due_date}}' check (length(reminder_subject) <= 300),
  reminder_body text not null default E'Hello,\n\na friendly reminder that invoice {{number}} for {{balance}} is due on {{due_date}}.\nView it online: {{link}}\n\nThank you,\n{{company}}' check (length(reminder_body) <= 8000),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index invoice_profiles_doc_idx on public.invoice_profiles (doc_id);

create table public.invoice_series (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  profile_id uuid not null references public.invoice_profiles(id) on delete cascade,
  kind text not null check (kind in ('invoice', 'credit_note', 'quote', 'proforma')),
  -- {YYYY} {YY} {MM} and a run of # for the zero-padded counter: "{YYYY}-{####}"
  pattern text not null check (pattern ~ '#' and length(pattern) <= 60),
  next_number int not null default 1 check (next_number >= 1),
  yearly boolean not null default true,
  year int,
  unique (profile_id, kind)
);
create index invoice_series_doc_idx on public.invoice_series (doc_id);

create table public.invoice_tax_rates (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  rate numeric(7, 4) not null default 0 check (rate between 0 and 100),
  -- EN 16931 VAT categories: S standard, Z zero, E exempt, AE reverse charge, K intra-EU, G export, O outside scope
  category text not null default 'S' check (category in ('S', 'Z', 'E', 'AE', 'K', 'G', 'O')),
  note text not null default '' check (length(note) <= 300),
  is_default boolean not null default false,
  position int not null default 0
);
create index invoice_tax_rates_doc_idx on public.invoice_tax_rates (doc_id);

create table public.invoice_services (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  unit text not null default 'hour' check (length(unit) <= 30),
  price numeric(16, 4) not null default 0,
  tax_rate_id uuid references public.invoice_tax_rates(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index invoice_services_doc_idx on public.invoice_services (doc_id);
create index invoice_services_tax_idx on public.invoice_services (tax_rate_id) where tax_rate_id is not null;

-- Billing details remembered per client (a row of the hub's Clients table).
create table public.invoice_billing (
  doc_id uuid not null references public.documents(id) on delete cascade,
  client_row bigint not null,
  name text not null default '' check (length(name) <= 200),
  address text not null default '' check (length(address) <= 500),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  vat_id text not null default '' check (length(vat_id) <= 40),
  email text not null default '' check (length(email) <= 500),
  language text not null default '' check (language = '' or language ~ '^[a-z]{2}$'),
  currency text not null default '' check (currency = '' or currency ~ '^[A-Z]{3}$'),
  terms_days int check (terms_days between 0 and 365),
  primary key (doc_id, client_row)
);

-- ============================================================
-- Invoices
-- ============================================================
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  profile_id uuid references public.invoice_profiles(id) on delete set null,
  kind text not null default 'invoice' check (kind in ('invoice', 'credit_note', 'quote', 'proforma')),
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'void', 'accepted', 'declined')),
  number text,
  series_id uuid references public.invoice_series(id) on delete set null,
  client_row bigint,
  bill_name text not null default '' check (length(bill_name) <= 200),
  bill_address text not null default '' check (length(bill_address) <= 500),
  bill_country text not null default '' check (bill_country = '' or bill_country ~ '^[A-Z]{2}$'),
  bill_vat_id text not null default '' check (length(bill_vat_id) <= 40),
  bill_email text not null default '' check (length(bill_email) <= 500),
  issue_date date not null default current_date,
  supply_from date,
  supply_to date,
  due_date date,
  reference text not null default '' check (length(reference) <= 120),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(18, 8) not null default 1 check (fx_rate > 0),
  language text not null default 'en' check (language ~ '^[a-z]{2}$'),
  template text not null default 'classic' check (template in ('classic', 'modern', 'minimal', 'bold')),
  color text not null default '#5a43d9' check (color ~ '^#[0-9a-fA-F]{6}$'),
  show_qr boolean not null default true,
  notes text not null default '' check (length(notes) <= 4000),
  terms text not null default '' check (length(terms) <= 4000),
  discount_pct numeric(7, 4) not null default 0 check (discount_pct between 0 and 100),
  subtotal numeric(16, 2) not null default 0,
  discount_total numeric(16, 2) not null default 0,
  tax_total numeric(16, 2) not null default 0,
  total numeric(16, 2) not null default 0,
  paid_amount numeric(16, 2) not null default 0,
  credited_amount numeric(16, 2) not null default 0,
  tax_breakdown jsonb not null default '[]'::jsonb,
  seller jsonb not null default '{}'::jsonb,
  public_token text unique,
  pdf_path text,
  pdf_sha256 text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  xml_path text,
  issued_at timestamptz,
  issued_by uuid references public.profiles(id) on delete set null,
  sent_at timestamptz,
  viewed_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  credit_of uuid references public.invoices(id) on delete set null,
  quote_of uuid references public.invoices(id) on delete set null,
  recurring_id uuid,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_id, kind, number)
);
create index invoices_doc_idx on public.invoices (doc_id, issue_date desc);
create index invoices_client_idx on public.invoices (doc_id, client_row);
create index invoices_profile_idx on public.invoices (profile_id);
create index invoices_series_idx on public.invoices (series_id);
create index invoices_credit_idx on public.invoices (credit_of) where credit_of is not null;
create index invoices_quote_idx on public.invoices (quote_of) where quote_of is not null;
create index invoices_open_idx on public.invoices (due_date) where status = 'issued';

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  doc_id uuid not null references public.documents(id) on delete cascade,
  position double precision not null default 0,
  kind text not null default 'item' check (kind in ('item', 'heading')),
  service_id uuid references public.invoice_services(id) on delete set null,
  description text not null default '' check (length(description) <= 4000),
  quantity numeric(16, 4) not null default 1,
  unit text not null default '' check (length(unit) <= 30),
  unit_price numeric(16, 4) not null default 0,
  discount_pct numeric(7, 4) not null default 0 check (discount_pct between 0 and 100),
  tax_rate_id uuid references public.invoice_tax_rates(id) on delete set null,
  tax_rate numeric(7, 4) not null default 0 check (tax_rate between 0 and 100),
  tax_category text not null default 'S' check (tax_category in ('S', 'Z', 'E', 'AE', 'K', 'G', 'O')),
  tax_note text not null default '' check (length(tax_note) <= 300),
  net numeric(16, 2) not null default 0
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, position);
create index invoice_lines_doc_idx on public.invoice_lines (doc_id);
create index invoice_lines_service_idx on public.invoice_lines (service_id) where service_id is not null;
create index invoice_lines_tax_idx on public.invoice_lines (tax_rate_id) where tax_rate_id is not null;

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  doc_id uuid not null references public.documents(id) on delete cascade,
  paid_on date not null default current_date,
  amount numeric(16, 2) not null check (amount <> 0),
  method text not null default 'bank transfer' check (length(method) <= 60),
  reference text not null default '' check (length(reference) <= 120),
  note text not null default '' check (length(note) <= 500),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id);
create index invoice_payments_doc_idx on public.invoice_payments (doc_id);

create table public.invoice_events (
  id bigint generated always as identity primary key,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  doc_id uuid not null references public.documents(id) on delete cascade,
  kind text not null,
  details jsonb not null default '{}'::jsonb,
  by_user uuid references public.profiles(id) on delete set null default auth.uid(),
  at timestamptz not null default now()
);
create index invoice_events_invoice_idx on public.invoice_events (invoice_id, at);
create index invoice_events_doc_idx on public.invoice_events (doc_id);

create table public.invoice_recurring (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  template_id uuid not null references public.invoices(id) on delete cascade,
  every text not null default 'month' check (every in ('month', 'quarter', 'year')),
  next_run date not null,
  until date,
  active boolean not null default true,
  last_invoice uuid references public.invoices(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index invoice_recurring_doc_idx on public.invoice_recurring (doc_id);
create index invoice_recurring_template_idx on public.invoice_recurring (template_id);
create index invoice_recurring_due_idx on public.invoice_recurring (next_run) where active;
alter table public.invoices add constraint invoices_recurring_fk foreign key (recurring_id) references public.invoice_recurring(id) on delete set null;
create index invoices_recurring_idx on public.invoices (recurring_id) where recurring_id is not null;

-- ============================================================
-- Integrity
-- ============================================================
-- Lines and payments take doc_id from their invoice.
create or replace function public.tg_invoice_child_doc()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select doc_id into new.doc_id from public.invoices where id = new.invoice_id;
  if new.doc_id is null then
    raise exception 'Unknown invoice';
  end if;
  return new;
end $$;
create trigger invoice_lines_doc before insert or update of invoice_id on public.invoice_lines for each row execute function public.tg_invoice_child_doc();
create trigger invoice_payments_doc before insert or update of invoice_id on public.invoice_payments for each row execute function public.tg_invoice_child_doc();
create trigger invoice_events_doc before insert on public.invoice_events for each row execute function public.tg_invoice_child_doc();

-- The invoice tables only belong to hubs.
create or replace function public.tg_invoice_hub_doc()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.documents where id = new.doc_id and kind = 'hub') then
    raise exception 'Invoices belong to a workspace hub';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['invoice_profiles', 'invoice_series', 'invoice_tax_rates', 'invoice_services', 'invoice_billing', 'invoices', 'invoice_recurring'] loop
    execute format('create trigger %1$s_hub before insert or update of doc_id on public.%1$s for each row execute function public.tg_invoice_hub_doc()', t);
  end loop;
end $$;

-- Drafts are edited freely; anything else only through the functions below.
create or replace function public.tg_invoice_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  internal boolean := coalesce(current_setting('lmdu.invoice_internal', true), '') = 'on';
begin
  if internal then
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.number is not null or new.public_token is not null or new.pdf_path is not null then
      raise exception 'New invoices start as drafts' using errcode = '42501';
    end if;
    new.paid_amount := 0;
    new.credited_amount := 0;
    new.seller := '{}'::jsonb;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Issued invoices can''t be deleted; void it or create a credit note' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'draft' then
    raise exception 'Issued invoices can''t be changed; void it or create a credit note' using errcode = '42501';
  end if;
  if new.status <> 'draft' or new.number is distinct from old.number or new.public_token is distinct from old.public_token
     or new.pdf_path is distinct from old.pdf_path or new.paid_amount <> old.paid_amount or new.credited_amount <> old.credited_amount
     or new.seller is distinct from old.seller or new.doc_id <> old.doc_id then
    raise exception 'Use Issue to issue an invoice' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger invoices_guard before insert or update or delete on public.invoices for each row execute function public.tg_invoice_guard();

create or replace function public.tg_invoice_lines_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('lmdu.invoice_internal', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if exists (select 1 from public.invoices i where i.id = case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end and i.status <> 'draft') then
    raise exception 'The lines of an issued invoice can''t be changed' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger invoice_lines_guard before insert or update or delete on public.invoice_lines for each row execute function public.tg_invoice_lines_guard();

-- ============================================================
-- Row-level security: viewers read, editors write, owners change settings
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['invoice_profiles', 'invoice_series', 'invoice_tax_rates', 'invoice_services', 'invoice_billing', 'invoices', 'invoice_lines', 'invoice_payments', 'invoice_events', 'invoice_recurring'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (doc_id = any ((select public.my_doc_ids(1))::uuid[]))', t);
  end loop;
  -- Editors write these directly (drafts, the catalogue, client billing details, recurring schedules).
  foreach t in array array['invoice_services', 'invoice_billing', 'invoices', 'invoice_lines', 'invoice_recurring'] loop
    execute format('create policy %1$s_write on public.%1$s for all to authenticated using (doc_id = any ((select public.my_doc_ids(2))::uuid[])) with check (doc_id = any ((select public.my_doc_ids(2))::uuid[]))', t);
  end loop;
  -- Owners change the business profiles, numbering and tax rates.
  foreach t in array array['invoice_profiles', 'invoice_series', 'invoice_tax_rates'] loop
    execute format('create policy %1$s_write on public.%1$s for all to authenticated using (doc_id = any ((select public.my_doc_ids(3))::uuid[])) with check (doc_id = any ((select public.my_doc_ids(3))::uuid[]))', t);
  end loop;
end $$;
-- Payments and events only through the functions.
revoke insert, update, delete on public.invoice_payments, public.invoice_events from authenticated;

-- ============================================================
-- Totals: one algorithm, the same as src/lib/invoiceMath.ts
--   line net  = round(qty × price × (1 − line discount %), 2)
--   per rate  : base = round(Σ nets × (1 − invoice discount %), 2); tax = round(base × rate %, 2)
--   subtotal  = Σ nets; discount = subtotal − Σ bases; total = Σ bases + Σ taxes
-- (round() on numeric rounds half away from zero.)
-- ============================================================
create or replace function public._invoice_totals(p_invoice uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_disc numeric;
  v_sub numeric;
  v_breakdown jsonb;
  v_base numeric;
  v_tax numeric;
begin
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoice_lines set net = case when kind = 'item' then round(quantity * unit_price * (1 - discount_pct / 100), 2) else 0 end
  where invoice_id = p_invoice;
  select discount_pct into v_disc from public.invoices where id = p_invoice;
  select coalesce(sum(net), 0) into v_sub from public.invoice_lines where invoice_id = p_invoice and kind = 'item';
  select coalesce(jsonb_agg(jsonb_build_object('rate', rate, 'category', category, 'note', note, 'base', base, 'tax', tax) order by rate desc, category), '[]'::jsonb),
         coalesce(sum(base), 0), coalesce(sum(tax), 0)
  into v_breakdown, v_base, v_tax
  from (
    select g.rate, g.category, g.note, g.base, round(g.base * g.rate / 100, 2) as tax
    from (
      select tax_rate as rate, tax_category as category, max(tax_note) as note, round(sum(net) * (1 - v_disc / 100), 2) as base
      from public.invoice_lines where invoice_id = p_invoice and kind = 'item'
      group by tax_rate, tax_category
    ) g
  ) x;
  update public.invoices set subtotal = v_sub, discount_total = v_sub - v_base, tax_total = v_tax, total = v_base + v_tax, tax_breakdown = v_breakdown
  where id = p_invoice;
  perform set_config('lmdu.invoice_internal', 'off', true);
  return jsonb_build_object('subtotal', v_sub, 'discount', v_sub - v_base, 'tax', v_tax, 'total', v_base + v_tax, 'breakdown', v_breakdown);
end $$;

-- "{YYYY}-{####}" → "2026-0042"
create or replace function public._invoice_number(p_pattern text, p_n int, p_date date)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v text := p_pattern;
  m text;
begin
  v := replace(replace(replace(v, '{YYYY}', to_char(p_date, 'YYYY')), '{YY}', to_char(p_date, 'YY')), '{MM}', to_char(p_date, 'MM'));
  m := substring(v from '\{(#+)\}');
  if m is not null then
    v := replace(v, '{' || m || '}', lpad(p_n::text, length(m), '0'));
  else
    m := substring(v from '(#+)');
    v := regexp_replace(v, '#+', lpad(p_n::text, length(m), '0'));
  end if;
  return v;
end $$;

create or replace function public._invoice_editor(p_doc uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.doc_role(p_doc), '') not in ('owner', 'editor') then
    raise exception 'You don''t have permission to do this' using errcode = '42501';
  end if;
end $$;

create or replace function public._invoice_event(p_invoice uuid, p_kind text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.invoice_events (invoice_id, doc_id, kind, details) select p_invoice, doc_id, p_kind, coalesce(p_details, '{}'::jsonb) from public.invoices where id = p_invoice;
$$;

-- What's missing before an invoice can be issued (EU VAT Directive art. 226), as sentences.
create or replace function public.invoice_problems(p_id uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices;
  p public.invoice_profiles;
  out text[] := '{}';
begin
  select * into i from public.invoices where id = p_id;
  if i.id is null or public.doc_role(i.doc_id) is null then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  select * into p from public.invoice_profiles where id = i.profile_id;
  if p.id is null then out := array_append(out, 'Choose the business profile it is issued from'::text); end if;
  if p.id is not null and btrim(coalesce(nullif(p.legal_name, ''), p.name)) = '' then out := array_append(out, 'Your company''s name is missing (Settings → Business profile)'::text); end if;
  if p.id is not null and btrim(p.address) = '' then out := array_append(out, 'Your company''s address is missing (Settings → Business profile)'::text); end if;
  if p.id is not null and p.vat_registered and btrim(p.vat_id) = '' and i.kind <> 'quote' then out := array_append(out, 'Your VAT number is missing (Settings → Business profile)'::text); end if;
  if btrim(i.bill_name) = '' then out := array_append(out, 'The client''s name is missing'::text); end if;
  if btrim(i.bill_address) = '' and i.kind <> 'quote' then out := array_append(out, 'The client''s address is missing'::text); end if;
  if not exists (select 1 from public.invoice_lines where invoice_id = p_id and kind = 'item') then out := array_append(out, 'Add at least one item'::text); end if;
  if exists (select 1 from public.invoice_lines where invoice_id = p_id and kind = 'item' and btrim(description) = '') then out := array_append(out, 'Every item needs a description'::text); end if;
  if exists (select 1 from public.invoice_lines where invoice_id = p_id and kind = 'item' and tax_category in ('AE', 'K')) and btrim(i.bill_vat_id) = '' then
    out := array_append(out, 'Reverse charge and intra-EU items need the client''s VAT number'::text);
  end if;
  if exists (select 1 from public.invoice_lines where invoice_id = p_id and kind = 'item' and tax_category <> 'S' and btrim(tax_note) = '') then
    out := array_append(out, 'Items without VAT need the reason printed on the invoice (the tax rate''s note)'::text);
  end if;
  if i.kind = 'credit_note' and i.credit_of is null then out := array_append(out, 'A credit note must refer to an invoice'::text); end if;
  if i.due_date is not null and i.due_date < i.issue_date then out := array_append(out, 'The due date is before the issue date'::text); end if;
  if i.supply_to is not null and i.supply_from is not null and i.supply_to < i.supply_from then out := array_append(out, 'The supply period ends before it starts'::text); end if;
  return out;
end $$;

-- Issues a draft: checks it, computes the totals, gives it the next number of
-- its series and keeps a copy of the seller's details. Returns the invoice.
create or replace function public.invoice_issue(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  p public.invoice_profiles;
  s public.invoice_series;
  v_problems text[];
  v_year int;
  v_n int;
begin
  select * into i from public.invoices where id = p_id for update;
  if i.id is null then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform public._invoice_editor(i.doc_id);
  if i.status <> 'draft' then
    raise exception 'This invoice is already issued';
  end if;
  v_problems := public.invoice_problems(p_id);
  if cardinality(v_problems) > 0 then
    raise exception 'Not ready to issue: %', array_to_string(v_problems, '; ') using errcode = '22023';
  end if;
  select * into p from public.invoice_profiles where id = i.profile_id;
  select * into s from public.invoice_series where profile_id = p.id and kind = i.kind for update;
  if s.id is null then
    insert into public.invoice_series (doc_id, profile_id, kind, pattern)
    values (i.doc_id, p.id, i.kind, case i.kind when 'credit_note' then 'CN-{YYYY}-{####}' when 'quote' then 'Q-{YYYY}-{####}' when 'proforma' then 'PF-{YYYY}-{####}' else '{YYYY}-{####}' end)
    returning * into s;
    perform 1 from public.invoice_series where id = s.id for update;
  end if;
  v_year := extract(year from i.issue_date)::int;
  v_n := case when s.yearly and s.year is distinct from v_year then 1 else s.next_number end;
  -- A number already used in this series (e.g. set by hand in Settings) is skipped.
  while exists (select 1 from public.invoices where doc_id = i.doc_id and kind = i.kind and number = public._invoice_number(s.pattern, v_n, i.issue_date)) loop
    v_n := v_n + 1;
  end loop;
  update public.invoice_series set next_number = v_n + 1, year = v_year where id = s.id;
  perform public._invoice_totals(p_id);
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set
    status = 'issued',
    number = public._invoice_number(s.pattern, v_n, i.issue_date),
    series_id = s.id,
    due_date = coalesce(i.due_date, i.issue_date + p.terms_days),
    seller = jsonb_build_object('name', p.name, 'legal_name', coalesce(nullif(p.legal_name, ''), p.name), 'address', p.address, 'country', p.country,
      'vat_id', p.vat_id, 'reg_no', p.reg_no, 'email', p.email, 'phone', p.phone, 'website', p.website, 'iban', p.iban, 'bic', p.bic,
      'bank_name', p.bank_name, 'logo_url', p.logo_url, 'footer', p.footer, 'vat_registered', p.vat_registered),
    public_token = encode(extensions.gen_random_bytes(24), 'hex'),
    issued_at = now(),
    issued_by = auth.uid()
  where id = p_id;
  -- Issuing a credit note reduces what the original invoice is owed.
  if i.kind = 'credit_note' then
    update public.invoices o set credited_amount = o.credited_amount + abs((select total from public.invoices where id = p_id)),
      status = case when o.status = 'issued' and o.total - o.paid_amount - (o.credited_amount + abs((select total from public.invoices where id = p_id))) <= 0 then 'paid' else o.status end
    where o.id = i.credit_of;
    perform public._invoice_event(i.credit_of, 'credited', jsonb_build_object('credit_note', p_id));
  end if;
  perform set_config('lmdu.invoice_internal', 'off', true);
  perform public._invoice_event(p_id, 'issued', jsonb_build_object('number', (select number from public.invoices where id = p_id)));
  return (select to_jsonb(x) from public.invoices x where x.id = p_id);
end $$;

-- After issuing, the browser stores the PDF (and the e-invoice XML) and records them.
create or replace function public.invoice_attach_files(p_id uuid, p_pdf text, p_sha256 text, p_xml text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id for update;
  if i.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(i.doc_id);
  if i.status = 'draft' then raise exception 'Issue the invoice first'; end if;
  if i.pdf_path is not null then raise exception 'This invoice already has its PDF'; end if;
  if p_pdf not like i.doc_id::text || '/' || i.id::text || '/%' or (p_xml is not null and p_xml not like i.doc_id::text || '/' || i.id::text || '/%') then
    raise exception 'Files must be stored in the invoice''s folder';
  end if;
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set pdf_path = p_pdf, pdf_sha256 = lower(p_sha256), xml_path = p_xml where id = p_id;
  perform set_config('lmdu.invoice_internal', 'off', true);
end $$;

create or replace function public.invoice_void(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id for update;
  if i.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(i.doc_id);
  if i.status not in ('issued', 'accepted', 'declined') then raise exception 'Only issued, unpaid invoices can be voided'; end if;
  if i.paid_amount <> 0 then raise exception 'Remove its payments first, or create a credit note'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it is voided'; end if;
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set status = 'void', voided_at = now(), void_reason = left(btrim(p_reason), 500), public_token = null where id = p_id;
  perform set_config('lmdu.invoice_internal', 'off', true);
  perform public._invoice_event(p_id, 'voided', jsonb_build_object('reason', left(btrim(p_reason), 500)));
end $$;

-- A new draft copied from an invoice: a duplicate, a credit note (negative lines) or an invoice from a quote.
create or replace function public._invoice_copy(p_id uuid, p_kind text, p_negate boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_new uuid;
begin
  select * into i from public.invoices where id = p_id;
  if i.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(i.doc_id);
  insert into public.invoices (doc_id, profile_id, kind, client_row, bill_name, bill_address, bill_country, bill_vat_id, bill_email, issue_date, supply_from, supply_to,
    due_date, reference, currency, fx_rate, language, template, color, show_qr, notes, terms, discount_pct,
    credit_of, quote_of)
  values (i.doc_id, i.profile_id, p_kind, i.client_row, i.bill_name, i.bill_address, i.bill_country, i.bill_vat_id, i.bill_email, current_date,
    case when p_kind = 'credit_note' then i.supply_from end, case when p_kind = 'credit_note' then i.supply_to end,
    case when i.due_date is not null then current_date + (i.due_date - i.issue_date) end,
    case when p_kind = 'credit_note' then coalesce(nullif(i.number, ''), i.reference) else i.reference end,
    i.currency, i.fx_rate, i.language, i.template, i.color, i.show_qr, i.notes, i.terms, i.discount_pct,
    case when p_kind = 'credit_note' then i.id end, case when i.kind = 'quote' and p_kind = 'invoice' then i.id end)
  returning id into v_new;
  insert into public.invoice_lines (invoice_id, doc_id, position, kind, service_id, description, quantity, unit, unit_price, discount_pct, tax_rate_id, tax_rate, tax_category, tax_note)
  select v_new, i.doc_id, position, kind, service_id, description, case when p_negate then -quantity else quantity end, unit, unit_price, discount_pct, tax_rate_id, tax_rate, tax_category, tax_note
  from public.invoice_lines where invoice_id = p_id;
  perform public._invoice_totals(v_new);
  return v_new;
end $$;

create or replace function public.invoice_duplicate(p_id uuid) returns uuid language sql security definer set search_path = '' as $$
  select public._invoice_copy(p_id, (select case when kind = 'credit_note' then 'invoice' else kind end from public.invoices where id = p_id), false)
$$;

create or replace function public.invoice_credit_note(p_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_status text;
begin
  select kind, status into v_kind, v_status from public.invoices where id = p_id;
  if v_kind is distinct from 'invoice' or v_status not in ('issued', 'paid') then
    raise exception 'Credit notes are made for issued invoices';
  end if;
  return public._invoice_copy(p_id, 'credit_note', true);
end $$;

create or replace function public.invoice_from_quote(p_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.invoices;
  v_new uuid;
begin
  select * into q from public.invoices where id = p_id for update;
  if q.kind is distinct from 'quote' or q.status not in ('issued', 'accepted') then
    raise exception 'Only issued quotes can become invoices';
  end if;
  v_new := public._invoice_copy(p_id, 'invoice', false);
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set status = 'accepted' where id = p_id;
  perform set_config('lmdu.invoice_internal', 'off', true);
  perform public._invoice_event(p_id, 'accepted', jsonb_build_object('invoice', v_new));
  return v_new;
end $$;

-- ============================================================
-- Payments
-- ============================================================
create or replace function public._invoice_settle(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_paid numeric;
begin
  select coalesce(sum(amount), 0) into v_paid from public.invoice_payments where invoice_id = p_id;
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set paid_amount = v_paid,
    status = case when status in ('issued', 'paid') then case when total - v_paid - credited_amount <= 0 then 'paid' else 'issued' end else status end,
    paid_at = case when total - v_paid - credited_amount <= 0 then coalesce(paid_at, now()) end
  where id = p_id;
  perform set_config('lmdu.invoice_internal', 'off', true);
end $$;

create or replace function public.invoice_record_payment(p_id uuid, p_date date, p_amount numeric, p_method text, p_reference text default '', p_note text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_pay uuid;
begin
  select * into i from public.invoices where id = p_id for update;
  if i.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(i.doc_id);
  if i.kind not in ('invoice', 'proforma') or i.status not in ('issued', 'paid') then raise exception 'Payments are recorded on issued invoices'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'Enter the amount paid'; end if;
  insert into public.invoice_payments (invoice_id, doc_id, paid_on, amount, method, reference, note)
  values (p_id, i.doc_id, coalesce(p_date, current_date), round(p_amount, 2), left(coalesce(nullif(btrim(p_method), ''), 'bank transfer'), 60), left(coalesce(p_reference, ''), 120), left(coalesce(p_note, ''), 500))
  returning id into v_pay;
  perform public._invoice_settle(p_id);
  perform public._invoice_event(p_id, 'payment', jsonb_build_object('amount', round(p_amount, 2), 'date', coalesce(p_date, current_date), 'method', p_method));
  return v_pay;
end $$;

create or replace function public.invoice_delete_payment(p_payment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_inv uuid;
  v_doc uuid;
  v_amount numeric;
begin
  select invoice_id, doc_id, amount into v_inv, v_doc, v_amount from public.invoice_payments where id = p_payment;
  if v_inv is null then raise exception 'Payment not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(v_doc);
  perform 1 from public.invoices where id = v_inv for update;
  delete from public.invoice_payments where id = p_payment;
  perform public._invoice_settle(v_inv);
  perform public._invoice_event(v_inv, 'payment_removed', jsonb_build_object('amount', v_amount));
end $$;

-- ============================================================
-- Sending (through the notify Edge Function and SendGrid) and the online page
-- ============================================================
alter table public.notification_queue drop constraint if exists notification_queue_kind_check;
alter table public.notification_queue add constraint notification_queue_kind_check
  check (kind in ('invite', 'shared', 'mention', 'test', 'invoice'));

create or replace function public._invoice_fill(p_text text, i public.invoices)
returns text language sql stable set search_path = '' as $$
  select replace(replace(replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '{{number}}', coalesce(i.number, '')),
    '{{company}}', coalesce(i.seller->>'name', '')),
    '{{client}}', i.bill_name),
    '{{total}}', i.currency || ' ' || to_char(i.total, 'FM999G999G999G990D00')),
    '{{balance}}', i.currency || ' ' || to_char(i.total - i.paid_amount - i.credited_amount, 'FM999G999G999G990D00')),
    '{{due_date}}', coalesce(to_char(i.due_date, 'DD Mon YYYY'), '')),
    '{{issue_date}}', to_char(i.issue_date, 'DD Mon YYYY'))
$$;

create or replace function public._invoice_queue_mail(i public.invoices, p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body text, p_pdf boolean, p_xml boolean, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_to text[];
begin
  select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_to from unnest(coalesce(p_to, '{}')) x
  where btrim(x) ~* '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$';
  if cardinality(v_to) = 0 then raise exception 'Add at least one valid email address'; end if;
  insert into public.notification_queue (kind, to_email, payload) values ('invoice', v_to[1], jsonb_build_object(
    'invoice', i.id, 'doc', i.doc_id, 'mail', p_kind, 'to', to_jsonb(v_to[1:10]),
    'cc', to_jsonb((select coalesce(array_agg(lower(btrim(x))), '{}') from unnest(coalesce(p_cc, '{}')) x where btrim(x) ~* '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$')),
    'bcc', to_jsonb((select coalesce(array_agg(lower(btrim(x))), '{}') from unnest(coalesce(p_bcc, '{}')) x where btrim(x) ~* '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$')),
    'from_name', i.seller->>'name', 'reply_to', i.seller->>'email',
    'subject', left(public._invoice_fill(p_subject, i), 300), 'text', left(public._invoice_fill(p_body, i), 8000),
    'token', i.public_token, 'pdf', case when p_pdf then i.pdf_path end, 'xml', case when p_xml then i.xml_path end,
    'file_name', coalesce(i.number, 'invoice')));
  perform public._kick_notify();
end $$;

create or replace function public.invoice_send(p_id uuid, p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body text, p_attach_pdf boolean default true, p_attach_xml boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id;
  if i.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  perform public._invoice_editor(i.doc_id);
  if i.status not in ('issued', 'paid', 'accepted') then raise exception 'Issue the invoice before sending it'; end if;
  if p_attach_pdf and i.pdf_path is null then raise exception 'The invoice''s PDF isn''t stored yet: open the invoice to finish issuing it'; end if;
  perform public._invoice_queue_mail(i, p_to, p_cc, p_bcc, p_subject, p_body, p_attach_pdf, p_attach_xml and i.xml_path is not null, 'send');
  perform public._invoice_event(p_id, 'queued', jsonb_build_object('to', to_jsonb(p_to)));
end $$;

-- When the email has gone out, the invoice is marked sent.
create or replace function public.tg_invoice_mail_sent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_inv uuid;
begin
  if new.kind <> 'invoice' or new.sent_at is null or old.sent_at is not null then return null; end if;
  v_inv := nullif(new.payload->>'invoice', '')::uuid;
  perform set_config('lmdu.invoice_internal', 'on', true);
  update public.invoices set sent_at = coalesce(sent_at, new.sent_at) where id = v_inv;
  perform set_config('lmdu.invoice_internal', 'off', true);
  insert into public.invoice_events (invoice_id, doc_id, kind, details, by_user)
  select v_inv, doc_id, case when new.payload->>'mail' = 'reminder' then 'reminded' else 'sent' end,
         jsonb_build_object('to', new.payload->'to', 'offset', new.payload->'offset'), null
  from public.invoices where id = v_inv;
  return null;
end $$;
create trigger notification_queue_invoice_sent after update of sent_at on public.notification_queue
  for each row execute function public.tg_invoice_mail_sent();

-- The online invoice page (signed out): the issued invoice by its secret token.
create or replace function public.invoice_public(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  if coalesce(length(p_token), 0) < 32 then return null; end if;
  select * into i from public.invoices where public_token = p_token and status <> 'draft';
  if i.id is null then return null; end if;
  if i.viewed_at is null and auth.uid() is null then
    perform set_config('lmdu.invoice_internal', 'on', true);
    update public.invoices set viewed_at = now() where id = i.id;
    perform set_config('lmdu.invoice_internal', 'off', true);
    insert into public.invoice_events (invoice_id, doc_id, kind, by_user) values (i.id, i.doc_id, 'viewed', null);
  end if;
  return (to_jsonb(i) - 'created_by' - 'issued_by' - 'profile_id' - 'series_id' - 'recurring_id' - 'client_row' - 'pdf_path' - 'xml_path' - 'public_token')
    || jsonb_build_object('lines', coalesce((select jsonb_agg(to_jsonb(l) - 'doc_id' - 'service_id' - 'tax_rate_id' order by l.position) from public.invoice_lines l where l.invoice_id = i.id), '[]'::jsonb));
end $$;

-- ============================================================
-- Every day: reminders and recurring invoices
-- ============================================================
create or replace function public._invoice_daily()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_new uuid;
  v_off int;
begin
  -- Reminders: on the days set in the profile (negative: before the due date).
  for r in
    select i.*, p.reminder_days, p.reminder_subject, p.reminder_body
    from public.invoices i join public.invoice_profiles p on p.id = i.profile_id
    where i.status = 'issued' and i.kind = 'invoice' and p.reminders_on and i.due_date is not null and i.sent_at is not null
      and i.total - i.paid_amount - i.credited_amount > 0 and btrim(i.bill_email) <> ''
  loop
    v_off := current_date - r.due_date;
    continue when not (v_off = any (r.reminder_days));
    continue when exists (select 1 from public.notification_queue q where q.kind = 'invoice' and q.payload->>'invoice' = r.id::text
                          and q.payload->>'mail' = 'reminder' and (q.payload->>'offset')::int = v_off);
    begin
      perform public._invoice_queue_mail((select x from public.invoices x where x.id = r.id), regexp_split_to_array(r.bill_email, '[,;]'), '{}', '{}',
        r.reminder_subject, r.reminder_body, true, false, 'reminder');
      update public.notification_queue set payload = payload || jsonb_build_object('offset', v_off)
      where id = (select max(id) from public.notification_queue where kind = 'invoice' and payload->>'invoice' = r.id::text);
    exception when others then
      raise warning 'invoice reminder %: %', r.id, sqlerrm;
    end;
  end loop;
  -- Recurring: a new draft from the template on each run date.
  for r in select * from public.invoice_recurring where active and next_run <= current_date and (until is null or next_run <= until) for update skip locked loop
    begin
      perform set_config('request.jwt.claim.sub', coalesce(r.created_by::text, ''), true);
      v_new := public._invoice_copy(r.template_id, 'invoice', false);
      perform set_config('lmdu.invoice_internal', 'on', true);
      update public.invoices set recurring_id = r.id, issue_date = r.next_run,
        due_date = r.next_run + coalesce((select terms_days from public.invoice_profiles where id = profile_id), 14) where id = v_new;
      perform set_config('lmdu.invoice_internal', 'off', true);
      update public.invoice_recurring set last_invoice = v_new,
        next_run = (r.next_run + case r.every when 'month' then interval '1 month' when 'quarter' then interval '3 months' else interval '1 year' end)::date
      where id = r.id;
    exception when others then
      raise warning 'recurring invoice %: %', r.id, sqlerrm;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
select cron.schedule('lmdu-invoices-daily', '17 6 * * *', 'select public._invoice_daily()');

-- ============================================================
-- Storage: issued PDFs / XML (private), logos (public, unguessable paths)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit) values ('invoices', 'invoices', false, 10485760) on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit) values ('invoice-logos', 'invoice-logos', true, 2097152) on conflict (id) do nothing;
create policy "Invoice files readable by workspace members" on storage.objects for select to authenticated
  using (bucket_id = 'invoices' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(1))::text[]));
create policy "Invoice files written by editors" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(2))::text[]));
create policy "Invoice logos uploaded by owners" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-logos' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(3))::text[]));
create policy "Invoice logos removed by owners" on storage.objects for delete to authenticated
  using (bucket_id = 'invoice-logos' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(3))::text[]));

-- ============================================================
-- Grants
-- ============================================================
revoke execute on function
  public.tg_invoice_child_doc(), public.tg_invoice_hub_doc(), public.tg_invoice_guard(), public.tg_invoice_lines_guard(),
  public._invoice_totals(uuid), public._invoice_number(text, int, date), public._invoice_editor(uuid), public._invoice_event(uuid, text, jsonb),
  public._invoice_copy(uuid, text, boolean), public._invoice_settle(uuid), public._invoice_fill(text, public.invoices),
  public._invoice_queue_mail(public.invoices, text[], text[], text[], text, text, boolean, boolean, text), public.tg_invoice_mail_sent(), public._invoice_daily()
from public, anon, authenticated;
revoke execute on function
  public.invoice_problems(uuid), public.invoice_issue(uuid), public.invoice_attach_files(uuid, text, text, text), public.invoice_void(uuid, text),
  public.invoice_duplicate(uuid), public.invoice_credit_note(uuid), public.invoice_from_quote(uuid),
  public.invoice_record_payment(uuid, date, numeric, text, text, text), public.invoice_delete_payment(uuid),
  public.invoice_send(uuid, text[], text[], text[], text, text, boolean, boolean)
from public, anon;
grant execute on function
  public.invoice_problems(uuid), public.invoice_issue(uuid), public.invoice_attach_files(uuid, text, text, text), public.invoice_void(uuid, text),
  public.invoice_duplicate(uuid), public.invoice_credit_note(uuid), public.invoice_from_quote(uuid),
  public.invoice_record_payment(uuid, date, numeric, text, text, text), public.invoice_delete_payment(uuid),
  public.invoice_send(uuid, text[], text[], text[], text, text, boolean, boolean)
to authenticated;
revoke execute on function public.invoice_public(text) from public;
grant execute on function public.invoice_public(text) to anon, authenticated;

comment on table public.invoices is 'LM Data Universe: invoices, credit notes, quotes and pro formas of a workspace hub. Issued ones are immutable.';
