-- Email through SendGrid: status, tags, delivery feedback and limits.
-- (docs/sendgrid-plan.md, steps 3 to 5.) Everything is in schema public and
-- additive; nothing of the email app (schema email_app) is touched.
--
--   mail_config        one row: is email set up, the sender and app address (reported by the Edge Functions)
--   mail_events        what SendGrid said happened to each email (Event Webhook)
--   mail_suppressions  addresses that bounced or reported spam: never mailed again until cleared
--   job_queue.delivery where an automation email is: queued, sent, delivered, deferred, bounced, blocked, spam, failed
--
-- Tags in To / Subject / Message: {{ColId}}, {{Column label}}, {{Ref.Field}},
-- {{id}}, {{doc}}, {{table}}, {{automation}}, {{changed_by}}, {{link}},
-- {{record_link}}, each with an optional fallback: {{Name|there}}.

-- ============================================================
-- Tables
-- ============================================================
alter table public.plans add column max_emails_per_day int check (max_emails_per_day > 0);
update public.plans set max_emails_per_day = 100 where id = 'free';
update public.plans set max_emails_per_day = 2000 where id = 'pro';

create table public.mail_config (
  id boolean primary key default true check (id),
  configured boolean not null default false,
  from_email text,
  app_url text,
  last_error text,
  checked_at timestamptz,
  last_event_at timestamptz
);
insert into public.mail_config (id) values (true);

alter table public.job_queue add column delivery text
  check (delivery in ('queued', 'sent', 'delivered', 'deferred', 'bounced', 'blocked', 'spam', 'failed'));
create index job_queue_mail_idx on public.job_queue (doc_id, started_at) where delivery is not null;

create table public.mail_events (
  id bigint generated always as identity primary key,
  job_id bigint references public.job_queue(id) on delete set null,
  notification_id bigint,
  doc_id uuid references public.documents(id) on delete cascade,
  email text not null,
  event text not null check (event in ('delivered', 'deferred', 'bounced', 'blocked', 'spam')),
  reason text,
  sg_event_id text unique,
  at timestamptz not null default now()
);
create index mail_events_job_idx on public.mail_events (job_id);
create index mail_events_doc_idx on public.mail_events (doc_id, at desc);
create index mail_events_at_idx on public.mail_events (at);

create table public.mail_suppressions (
  email text primary key check (email = lower(email)),
  reason text not null check (reason in ('bounced', 'spam')),
  detail text,
  at timestamptz not null default now()
);

alter table public.mail_config enable row level security;
alter table public.mail_events enable row level security;
alter table public.mail_suppressions enable row level security;
revoke all on public.mail_config, public.mail_events, public.mail_suppressions from anon, authenticated;

alter table public.notification_queue drop constraint if exists notification_queue_kind_check;
alter table public.notification_queue add constraint notification_queue_kind_check
  check (kind in ('invite', 'shared', 'mention', 'test'));

-- ============================================================
-- Status (reported by the Edge Functions, read by the app)
-- ============================================================
create or replace function public.mail_report(p_secret text, p_configured boolean, p_from text default null, p_app_url text default null, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._check_worker_secret(p_secret);
  update public.mail_config set
    configured = coalesce(p_configured, false),
    from_email = coalesce(nullif(p_from, ''), from_email),
    app_url = coalesce(nullif(p_app_url, ''), app_url),
    last_error = left(p_error, 500),
    checked_at = now()
  where id;
end $$;

-- What the app may know about email: whether it works and who it comes from.
create or replace function public.email_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('configured', c.configured, 'from', c.from_email, 'app_url', c.app_url, 'checked_at', c.checked_at)
         || case when public.is_app_admin() then jsonb_build_object('error', c.last_error, 'last_event_at', c.last_event_at) else '{}'::jsonb end
  from public.mail_config c where c.id
$$;

-- ============================================================
-- Tags
-- ============================================================
create or replace function public._mail_addresses(p_text text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct lower(btrim(x))), '{}')
  from unnest(regexp_split_to_array(coalesce(p_text, ''), '[,;]')) x
  where btrim(x) ~* '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$'
$$;

