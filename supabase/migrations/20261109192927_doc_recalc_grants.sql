-- doc_recalc is written only by the trigger and the worker functions (both
-- security definer). Row-level security already blocks client writes; remove
-- the default table grants too so the intent is explicit.
revoke insert, update, delete, truncate, references, trigger on public.doc_recalc from authenticated, anon;
revoke all on public.doc_recalc from anon;
