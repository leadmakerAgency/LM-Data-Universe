-- INSERT ... RETURNING checks the SELECT policy against the new row, but the
-- membership helpers can't see rows written by the same statement (or its
-- AFTER triggers). Let readers also match on the parent workspace / owner.
drop policy documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (
    id = any ((select public.my_doc_ids(1))::uuid[])
    or workspace_id = any ((select public.my_workspace_ids(1))::uuid[])
  );

drop policy workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (
    id = any ((select public.my_workspace_ids(1))::uuid[])
    or owner_id = (select auth.uid())
  );