create or replace function public._pg_date_format(p_fmt text)
returns text language sql immutable set search_path = '' as $$
  select case p_fmt
    when 'MM/DD/YYYY' then 'MM/DD/YYYY'
    when 'DD/MM/YYYY' then 'DD/MM/YYYY'
    when 'DD.MM.YYYY' then 'DD.MM.YYYY'
    when 'MMM D, YYYY' then 'Mon FMDD, YYYY'
    when 'D MMMM YYYY' then 'FMDD FMMonth YYYY'
    else 'YYYY-MM-DD'
  end
$$;

-- A cell as the grid shows it: dates in the column's format (date-times in the
-- document's time zone), currency, percentages and fixed decimals.
create or replace function public._mail_value(c public.doc_columns, v jsonb, p_doc uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings jsonb;
  v_text text;
  n numeric;
  d int;
  v_dec text;
begin
  if v is null or v = 'null'::jsonb then
    return '';
  end if;
  begin
    if jsonb_typeof(v) = 'number' and c.type in ('Numeric', 'Int') then
      n := (v #>> '{}')::numeric;
      d := case when c.type = 'Int' then 0 else nullif(c.options->>'decimals', '')::int end;
      if c.options->>'numMode' = 'percent' then
        n := n * 100;
        return (case when d is null then trim(trailing '.' from trim(trailing '0' from round(n, 6)::text)) else round(n, d)::text end) || '%';
      elsif c.options->>'numMode' = 'currency' then
        select settings into v_settings from public.documents where id = p_doc;
        d := coalesce(d, 2);
        v_dec := case when d > 0 then 'D' || repeat('0', d) else '' end;
        return coalesce(nullif(c.options->>'currency', ''), nullif(v_settings->>'currency', ''), 'USD') || ' '
               || to_char(round(n, d), 'FM999G999G999G999G990' || v_dec);
      elsif d is not null then
        return round(n, d)::text;
      end if;
    elsif jsonb_typeof(v) = 'string' and c.type = 'Date' and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' then
      return to_char((v #>> '{}')::date, public._pg_date_format(c.options->>'dateFormat'));
    elsif jsonb_typeof(v) = 'string' and c.type = 'DateTime' and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T' then
      select settings into v_settings from public.documents where id = p_doc;
      return to_char((v #>> '{}')::timestamptz at time zone coalesce(nullif(v_settings->>'timezone', ''), 'UTC'),
                     public._pg_date_format(c.options->>'dateFormat') || ' HH24:MI');
    end if;
  exception when others then
    null; -- an odd value or time zone: fall back to the plain text below
  end;
  v_text := public._value_text(c, v);
  return coalesce(v_text, '');
end $$;

-- The value of one tag, or null when the tag isn't one we know.
-- p_ctx: who reads (for reference tags in documents with access rules).
create or replace function public._tag_value(p_name text, p_table uuid, p_record jsonb, p_vars jsonb, p_ctx jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  c public.doc_columns;
  c2 public.doc_columns;
  v_doc uuid;
  v_ref text;
  v_field text;
  v_target uuid;
  v_rec jsonb;
begin
  if lower(p_name) = 'id' then
    return coalesce(p_record->>'id', '');
  end if;
  if coalesce(p_vars, '{}'::jsonb) ? lower(p_name) then
    return coalesce(p_vars->>lower(p_name), '');
  end if;
  select t.doc_id into v_doc from public.doc_tables t where t.id = p_table;
  if p_name ~ '^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$' then
    v_ref := split_part(p_name, '.', 1);
    v_field := split_part(p_name, '.', 2);
    select * into c from public.doc_columns where table_ref = p_table and col_id = v_ref and type = 'Ref';
    v_target := nullif(c.options->>'refTable', '')::uuid;
    if c.id is null or v_target is null then
      return null;
    end if;
    select * into c2 from public.doc_columns where table_ref = v_target and col_id = v_field;
    if c2.id is null then
      return case when v_field = 'id' then coalesce(p_record->>c.col_id, '') end;
    end if;
    if jsonb_typeof(p_record->c.col_id) <> 'number' then
      return '';
    end if;
    v_rec := public._integration_records(v_doc, v_target, array[(p_record->>c.col_id)::bigint], coalesce(p_ctx, '{}'::jsonb)) -> 0;
    return public._mail_value(c2, v_rec->c2.col_id, v_doc);
  end if;
  select * into c from public.doc_columns where table_ref = p_table and (col_id = p_name or lower(label) = lower(p_name))
  order by (col_id = p_name) desc limit 1;
  if c.id is null then
    return null;
  end if;
  return public._mail_value(c, p_record->c.col_id, v_doc);
end $$;

-- Tags the sender fills itself (they need the app's address).
create or replace function public._tag_for_sender(p_name text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(p_name) in ('link', 'record_link')
$$;

-- Replaces tags with the record's values. Unknown tags are left as they are
-- (saving refuses them). With p_escape, values can't add Markdown of their own.
drop function if exists public._fill_template(text, uuid, jsonb);
create or replace function public._fill_template(
  p_text text, p_table uuid, p_record jsonb, p_vars jsonb default '{}'::jsonb, p_ctx jsonb default '{}'::jsonb, p_escape boolean default false
) returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_out text := coalesce(p_text, '');
  m text[];
  v_val text;
begin
  for m in select distinct regexp_matches(coalesce(p_text, ''), '(\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\})', 'g') loop
    continue when public._tag_for_sender(m[2]);
    v_val := public._tag_value(m[2], p_table, p_record, p_vars, p_ctx);
    continue when v_val is null;
    if btrim(v_val) = '' and m[3] is not null then
      v_val := btrim(m[3]);
    end if;
    if p_escape then
      v_val := regexp_replace(v_val, '([\\`*_\[\]()#>~|])', '\\\1', 'g');
    end if;
    v_out := replace(v_out, m[1], v_val);
  end loop;
  return v_out;
end $$;

-- The first tag in a text that means nothing for this table (null: all fine).
create or replace function public._template_problem(p_text text, p_table uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  m text[];
  v_vars jsonb := '{"doc": "", "table": "", "automation": "", "changed_by": ""}'::jsonb;
begin
  for m in select distinct regexp_matches(coalesce(p_text, ''), '\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}', 'g') loop
    continue when public._tag_for_sender(m[1]);
    if public._tag_value(m[1], p_table, '{}'::jsonb, v_vars, '{}'::jsonb) is null then
      return m[1];
    end if;
  end loop;
  return null;
end $$;

-- ============================================================
-- Saving: email actions are checked, tags included
-- ============================================================
create or replace function public.save_automation(p_doc uuid, p_auto jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_auto->>'id', '')::uuid;
  v_table uuid := (p_auto->>'table_ref')::uuid;
  v_watch uuid[];
  v_actions jsonb := coalesce(p_auto->'actions', '[]'::jsonb);
  v_ast jsonb := nullif(p_auto->'condition_ast', 'null'::jsonb);
  a jsonb;
  k text;
  v_bad text;
begin
  perform public._require_owner(p_doc);
  if not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
    raise exception 'Pick a table of this document';
  end if;
  select coalesce(array_agg(x::uuid), '{}') into v_watch from jsonb_array_elements_text(coalesce(p_auto->'watch_cols', '[]')) x;
  if exists (select 1 from unnest(v_watch) c where not exists (select 1 from public.doc_columns where id = c and table_ref = v_table)) then
    raise exception 'Watched columns must belong to the table';
  end if;
  if v_ast is not null then
    begin
      perform public._acl_bool(v_ast, p_doc, v_table, public._acl_ctx_me(p_doc) || '{"_newRec": "r"}'::jsonb, 0);
    exception when others then
      raise exception 'The condition can''t be used: %', sqlerrm;
    end;
  end if;
  if coalesce(jsonb_typeof(v_actions), '') <> 'array' or jsonb_array_length(v_actions) not between 1 and 5 then
    raise exception 'Add between 1 and 5 actions';
  end if;
  for a in select value from jsonb_array_elements(v_actions) loop
    if a->>'type' = 'email' then
      if length(btrim(coalesce(a->>'to', ''))) = 0 or length(a->>'to') > 1000 or length(coalesce(a->>'subject', '')) > 300
         or length(coalesce(a->>'body', '')) > 20000 then
        raise exception 'An email needs a "To" address, a subject of up to 300 characters and a message of up to 20,000';
      end if;
      if length(coalesce(a->>'cc', '')) > 1000 or length(coalesce(a->>'bcc', '')) > 1000 or length(coalesce(a->>'reply_to', '')) > 320
         or length(coalesce(a->>'from_name', '')) > 100 then
        raise exception 'CC, BCC, Reply-To or the sender name is too long';
      end if;
      if a->>'to' !~ '\{\{' and cardinality(public._mail_addresses(a->>'to')) = 0 then
        raise exception '"To" needs an email address or a placeholder such as {{Email}}';
      end if;
      foreach k in array array['to', 'cc', 'bcc', 'reply_to', 'from_name', 'subject', 'body'] loop
        v_bad := public._template_problem(a->>k, v_table);
        if v_bad is not null then
          raise exception 'Unknown placeholder {{%}}: use a column of this table, {{Reference.Column}}, or one of id, doc, table, automation, changed_by, link, record_link', v_bad;
        end if;
      end loop;
    elsif a->>'type' = 'webhook' then
      if not public._safe_url(coalesce(a->>'url', '')) then
        raise exception 'Webhook actions need an https:// address on the public internet';
      end if;
    else
      raise exception 'Unknown action type %', a->>'type';
    end if;
  end loop;
  if v_id is null then
    if (select count(*) from public.doc_automations where doc_id = p_doc) >= 50 then
      raise exception 'A document can have up to 50 automations';
    end if;
    insert into public.doc_automations (doc_id, table_ref, name, enabled, trigger, watch_cols, condition, condition_ast, actions, created_by)
    values (p_doc, v_table, left(coalesce(p_auto->>'name', ''), 120), coalesce((p_auto->>'enabled')::boolean, true),
            coalesce(p_auto->>'trigger', 'add_or_update'), v_watch, left(coalesce(p_auto->>'condition', ''), 4000), v_ast, v_actions, auth.uid())
    returning id into v_id;
  else
    update public.doc_automations set table_ref = v_table, name = left(coalesce(p_auto->>'name', ''), 120),
      enabled = coalesce((p_auto->>'enabled')::boolean, true), trigger = coalesce(p_auto->>'trigger', 'add_or_update'),
      watch_cols = v_watch, condition = left(coalesce(p_auto->>'condition', ''), 4000), condition_ast = v_ast,
      actions = v_actions, updated_at = now()
    where id = v_id and doc_id = p_doc;
    if not found then
      raise exception 'Automation not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end $$;

-- What an automation's emails would say for a record (the newest, or p_row),
-- without saving or sending anything.
create or replace function public.preview_automation(p_doc uuid, p_auto jsonb, p_row bigint default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_table uuid := (p_auto->>'table_ref')::uuid;
  v_row bigint := p_row;
  v_ctx jsonb;
  v_rec jsonb;
  v_vars jsonb;
  v_out jsonb := '[]'::jsonb;
  a jsonb;
  i int := -1;
  v_to text[];
begin
  perform public._require_owner(p_doc);
  if not exists (select 1 from public.doc_tables where id = v_table and doc_id = p_doc) then
    raise exception 'Pick a table of this document';
  end if;
  if v_row is null then
    select max(id) into v_row from public.doc_rows where table_ref = v_table;
  end if;
  if v_row is null then
    raise exception 'The table has no records to preview';
  end if;
  v_ctx := public._acl_ctx_me(p_doc) || '{"_newRec": "r"}'::jsonb;
  v_rec := public._integration_records(p_doc, v_table, array[v_row], v_ctx) -> 0;
  if v_rec is null then
    raise exception 'Record % can''t be read', v_row;
  end if;
  v_vars := jsonb_build_object(
    'doc', (select name from public.documents where id = p_doc),
    'table', (select table_id from public.doc_tables where id = v_table),
    'automation', coalesce(p_auto->>'name', ''),
    'changed_by', coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = auth.uid()), ''));
  for a in select value from jsonb_array_elements(coalesce(p_auto->'actions', '[]'::jsonb)) loop
    i := i + 1;
    continue when a->>'type' <> 'email';
    v_to := public._mail_addresses(public._fill_template(a->>'to', v_table, v_rec, v_vars, v_ctx));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'index', i,
      'to', to_jsonb(v_to[1:10]),
      'cc', to_jsonb((public._mail_addresses(public._fill_template(a->>'cc', v_table, v_rec, v_vars, v_ctx)))[1:10]),
      'bcc', to_jsonb((public._mail_addresses(public._fill_template(a->>'bcc', v_table, v_rec, v_vars, v_ctx)))[1:10]),
      'reply_to', (public._mail_addresses(public._fill_template(a->>'reply_to', v_table, v_rec, v_vars, v_ctx)))[1],
      'from_name', left(public._fill_template(a->>'from_name', v_table, v_rec, v_vars, v_ctx), 100),
      'subject', left(public._fill_template(a->>'subject', v_table, v_rec, v_vars, v_ctx), 300),
      'body', left(public._fill_template(a->>'body', v_table, v_rec, v_vars, v_ctx, true), 20000),
      'suppressed', coalesce((select jsonb_agg(s.email) from public.mail_suppressions s where s.email = any (v_to)), '[]'::jsonb),
      'problem', coalesce(public._template_problem(a->>'to', v_table), public._template_problem(a->>'subject', v_table),
                          public._template_problem(a->>'body', v_table))));
  end loop;
  return jsonb_build_object('row', v_row, 'emails', v_out);
end $$;

-- A renamed column keeps working in automation emails: {{Old}} becomes {{New}},
-- and {{Ref.Old}} in tables that point here.
create or replace function public.tg_automation_tags()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_tail text := '(\s*(\||\}\}|\.))';
begin
  if new.col_id is not distinct from old.col_id then
    return null;
  end if;
  update public.doc_automations a
  set actions = regexp_replace(a.actions::text, '(\{\{\s*)' || old.col_id || v_tail, '\1' || new.col_id || '\2', 'g')::jsonb
  where a.table_ref = new.table_ref and a.actions::text ~ ('\{\{\s*' || old.col_id || '\s*(\||\}\}|\.)');
  for r in select c.col_id, c.table_ref from public.doc_columns c where c.type = 'Ref' and c.options->>'refTable' = new.table_ref::text loop
    update public.doc_automations a
    set actions = regexp_replace(a.actions::text, '(\{\{\s*' || r.col_id || '\.)' || old.col_id || '(\s*(\||\}\}))', '\1' || new.col_id || '\2', 'g')::jsonb
    where a.table_ref = r.table_ref and a.actions::text ~ ('\{\{\s*' || r.col_id || '\.' || old.col_id || '\s*(\||\}\})');
  end loop;
  return null;
exception when others then
  raise warning 'automation tags: %', sqlerrm; -- never get in the way of renaming a column
  return null;
end $$;
create trigger doc_columns_automation_tags after update of col_id on public.doc_columns
  for each row execute function public.tg_automation_tags();

-- ============================================================
-- Delivery: suppressions, limits, more fields, error classes
-- ============================================================
create or replace function public.jobs_claim(p_secret text, p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.job_queue;
  w public.doc_webhooks;
  a public.doc_automations;
  v_act jsonb;
  v_ctx jsonb;
  v_recs jsonb;
  v_rec jsonb;
  v_to text[];
  v_all text[];
  v_cc text[];
  v_bcc text[];
  v_vars jsonb;
  v_max int;
  v_out jsonb := '[]'::jsonb;
  v_doc_name text;
  v_table_name text;
begin
  perform public._check_worker_secret(p_secret);
  -- Jobs left "running" by a crashed run go back in the queue.
  update public.job_queue set status = 'pending' where status = 'running' and started_at < now() - interval '5 minutes';
  for j in
    update public.job_queue q set status = 'running', attempts = q.attempts + 1, started_at = now()
    where q.id in (select id from public.job_queue where status = 'pending' and next_run_at <= now()
                   order by next_run_at, id limit least(greatest(p_limit, 1), 100) for update skip locked)
    returning q.*
  loop
    select d.name into v_doc_name from public.documents d where d.id = j.doc_id;
    select t.table_id into v_table_name from public.doc_tables t where t.id = (j.payload->>'table')::uuid;
    if j.kind = 'webhook' then
      select * into w from public.doc_webhooks where id = j.source_id;
      if w.id is null or not w.enabled then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'Webhook removed or turned off' where id = j.id;
        continue;
      end if;
      v_ctx := public._integration_ctx(j.doc_id, w.created_by) || '{"_newRec": "r"}'::jsonb;
      v_recs := public._integration_records(j.doc_id, w.table_ref,
                  array(select (x #>> '{}')::bigint from jsonb_array_elements(j.payload->'row_ids') x), v_ctx);
      if jsonb_array_length(v_recs) = 0 then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'The records no longer exist' where id = j.id;
        continue;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'webhook', 'url', w.url, 'secret', w.secret,
        'body', jsonb_build_object('event', 'records', 'document', j.doc_id, 'table', v_table_name, 'records', v_recs)));
    else
      select * into a from public.doc_automations where id = j.source_id;
      v_act := a.actions -> (j.payload->>'action_index')::int;
      if a.id is null or not a.enabled or v_act is null then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'Automation removed, turned off or changed' where id = j.id;
        continue;
      end if;
      v_ctx := public._integration_ctx(j.doc_id, a.created_by) || '{"_newRec": "r"}'::jsonb;
      v_rec := public._integration_records(j.doc_id, a.table_ref, array[(j.payload->>'row_id')::bigint], v_ctx) -> 0;
      if v_rec is null then
        update public.job_queue set status = 'skipped', finished_at = now(), last_error = 'The record no longer exists' where id = j.id;
        continue;
      end if;
      if v_act->>'type' = 'email' then
        v_vars := jsonb_build_object('doc', coalesce(v_doc_name, ''), 'table', coalesce(v_table_name, ''), 'automation', a.name,
          'changed_by', coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.doc_actions x
                                  join public.profiles p on p.id = x.author where x.id = (j.payload->>'action_id')::bigint), ''));
        v_all := public._mail_addresses(public._fill_template(v_act->>'to', a.table_ref, v_rec, v_vars, v_ctx));
        select coalesce(array_agg(x order by x), '{}') into v_to from unnest(v_all) x
        where not exists (select 1 from public.mail_suppressions s where s.email = x);
        if cardinality(v_to) = 0 then
          if cardinality(v_all) > 0 then
            update public.job_queue set status = 'skipped', finished_at = now(),
              last_error = 'Not sent: ' || array_to_string(v_all[1:3], ', ') || ' bounced or reported spam before' where id = j.id;
          else
            update public.job_queue set status = 'failed', finished_at = now(), last_error = 'No valid email address in "To"' where id = j.id;
          end if;
          continue;
        end if;
        if coalesce(j.payload->>'event', '') <> 'test' then
          -- The same email for the same record at most once a minute (loops, repeated saves).
          if exists (select 1 from public.job_queue q where q.source_id = j.source_id and q.id <> j.id and q.delivery is not null
                       and q.delivery <> 'failed' and q.payload->>'row_id' = j.payload->>'row_id'
                       and q.payload->>'action_index' = j.payload->>'action_index' and coalesce(q.payload->>'event', '') <> 'test'
                       and q.started_at > now() - interval '1 minute') then
            update public.job_queue set status = 'skipped', finished_at = now(),
              last_error = 'Already sent for this record in the last minute' where id = j.id;
            continue;
          end if;
          v_max := (public._doc_plan(j.doc_id)).max_emails_per_day;
          if v_max is not null and (select count(*) from public.job_queue q where q.doc_id = j.doc_id and q.delivery is not null
                                      and q.delivery <> 'failed' and q.started_at > now() - interval '1 day') >= v_max then
            update public.job_queue set status = 'skipped', finished_at = now(),
              last_error = format('Daily email limit reached (%s a day on this plan)', v_max) where id = j.id;
            continue;
          end if;
        end if;
        select coalesce(array_agg(x order by x), '{}') into v_cc
        from unnest(public._mail_addresses(public._fill_template(v_act->>'cc', a.table_ref, v_rec, v_vars, v_ctx))) x
        where x <> all (v_to) and not exists (select 1 from public.mail_suppressions s where s.email = x);
        select coalesce(array_agg(x order by x), '{}') into v_bcc
        from unnest(public._mail_addresses(public._fill_template(v_act->>'bcc', a.table_ref, v_rec, v_vars, v_ctx))) x
        where x <> all (v_to) and x <> all (v_cc) and not exists (select 1 from public.mail_suppressions s where s.email = x);
        update public.job_queue set delivery = 'queued' where id = j.id;
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'email', 'to', to_jsonb(v_to[1:10]),
          'cc', to_jsonb(v_cc[1:10]), 'bcc', to_jsonb(v_bcc[1:10]),
          'reply_to', (public._mail_addresses(public._fill_template(v_act->>'reply_to', a.table_ref, v_rec, v_vars, v_ctx)))[1],
          'from_name', nullif(left(btrim(public._fill_template(v_act->>'from_name', a.table_ref, v_rec, v_vars, v_ctx)), 100), ''),
          'subject', left(public._fill_template(v_act->>'subject', a.table_ref, v_rec, v_vars, v_ctx), 300),
          'text', left(public._fill_template(v_act->>'body', a.table_ref, v_rec, v_vars, v_ctx, true), 20000),
          'doc', j.doc_id, 'doc_name', v_doc_name, 'row', (j.payload->>'row_id')::bigint, 'table_ref', a.table_ref, 'automation', a.name,
          'test', coalesce(j.payload->>'event', '') = 'test'));
      elsif v_act->>'type' = 'webhook' then
        if not public._safe_url(v_act->>'url') then
          update public.job_queue set status = 'failed', finished_at = now(), last_error = 'Address not allowed' where id = j.id;
          continue;
        end if;
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', j.id, 'kind', 'webhook', 'url', v_act->>'url', 'secret', a.secret,
          'body', jsonb_build_object('event', j.payload->>'event', 'automation', a.name, 'document', j.doc_id,
                                     'table', v_table_name, 'record', v_rec)));
      else
        update public.job_queue set status = 'failed', finished_at = now(), last_error = 'Unknown action' where id = j.id;
      end if;
    end if;
  end loop;
  return v_out;
end $$;

-- Reports a job's result. Failures are retried with growing waits (30 s, 1, 2,
-- 4 ... up to 60 minutes) unless p_retry is false: a refused request, a wrong
-- key or an unverified sender won't get better by trying again.
drop function if exists public.jobs_done(text, bigint, text, int);
create or replace function public.jobs_done(p_secret text, p_id bigint, p_error text default null, p_status int default null, p_retry boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._check_worker_secret(p_secret);
  update public.job_queue set
    status = case when p_error is null then 'done' when attempts >= max_attempts or not coalesce(p_retry, true) then 'failed' else 'pending' end,
    finished_at = case when p_error is null or attempts >= max_attempts or not coalesce(p_retry, true) then now() end,
    next_run_at = case when p_error is null then next_run_at
                       else now() + least(interval '30 seconds' * power(2, greatest(attempts - 1, 0)), interval '60 minutes') end,
    delivery = case when delivery is null then null
                    when p_error is null then 'sent'
                    when attempts >= max_attempts or not coalesce(p_retry, true) then 'failed'
                    else delivery end,
    last_status = p_status,
    last_error = left(p_error, 1000)
  where id = p_id and status = 'running';
end $$;

-- ============================================================
-- Delivery events from SendGrid (the sendgrid-events Edge Function, after
-- checking the signature). Only events carrying our own marker are kept.
-- ============================================================
create or replace function public.mail_events_in(p_events jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  v_event text;
  v_job bigint;
  v_note bigint;
  v_doc uuid;
  v_email text;
  v_new bigint;
  n int := 0;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;
  for e in select value from jsonb_array_elements(p_events) loop
    continue when coalesce(e->>'lmdu_env', '') <> 'lmdu';
    v_event := case e->>'event'
      when 'delivered' then 'delivered'
      when 'deferred' then 'deferred'
      when 'bounce' then case when e->>'type' = 'blocked' then 'blocked' else 'bounced' end
      when 'dropped' then 'blocked'
      when 'spamreport' then 'spam'
    end;
    v_email := lower(btrim(coalesce(e->>'email', '')));
    continue when v_event is null or v_email = '';
    v_job := case when e->>'lmdu_job' ~ '^\d{1,18}$' then (e->>'lmdu_job')::bigint end;
    v_note := case when e->>'lmdu_note' ~ '^\d{1,18}$' then (e->>'lmdu_note')::bigint end;
    v_doc := null;
    if v_job is not null then
      select q.doc_id into v_doc from public.job_queue q where q.id = v_job;
      if v_doc is null then
        v_job := null; -- the delivery log row is gone
      end if;
    end if;
    v_new := null;
    insert into public.mail_events (job_id, notification_id, doc_id, email, event, reason, sg_event_id, at)
    values (v_job, v_note, v_doc, v_email, v_event, left(coalesce(e->>'reason', e->>'response', ''), 500), nullif(e->>'sg_event_id', ''),
            coalesce(to_timestamp(nullif(e->>'timestamp', '')::double precision), now()))
    on conflict (sg_event_id) do nothing
    returning id into v_new;
    continue when v_new is null;
    n := n + 1;
    if v_job is not null then
      -- A later, weaker event never hides a stronger one (a bounce stays a bounce).
      update public.job_queue set delivery = v_event
      where id = v_job and delivery is not null
        and (delivery in ('queued', 'sent', 'deferred') or (delivery = 'delivered' and v_event in ('bounced', 'spam')));
    end if;
    if v_event in ('bounced', 'spam') then
      insert into public.mail_suppressions (email, reason, detail)
      values (v_email, v_event, left(coalesce(e->>'reason', ''), 500))
      on conflict (email) do update set reason = excluded.reason, detail = excluded.detail, at = now();
    end if;
  end loop;
  update public.mail_config set last_event_at = now() where id and n > 0;
  return n;
end $$;

create or replace function public._mail_cleanup()
returns void language sql security definer set search_path = '' as $$
  delete from public.mail_events where at < now() - interval '90 days';
$$;
select cron.schedule('lmdu-mail-cleanup', '47 3 * * *', 'select public._mail_cleanup()');

-- ============================================================
-- Administrators: how email is doing, the bounce list, a test email
-- ============================================================
create or replace function public.admin_mail()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'status', public.email_status(),
    'week', jsonb_build_object(
      'sent', (select count(*) from public.job_queue where delivery in ('sent', 'delivered', 'deferred') and started_at > now() - interval '7 days'),
      'delivered', (select count(*) from public.job_queue where delivery = 'delivered' and started_at > now() - interval '7 days'),
      'failed', (select count(*) from public.job_queue where delivery = 'failed' and started_at > now() - interval '7 days'),
      'bounced', (select count(*) from public.mail_events where event in ('bounced', 'blocked') and at > now() - interval '7 days'),
      'spam', (select count(*) from public.mail_events where event = 'spam' and at > now() - interval '7 days'),
      'notices_sent', (select count(*) from public.notification_queue where sent_at > now() - interval '7 days')),
    'waiting', jsonb_build_object(
      'automation', (select count(*) from public.job_queue where status in ('pending', 'running')),
      'notices', (select count(*) from public.notification_queue where sent_at is null and attempts < 5),
      'notices_failed', (select count(*) from public.notification_queue where sent_at is null and attempts >= 5)),
    'suppressions', coalesce((select jsonb_agg(to_jsonb(s) order by s.at desc) from
                                (select * from public.mail_suppressions order by at desc limit 200) s), '[]'::jsonb));
end $$;

create or replace function public.admin_unsuppress(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  delete from public.mail_suppressions where email = lower(btrim(p_email));
end $$;

-- Queues a test email to the administrator's own address.
create or replace function public.admin_test_email()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
begin
  perform public._require_admin();
  select email into v_email from public.profiles where id = auth.uid();
  if coalesce(v_email, '') = '' then
    raise exception 'Your account has no email address';
  end if;
  insert into public.notification_queue (kind, to_email, payload)
  values ('test', v_email, jsonb_build_object('by', v_email));
  perform public._kick_notify();
  return v_email;
end $$;

-- ============================================================
-- Grants
-- ============================================================
revoke execute on function
  public.mail_report(text, boolean, text, text, text), public._mail_addresses(text), public._pg_date_format(text),
  public._mail_value(public.doc_columns, jsonb, uuid), public._tag_value(text, uuid, jsonb, jsonb, jsonb), public._tag_for_sender(text),
  public._fill_template(text, uuid, jsonb, jsonb, jsonb, boolean), public._template_problem(text, uuid), public.tg_automation_tags(),
  public.jobs_claim(text, int), public.jobs_done(text, bigint, text, int, boolean), public.mail_events_in(jsonb), public._mail_cleanup()
from public, anon, authenticated;
grant execute on function
  public.mail_report(text, boolean, text, text, text), public.jobs_claim(text, int),
  public.jobs_done(text, bigint, text, int, boolean), public.mail_events_in(jsonb)
to service_role;

revoke execute on function
  public.email_status(), public.save_automation(uuid, jsonb), public.preview_automation(uuid, jsonb, bigint),
  public.admin_mail(), public.admin_unsuppress(text), public.admin_test_email()
from public, anon;
grant execute on function
  public.email_status(), public.save_automation(uuid, jsonb), public.preview_automation(uuid, jsonb, bigint),
  public.admin_mail(), public.admin_unsuppress(text), public.admin_test_email()
to authenticated;

comment on table public.mail_config is 'LM Data Universe: one row saying whether email (SendGrid) is set up; written by the deliver / notify Edge Functions.';
comment on table public.mail_events is 'LM Data Universe: delivery events from SendGrid for this app''s emails (category lmdu).';
comment on table public.mail_suppressions is 'LM Data Universe: addresses that bounced or reported spam; not mailed again until an administrator clears them.';
