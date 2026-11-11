-- Phase 1: docked widget layout per page. The tree is stored as jsonb:
--   {"dir": "row" | "col", "children": [{"widget": "<uuid>", "size": 1} | {...nested}]}
-- An empty object means "no saved layout": widgets are shown in position order.
-- Updates go through apply_actions (Update on entity "page"), which already
-- patches any existing column, so no RPC change is needed.
-- Column and widget options (styles, rules, trigger, frozen columns, saved
-- sort/filter, card layout) live in the existing options jsonb columns.

alter table public.doc_pages
  add column if not exists layout jsonb not null default '{}'::jsonb;

alter table public.doc_pages
  add constraint doc_pages_layout_is_object check (jsonb_typeof(layout) = 'object');
