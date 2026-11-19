-- Indexes for foreign keys that had none.
--
-- Without them, every delete on the referenced side scans the referencing
-- table: removing a document (or purging the trash) checked doc_actions once
-- per logged action through target_id, deleting a table scanned doc_widgets,
-- deleting a column scanned doc_comments, and so on. These tables grow with
-- use, so the cost grew with them. All additive; nothing else changes.

-- Action log: undo/redo entries point at the action they undo.
create index if not exists doc_actions_target_idx on public.doc_actions (target_id) where target_id is not null;

-- Widgets: by table (removed with it) and by what they are linked to.
create index if not exists doc_widgets_table_idx on public.doc_widgets (table_ref);
create index if not exists doc_widgets_link_source_idx on public.doc_widgets (link_source) where link_source is not null;
create index if not exists doc_widgets_link_col_idx on public.doc_widgets (link_col) where link_col is not null;

-- Comments: replies by thread, and by column (removed with it).
create index if not exists doc_comments_parent_idx on public.doc_comments (parent_id) where parent_id is not null;
create index if not exists doc_comments_col_idx on public.doc_comments (col_id);

-- Invites waiting for a sign-up, by what they give access to.
create index if not exists pending_invites_doc_idx on public.pending_invites (doc_id) where doc_id is not null;
create index if not exists pending_invites_workspace_idx on public.pending_invites (workspace_id) where workspace_id is not null;
create index if not exists pending_invites_team_idx on public.pending_invites (team_id) where team_id is not null;

-- Copies made with "Work on a copy" point at their original.
create index if not exists documents_forked_from_idx on public.documents (forked_from) where forked_from is not null;

-- Form upload slots, access rules, user attributes and integrations, by document, table or column.
create index if not exists form_uploads_doc_idx on public.form_uploads (doc_id);
create index if not exists doc_access_rules_table_idx on public.doc_access_rules (table_ref) where table_ref is not null;
create index if not exists doc_user_attributes_table_idx on public.doc_user_attributes (table_ref);
create index if not exists doc_user_attributes_match_col_idx on public.doc_user_attributes (match_col);
create index if not exists doc_webhooks_table_idx on public.doc_webhooks (table_ref);
create index if not exists doc_webhooks_ready_col_idx on public.doc_webhooks (ready_col) where ready_col is not null;
create index if not exists doc_automations_table_idx on public.doc_automations (table_ref);
