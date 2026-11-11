-- Phase 4: widgets and forms.
--
--  * doc_widgets.type gains 'calendar' and 'custom'.
--  * Public forms get a layout (options.formItems: fields, headings, text,
--    separators, field widths) and every field kind, reference pickers and
--    file uploads included. Each submitted value is checked against its
--    column type here, so a hand-made request can't store anything a form
--    couldn't. Trigger formulas still run in the formula worker, as before.
--  * Spam protection: per-visitor and per-form rate limits, a honeypot, and a
--    log of every submission (form_submissions_log). Visitors are identified
--    only by a hash of their address, salted per document.
--  * File uploads: form_upload_start hands out a one-time path in the
--    attachments bucket; a signed-out visitor may upload to exactly that path
--    for an hour. On submit the file becomes a normal attachment.
--  * Documents with access rules: a submission is checked as a signed-out
--    person with edit rights would be, and a reference picker only offers the
--    records a signed-out viewer may read.

alter table public.doc_widgets drop constraint if exists doc_widgets_type_check;
alter table public.doc_widgets add constraint doc_widgets_type_check
  check (type in ('table', 'card', 'card_list', 'chart', 'summary', 'form', 'calendar', 'custom'));

-- ============================================================
-- Tables
-- ============================================================
create table public.form_submissions_log (
  id bigint generated always as identity primary key,
  doc_id uuid not null references public.documents(id) on delete cascade,
  widget_id uuid references public.doc_widgets(id) on delete set null,
  client_hash text not null,
  outcome text not null check (outcome in ('ok', 'rate_limited', 'invalid', 'spam')),
  row_id bigint,
  detail text,
  created_at timestamptz not null default now()
);
create index form_submissions_log_client_idx on public.form_submissions_log (widget_id, client_hash, created_at desc);
create index form_submissions_log_doc_idx on public.form_submissions_log (doc_id, created_at desc);

create table public.form_uploads (
  id uuid primary key,                 -- becomes the attachment id
  doc_id uuid not null references public.documents(id) on delete cascade,
  widget_id uuid not null references public.doc_widgets(id) on delete cascade,
  col_id uuid not null,
  path text not null unique,
  file_name text not null,
  size bigint not null,
  mime text not null,
  client_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index form_uploads_client_idx on public.form_uploads (widget_id, client_hash, created_at desc);

-- Only reached through the functions below.
alter table public.form_submissions_log enable row level security;
alter table public.form_uploads enable row level security;
revoke all on public.form_submissions_log, public.form_uploads from anon, authenticated;

-- ============================================================
-- Helpers
-- ============================================================
-- The active form behind a share token (all nulls when there is none).
create or replace function public._form_widget(p_token text)
returns public.doc_widgets language sql stable security definer set search_path = '' as $$
  select w.* from public.form_shares s join public.doc_widgets w on w.id = s.widget_id
  where s.token = p_token and s.is_active and w.type = 'form'
$$;

-- Who is submitting: a hash of the client address, salted with the document id.
create or replace function public._form_client(p_doc uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  h json;
  ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  ip := coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''),
                 nullif(btrim(split_part(h->>'x-forwarded-for', ',', 1)), ''),
                 nullif(btrim(h->>'x-real-ip'), ''),
                 'unknown');
  return encode(sha256(convert_to(ip || '|' || p_doc::text, 'UTF8')), 'hex');
end $$;

-- The form's fields in order, from options.formItems (the builder) or the older options.fields.
create or replace function public._form_fields(p_widget public.doc_widgets)
returns table (col public.doc_columns, item jsonb, ord bigint)
language sql stable security definer set search_path = '' as $$
  select c, f.value, f.ordinality
  from jsonb_array_elements(case when jsonb_typeof(p_widget.options->'formItems') = 'array'
                                 then p_widget.options->'formItems'
                                 else coalesce(p_widget.options->'fields', '[]'::jsonb) end) with ordinality f
  join public.doc_columns c on c.id::text = f.value->>'col'
  where c.table_ref = p_widget.table_ref and not c.is_formula
    and coalesce(f.value->>'kind', 'field') = 'field'
  order by f.ordinality
$$;

