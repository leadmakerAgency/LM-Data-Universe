-- Same fix as for documents and workspaces: INSERT ... RETURNING checks the
-- SELECT policy before the AFTER trigger has made the creator a member.
drop policy teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated
  using (id = any ((select public.my_team_ids(1))::uuid[]) or created_by = (select auth.uid()));
