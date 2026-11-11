-- Attachments column type: files live in the private "attachments" Storage
-- bucket under {doc_id}/{attachment id}/{file name}; a cell stores a list of
-- attachment ids, and doc_attachments holds each file's metadata.

alter table public.doc_columns drop constraint doc_columns_type_check;
alter table public.doc_columns add constraint doc_columns_type_check check (type in (
  'Any', 'Text', 'Numeric', 'Int', 'Bool', 'Date', 'DateTime',
  'Choice', 'ChoiceList', 'Ref', 'RefList', 'Attachments'
));

create table public.doc_attachments (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.documents(id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 255),
  size bigint not null default 0,
  mime text not null default 'application/octet-stream',
  path text not null unique,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (path like doc_id::text || '/%')
);
create index doc_attachments_doc_idx on public.doc_attachments (doc_id);

alter table public.doc_attachments enable row level security;
create policy doc_attachments_select on public.doc_attachments for select to authenticated
  using (doc_id = any ((select public.my_doc_ids(1))::uuid[]));
create policy doc_attachments_insert on public.doc_attachments for insert to authenticated
  with check (doc_id = any ((select public.my_doc_ids(2))::uuid[]) and created_by = (select auth.uid()));
create policy doc_attachments_delete on public.doc_attachments for delete to authenticated
  using (doc_id = any ((select public.my_doc_ids(2))::uuid[]));

alter table public.doc_attachments replica identity full;
alter publication supabase_realtime add table public.doc_attachments;

-- Storage bucket (private; files are read through short-lived signed URLs).
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do nothing;

create policy "Attachments readable by document readers" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(1))::text[]));
create policy "Attachments uploadable by document editors" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(2))::text[]));
create policy "Attachments removable by document editors" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = any ((select public.my_doc_ids(2))::text[]));