-- SQL selecting the records of p_target a public form may offer as choices:
-- all of them, or in a document with access rules what a signed-out viewer may read.
create or replace function public._form_ref_sql(p_doc uuid, p_target uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if public._acl_ruled(p_doc) then
    return public._acl_read_sql(p_doc, p_target, public._acl_ctx(p_doc, null, 'viewer'));
  end if;
  return format('select r.id, r.table_ref, r.manual_sort, r.data, r.computed from public.doc_rows r '
                'where r.table_ref = %L and r.doc_id = %L', p_target, p_doc);
end $$;

-- The target table of a Ref / RefList column, if it belongs to the document.
create or replace function public._form_ref_target(p_doc uuid, p_col public.doc_columns)
returns uuid language sql stable security definer set search_path = '' as $$
  select t.id from public.doc_tables t
  where t.doc_id = p_doc and t.id::text = p_col.options->>'refTable'
$$;

-- Choices for a reference picker: [{id, label}], at most 1000, in table order.
create or replace function public._form_ref_choices(p_doc uuid, p_col public.doc_columns)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_target uuid := public._form_ref_target(p_doc, p_col);
  v_vis public.doc_columns;
  v_label text;
  v_out jsonb;
begin
  if v_target is null then
    return '[]'::jsonb;
  end if;
  select * into v_vis from public.doc_columns c
  where c.id::text = p_col.options->>'visibleCol' and c.table_ref = v_target;
  v_label := case when v_vis.id is null then '''#'' || x.id'
    else format('case when jsonb_typeof(x.%1$s -> %2$L) in (''string'', ''number'', ''boolean'') then x.%1$s ->> %2$L else '''' end',
                case when v_vis.is_formula then 'computed' else 'data' end, v_vis.id::text) end;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', x.id, ''label'', %s) order by x.manual_sort, x.id), ''[]''::jsonb) '
    'from (select * from (%s) y order by y.manual_sort, y.id limit 1000) x',
    v_label, public._form_ref_sql(p_doc, v_target))
  into v_out;
  return v_out;
end $$;

create or replace function public._form_ref_ok(p_doc uuid, p_col public.doc_columns, p_id bigint)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_target uuid := public._form_ref_target(p_doc, p_col);
  v_ok boolean;
begin
  if v_target is null or p_id is null then
    return false;
  end if;
  execute format('select exists (select 1 from (%s) y where y.id = $1)', public._form_ref_sql(p_doc, v_target))
  into v_ok using p_id;
  return v_ok;
end $$;

