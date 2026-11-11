-- Public forms can't upload files yet (Phase 4 adds signed uploads), so an
-- Attachments column is never shown on, or written by, a public form: an
-- anonymous submitter must not be able to put arbitrary ids into such a cell.

create or replace function public.get_public_form(p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_widget public.doc_widgets;
  v_fields jsonb;
begin
  select w.* into v_widget
  from public.form_shares s join public.doc_widgets w on w.id = s.widget_id
  where s.token = p_token and s.is_active;
  if v_widget.id is null then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'label', coalesce(nullif(c.label, ''), c.col_id), 'type', c.type,
      'options', c.options - 'refTable', 'required', coalesce((f.value->>'required')::boolean, false),
      'help', coalesce(f.value->>'help', '')
    ) order by f.ordinality), '[]'::jsonb)
  into v_fields
  from jsonb_array_elements(coalesce(v_widget.options->'fields', '[]'::jsonb)) with ordinality f
  join public.doc_columns c on c.id = (f.value->>'col')::uuid
  where c.table_ref = v_widget.table_ref and not c.is_formula
    and c.type not in ('Ref', 'RefList', 'Attachments');
  return jsonb_build_object(
    'title', coalesce(nullif(v_widget.options->>'formTitle', ''), nullif(v_widget.title, ''), 'Form'),
    'description', coalesce(v_widget.options->>'formDescription', ''),
    'submitLabel', coalesce(nullif(v_widget.options->>'submitLabel', ''), 'Submit'),
    'successMessage', coalesce(nullif(v_widget.options->>'successMessage', ''), 'Thank you! Your response has been recorded.'),
    'fields', v_fields
  );
end $function$;

create or replace function public.submit_public_form(p_token text, p_values jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_widget public.doc_widgets;
  v_data jsonb := '{}'::jsonb;
  v_field record;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' or pg_column_size(p_values) > 65536 then
    raise exception 'Invalid submission';
  end if;
  select w.* into v_widget
  from public.form_shares s join public.doc_widgets w on w.id = s.widget_id
  where s.token = p_token and s.is_active;
  if v_widget.id is null then
    raise exception 'This form is not accepting responses';
  end if;
  for v_field in
    select c.id, coalesce((f.value->>'required')::boolean, false) as required
    from jsonb_array_elements(coalesce(v_widget.options->'fields', '[]'::jsonb)) f
    join public.doc_columns c on c.id = (f.value->>'col')::uuid
    where c.table_ref = v_widget.table_ref and not c.is_formula and c.type not in ('Ref', 'RefList', 'Attachments')
  loop
    if p_values ? v_field.id::text and p_values->(v_field.id::text) <> 'null'::jsonb
       and p_values->(v_field.id::text) <> '""'::jsonb then
      v_data := v_data || jsonb_build_object(v_field.id::text, p_values->(v_field.id::text));
    elsif v_field.required then
      raise exception 'Please fill in all required fields';
    end if;
  end loop;
  perform public._apply_and_log(
    v_widget.doc_id,
    jsonb_build_array(jsonb_build_object('op', 'AddRecords', 'table', v_widget.table_ref,
      'records', jsonb_build_array(jsonb_build_object('data', v_data)))),
    'do', null, false, 'form');
  return true;
end $function$;
