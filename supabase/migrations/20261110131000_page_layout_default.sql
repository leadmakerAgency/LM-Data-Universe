-- Fix: pages added through apply_actions failed after doc_pages.layout became
-- NOT NULL, because the insert builds the whole row from these defaults.
create or replace function public._entity_defaults(p_entity text)
returns jsonb language sql volatile set search_path = '' as $$
  select case p_entity
    when 'table' then jsonb_build_object('id', gen_random_uuid(), 'position', 0, 'created_at', now())
    when 'column' then jsonb_build_object('id', gen_random_uuid(), 'label', '', 'type', 'Any', 'is_formula', false,
      'formula', '', 'options', '{}'::jsonb, 'position', 0, 'created_at', now())
    when 'page' then jsonb_build_object('id', gen_random_uuid(), 'position', 0, 'layout', '{}'::jsonb, 'created_at', now())
    when 'widget' then jsonb_build_object('id', gen_random_uuid(), 'title', '', 'position', 0, 'width', 12,
      'height', 420, 'options', '{}'::jsonb, 'link_source', null, 'link_col', null, 'created_at', now())
  end
$$;