create or replace function public._form_fail(p_label text, p_msg text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception '“%”: %', p_label, p_msg using errcode = 'PF001';
end $$;

-- A submitted value, checked and converted for its column. Raises PF001 with
-- a message meant for the visitor. Attachments: claims the uploaded files.
create or replace function public._form_value(
  p_doc uuid, p_col public.doc_columns, p_label text, v jsonb, p_widget uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t text := jsonb_typeof(v);
  s text;
  x jsonb;
  v_out jsonb := '[]'::jsonb;
  v_choices jsonb := coalesce(p_col.options->'choices', '[]'::jsonb);
  u public.form_uploads;
  v_meta jsonb;
begin
  case p_col.type
    when 'Text', 'Any' then
      if t in ('number', 'boolean') then
        v := to_jsonb(v #>> '{}');
      elsif t <> 'string' then
        perform public._form_fail(p_label, 'please enter text');
      end if;
      if length(v #>> '{}') > 10000 then
        perform public._form_fail(p_label, 'this text is too long (10,000 characters at most)');
      end if;
      return v;

    when 'Numeric', 'Int' then
      if t = 'string' and btrim(v #>> '{}') ~ '^-?\d+(\.\d+)?([eE][-+]?\d+)?$' then
        v := to_jsonb(btrim(v #>> '{}')::numeric);
        t := 'number';
      end if;
      if t <> 'number' then
        perform public._form_fail(p_label, 'please enter a number');
      end if;
      if p_col.type = 'Int' and (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
        perform public._form_fail(p_label, 'please enter a whole number');
      end if;
      return v;

    when 'Bool' then
      if t <> 'boolean' then
        perform public._form_fail(p_label, 'please answer yes or no');
      end if;
      return v;

    when 'Date' then
      s := v #>> '{}';
      if t <> 'string' or s !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public._form_fail(p_label, 'please enter a date');
      end if;
      begin
        perform s::date;
      exception when others then
        perform public._form_fail(p_label, 'please enter a real date');
      end;
      return v;

    when 'DateTime' then
      if t <> 'string' then
        perform public._form_fail(p_label, 'please enter a date and time');
      end if;
      begin
        return to_jsonb(to_char((v #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      exception when others then
        perform public._form_fail(p_label, 'please enter a date and time');
      end;

    when 'Choice' then
      if t <> 'string' or (jsonb_array_length(v_choices) > 0 and not v_choices @> jsonb_build_array(v)) then
        perform public._form_fail(p_label, 'please pick one of the listed options');
      end if;
      return v;

    when 'ChoiceList' then
      if t <> 'array' or jsonb_array_length(v) > 100 then
        perform public._form_fail(p_label, 'please pick from the listed options');
      end if;
      for x in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(x) <> 'string' or (jsonb_array_length(v_choices) > 0 and not v_choices @> jsonb_build_array(x)) then
          perform public._form_fail(p_label, 'please pick from the listed options');
        end if;
      end loop;
      return v;

    when 'Ref' then
      if t = 'string' and (v #>> '{}') ~ '^\d{1,18}$' then
        v := to_jsonb((v #>> '{}')::bigint);
        t := 'number';
      end if;
      if t <> 'number' or (v #>> '{}') !~ '^\d{1,18}$' or not public._form_ref_ok(p_doc, p_col, (v #>> '{}')::bigint) then
        perform public._form_fail(p_label, 'please pick one of the listed records');
      end if;
      return v;

    when 'RefList' then
      if t <> 'array' or jsonb_array_length(v) > 100 then
        perform public._form_fail(p_label, 'please pick from the listed records');
      end if;
      for x in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(x) <> 'number' or (x #>> '{}') !~ '^\d{1,18}$'
           or not public._form_ref_ok(p_doc, p_col, (x #>> '{}')::bigint) then
          perform public._form_fail(p_label, 'please pick from the listed records');
        end if;
        v_out := v_out || jsonb_build_array(x);
      end loop;
      return v_out;

    when 'Attachments' then
      if t <> 'array' or jsonb_array_length(v) > 10 then
        perform public._form_fail(p_label, 'up to 10 files can be attached');
      end if;
      for x in select value from jsonb_array_elements(v) loop
        u := null;
        select * into u from public.form_uploads f
        where f.id::text = (x #>> '{}') and f.widget_id = p_widget and f.col_id = p_col.id and f.used_at is null
        for update;
        if u.id is null then
          perform public._form_fail(p_label, 'a file is missing, please attach it again');
        end if;
        select o.metadata into v_meta from storage.objects o where o.bucket_id = 'attachments' and o.name = u.path;
        if not found then
          perform public._form_fail(p_label, 'a file did not finish uploading, please attach it again');
        end if;
        if coalesce((v_meta->>'size')::bigint, u.size) > 10485760 then
          perform public._form_fail(p_label, 'files can be up to 10 MB');
        end if;
        insert into public.doc_attachments (id, doc_id, file_name, size, mime, path, created_by)
        values (u.id, p_doc, u.file_name, coalesce((v_meta->>'size')::bigint, u.size),
                coalesce(nullif(v_meta->>'mimetype', ''), u.mime), u.path, null);
        update public.form_uploads set used_at = now() where id = u.id;
        v_out := v_out || jsonb_build_array(u.id::text);
      end loop;
      return v_out;

    else
      perform public._form_fail(p_label, 'this field can''t be filled in on a form');
  end case;
  return null;
end $$;

-- ============================================================
-- Public API (signed-out visitors)
-- ============================================================
create or replace function public.get_public_form(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  w public.doc_widgets := public._form_widget(p_token);
  o jsonb;
  it record;
  v_items jsonb := '[]'::jsonb;
  v_legacy jsonb := '[]'::jsonb;
  v_field jsonb;
  v_label text;
  v_opts jsonb;
begin
  if w.id is null then
    return null;
  end if;
  o := w.options;
  for it in
    select f.value as item, c.id as col_id
    from jsonb_array_elements(case when jsonb_typeof(o->'formItems') = 'array' then o->'formItems'
                                   else coalesce(o->'fields', '[]'::jsonb) end) with ordinality f
    left join public.doc_columns c on c.id::text = f.value->>'col' and c.table_ref = w.table_ref and not c.is_formula
    order by f.ordinality
  loop
    case coalesce(it.item->>'kind', 'field')
      when 'heading', 'text' then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', it.item->>'kind', 'text', left(coalesce(it.item->>'text', ''), 5000)));
      when 'separator' then
        v_items := v_items || '[{"kind": "separator"}]'::jsonb;
      when 'field' then
        continue when it.col_id is null;
        declare
          c public.doc_columns;
        begin
          select * into c from public.doc_columns where id = it.col_id;
          v_label := coalesce(nullif(btrim(it.item->>'label'), ''), nullif(c.label, ''), c.col_id);
          v_opts := c.options - array['refTable', 'visibleCol', 'dropdownCondition', 'rules', 'style', 'headerStyle',
                                      'trigger', 'reverseCol', 'reverseSecondary'];
          v_field := jsonb_build_object(
            'kind', 'field', 'id', c.id, 'label', v_label, 'type', c.type, 'options', v_opts,
            'required', it.item->'required' = 'true'::jsonb,
            'help', left(coalesce(it.item->>'help', ''), 2000),
            'width', case when it.item->>'width' in ('half', 'third') then it.item->>'width' else 'full' end,
            'display', case when it.item->>'display' in ('radio', 'dropdown', 'checkboxes', 'switch') then it.item->>'display' else '' end);
          if c.type in ('Ref', 'RefList') then
            v_field := v_field || jsonb_build_object('choices', public._form_ref_choices(w.doc_id, c));
          end if;
          v_items := v_items || jsonb_build_array(v_field);
          -- The form page from before Phase 4 only knows plain fields.
          if c.type not in ('Ref', 'RefList', 'Attachments') then
            v_legacy := v_legacy || jsonb_build_array(jsonb_build_object(
              'id', c.id, 'label', v_label, 'type', c.type, 'options', v_opts,
              'required', it.item->'required' = 'true'::jsonb, 'help', left(coalesce(it.item->>'help', ''), 2000)));
          end if;
        end;
      else
        null;
    end case;
  end loop;
  return jsonb_build_object(
    'title', coalesce(nullif(o->>'formTitle', ''), nullif(w.title, ''), 'Form'),
    'description', coalesce(o->>'formDescription', ''),
    'submitLabel', coalesce(nullif(o->>'submitLabel', ''), 'Submit'),
    'successMessage', coalesce(nullif(o->>'successMessage', ''), 'Thank you! Your response has been recorded.'),
    'redirectUrl', case when o->>'redirectUrl' ~* '^https?://[^\s]+$' then o->>'redirectUrl' else '' end,
    'submitAnother', coalesce(o->'submitAnother', 'true'::jsonb) <> 'false'::jsonb,
    'maxUploadBytes', 10485760,
    'items', v_items,
    'fields', v_legacy);
end $$;

-- Starts a file upload for a file field: returns {id, path}. The visitor
-- then uploads the file to exactly that path in the attachments bucket.
create or replace function public.form_upload_start(p_token text, p_col uuid, p_file_name text, p_size bigint, p_mime text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.doc_widgets := public._form_widget(p_token);
  v_client text;
  v_id uuid := gen_random_uuid();
  v_name text;
  v_path text;
begin
  if w.id is null then
    raise exception 'This form is not accepting responses';
  end if;
  if not exists (select 1 from public._form_fields(w) f where (f.col).id = p_col and (f.col).type = 'Attachments') then
    raise exception 'This form has no such file field';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'Files on this form can be up to 10 MB';
  end if;
  v_client := public._form_client(w.doc_id);
  if (select count(*) from public.form_uploads u
      where u.widget_id = w.id and u.client_hash = v_client and u.created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'Too many files were sent from here. Please wait a few minutes and try again.';
  end if;
  v_name := btrim(left(regexp_replace(regexp_replace(coalesce(p_file_name, ''), '[\\/]+', '_', 'g'), '[^\w.\- ()]+', '_', 'g'), 200));
  if v_name = '' then
    v_name := 'file';
  end if;
  v_path := w.doc_id::text || '/' || v_id::text || '/' || v_name;
  insert into public.form_uploads (id, doc_id, widget_id, col_id, path, file_name, size, mime, client_hash)
  values (v_id, w.doc_id, w.id, p_col, v_path, left(coalesce(nullif(btrim(p_file_name), ''), 'file'), 255), p_size,
          left(coalesce(nullif(btrim(p_mime), ''), 'application/octet-stream'), 255), v_client);
  return jsonb_build_object('id', v_id, 'path', v_path);
end $$;

-- Storage policy helper: may a signed-out visitor upload to this path?
create or replace function public._form_upload_pending(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.form_uploads u join public.form_shares s on s.widget_id = u.widget_id and s.is_active
    where u.path = p_path and u.used_at is null and u.created_at > now() - interval '1 hour')
$$;

create policy "Form visitors upload to issued paths" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'attachments' and public._form_upload_pending(name));

-- Submits a response. Returns {ok: true, row} or {ok: false, error}; refusals
-- are returned rather than raised so that they are logged.
create or replace function public.submit_form(p_token text, p_values jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.doc_widgets := public._form_widget(p_token);
  v_client text;
  v_data jsonb := '{}'::jsonb;
  f record;
  v_val jsonb;
  v_label text;
  v_op jsonb;
  v_res jsonb;
  v_row bigint;
  v_err text;
  v_detail text;
  v_state text;
begin
  if w.id is null then
    return jsonb_build_object('ok', false, 'error', 'This form is not accepting responses.');
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' or pg_column_size(p_values) > 262144 then
    return jsonb_build_object('ok', false, 'error', 'This response could not be read.');
  end if;
  v_client := public._form_client(w.doc_id);

  -- Honeypot: a field people never see. Whatever fills it gets a normal "thank you".
  if coalesce(p_meta->>'hp', '') <> '' then
    insert into public.form_submissions_log (doc_id, widget_id, client_hash, outcome)
    values (w.doc_id, w.id, v_client, 'spam');
    return jsonb_build_object('ok', true);
  end if;

  -- Rate limits: 5 a minute and 100 a day from one visitor, 500 an hour in all.
  if (select count(*) from public.form_submissions_log l
      where l.widget_id = w.id and l.client_hash = v_client and l.outcome = 'ok' and l.created_at > now() - interval '1 minute') >= 5
     or (select count(*) from public.form_submissions_log l
         where l.widget_id = w.id and l.client_hash = v_client and l.outcome = 'ok' and l.created_at > now() - interval '1 day') >= 100
     or (select count(*) from public.form_submissions_log l
         where l.widget_id = w.id and l.outcome = 'ok' and l.created_at > now() - interval '1 hour') >= 500 then
    if not exists (select 1 from public.form_submissions_log l
                   where l.widget_id = w.id and l.client_hash = v_client and l.outcome = 'rate_limited'
                     and l.created_at > now() - interval '1 minute') then
      insert into public.form_submissions_log (doc_id, widget_id, client_hash, outcome)
      values (w.doc_id, w.id, v_client, 'rate_limited');
    end if;
    return jsonb_build_object('ok', false, 'error', 'Too many responses were sent from here. Please wait a few minutes and try again.');
  end if;

  begin
    for f in select * from public._form_fields(w) loop
      v_label := coalesce(nullif(btrim(f.item->>'label'), ''), nullif((f.col).label, ''), (f.col).col_id);
      v_val := p_values -> ((f.col).id::text);
      if v_val is null or v_val = 'null'::jsonb or v_val = '[]'::jsonb
         or (jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') = '') then
        if f.item->'required' = 'true'::jsonb then
          perform public._form_fail(v_label, 'this field is required');
        end if;
        continue;
      end if;
      v_data := v_data || jsonb_build_object((f.col).id::text, public._form_value(w.doc_id, f.col, v_label, v_val, w.id));
    end loop;
    v_op := jsonb_build_object('op', 'AddRecords', 'table', w.table_ref,
                               'records', jsonb_build_array(jsonb_build_object('data', v_data)));
    if public._acl_ruled(w.doc_id) then
      perform public._acl_check_op(w.doc_id, v_op, public._acl_ctx(w.doc_id, null, 'editor'));
    end if;
    v_res := public._apply_and_log(w.doc_id, jsonb_build_array(v_op), 'do', null, false, 'form');
    v_row := (v_res->'results'->0->>0)::bigint;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_detail = message_text;
    v_err := case when v_state = 'PF001' then v_detail
                  when v_state = '42501' then 'This form can''t accept responses right now.'
                  else 'Your response could not be saved. Please try again.' end;
  end;

  insert into public.form_submissions_log (doc_id, widget_id, client_hash, outcome, row_id, detail)
  values (w.doc_id, w.id, v_client, case when v_err is null then 'ok' else 'invalid' end, v_row, left(v_detail, 500));
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return jsonb_build_object('ok', true, 'row', v_row);
end $$;

-- The form page from before Phase 4 calls this one.
create or replace function public.submit_public_form(p_token text, p_values jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := public.submit_form(p_token, p_values, '{}'::jsonb);
begin
  if not coalesce((r->>'ok')::boolean, false) then
    raise exception '%', r->>'error';
  end if;
  return true;
end $$;

-- ============================================================
-- For editors: how a form is doing
-- ============================================================
create or replace function public.form_stats(p_widget uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc uuid;
  v_out jsonb;
begin
  select doc_id into v_doc from public.doc_widgets where id = p_widget and type = 'form';
  if v_doc is null or coalesce(public.doc_role(v_doc), '') not in ('owner', 'editor') then
    raise exception 'Form not found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'ok_7d', count(*) filter (where outcome = 'ok'),
    'refused_7d', count(*) filter (where outcome in ('invalid', 'rate_limited')),
    'spam_7d', count(*) filter (where outcome = 'spam'),
    'last_ok', max(created_at) filter (where outcome = 'ok'),
    'last_refusal', (select jsonb_build_object('at', l.created_at, 'outcome', l.outcome, 'detail', l.detail)
                     from public.form_submissions_log l
                     where l.widget_id = p_widget and l.outcome in ('invalid', 'rate_limited')
                     order by l.created_at desc, l.id desc limit 1))
  into v_out
  from public.form_submissions_log
  where widget_id = p_widget and created_at > now() - interval '7 days';
  return v_out;
end $$;

-- ============================================================
-- Housekeeping: drop old log entries and unused upload slots.
-- (Files uploaded but never submitted stay in storage.)
-- ============================================================
create or replace function public._form_cleanup()
returns void language sql security definer set search_path = '' as $$
  delete from public.form_submissions_log where created_at < now() - interval '30 days';
  delete from public.form_uploads where used_at is null and created_at < now() - interval '2 days';
$$;
select cron.schedule('lmdu-form-cleanup', '41 3 * * *', 'select public._form_cleanup()');

-- ============================================================
-- Grants
-- ============================================================
revoke execute on function
  public._form_widget(text), public._form_client(uuid), public._form_fields(public.doc_widgets),
  public._form_ref_sql(uuid, uuid), public._form_ref_target(uuid, public.doc_columns),
  public._form_ref_choices(uuid, public.doc_columns), public._form_ref_ok(uuid, public.doc_columns, bigint),
  public._form_fail(text, text), public._form_value(uuid, public.doc_columns, text, jsonb, uuid),
  public._form_cleanup(), public.form_stats(uuid)
from public, anon, authenticated;
-- The storage policy calls this as the uploading role.
grant execute on function public._form_upload_pending(text) to anon, authenticated;
grant execute on function public.form_stats(uuid) to authenticated;
grant execute on function
  public.get_public_form(text), public.form_upload_start(text, uuid, text, bigint, text),
  public.submit_form(text, jsonb, jsonb), public.submit_public_form(text, jsonb)
to anon, authenticated;
