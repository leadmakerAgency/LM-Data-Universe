-- Board, Timeline and Gallery widgets; file versions, thumbnails and import
-- history. (docs/views-and-files-plan.md.) Schema public only, all additive.

-- ============================================================
-- Three more widget types. Their settings live in doc_widgets.options.
-- ============================================================
alter table public.doc_widgets drop constraint if exists doc_widgets_type_check;
alter table public.doc_widgets add constraint doc_widgets_type_check
  check (type in ('table', 'card', 'card_list', 'chart', 'summary', 'form', 'calendar', 'custom', 'board', 'timeline', 'gallery'));

-- ============================================================
-- Files: versions, what a file is, thumbnails
-- ============================================================
-- A new version is a new row pointing at the one it replaces; the cell then
-- holds the new id (an ordinary, undoable cell change). Old versions stay.
alter table public.doc_attachments
  add column version int not null default 1 check (version >= 1),
  add column replaces uuid references public.doc_attachments(id) on delete set null,
  add column note text check (note is null or length(note) <= 500),
  add column sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- For CSV / Excel files: {"rows": 1204, "cols": 9, "headers": ["Name", …], "sheets": 1}
  add column table_info jsonb check (table_info is null or (jsonb_typeof(table_info) = 'object' and pg_column_size(table_info) < 16384)),
  -- A small preview image stored next to the file.
  add column thumb_path text;
alter table public.doc_attachments add constraint doc_attachments_thumb_path_check
  check (thumb_path is null or thumb_path like doc_id::text || '/%');
create index doc_attachments_replaces_idx on public.doc_attachments (replaces) where replaces is not null;
create index doc_attachments_sha_idx on public.doc_attachments (doc_id, sha256) where sha256 is not null;

-- ============================================================
-- Import history: which file (and version) a table's records came from
-- ============================================================
create table public.doc_imports (
  id bigint generated always as identity primary key,
  doc_id uuid not null references public.documents(id) on delete cascade,
  attachment_id uuid references public.doc_attachments(id) on delete set null,
  file_name text not null check (length(file_name) between 1 and 255),
  file_version int,
  sheet text,
  table_ref uuid references public.doc_tables(id) on delete cascade,
  mode text not null check (mode in ('new', 'add', 'update')),
  -- [{"header": "Email", "col": "<column uuid>"}, …] and the key columns for "update"
  mapping jsonb not null default '[]'::jsonb check (pg_column_size(mapping) < 65536),
  key_cols uuid[] not null default '{}',
  rows_added int not null default 0,
  rows_updated int not null default 0,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index doc_imports_doc_idx on public.doc_imports (doc_id, created_at desc);
create index doc_imports_attachment_idx on public.doc_imports (attachment_id) where attachment_id is not null;
create index doc_imports_table_idx on public.doc_imports (table_ref);

alter table public.doc_imports enable row level security;
-- Editors and owners see and write the history (it names files and tables, not their contents).
create policy doc_imports_select on public.doc_imports for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(2))::uuid[]));
create policy doc_imports_insert on public.doc_imports for insert to authenticated
  with check (doc_id = any ((select public.my_doc_ids(2))::uuid[]) and created_by = (select auth.uid()));
revoke all on public.doc_imports from anon;
revoke update, delete on public.doc_imports from authenticated;

comment on table public.doc_imports is 'LM Data Universe: one row per import of a CSV / Excel file into a table (which file and version, where to, how many records).';
comment on column public.doc_attachments.replaces is 'The earlier version of this file, if it is a new version.';
