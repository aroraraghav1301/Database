-- Run this once in Supabase → SQL Editor (safe to run again).
-- Creates the private "brace-files" bucket and the policies that let each
-- signed-in user manage files inside folders of databases they own.
-- This fixes: "new row violates row-level security policy" and files not showing in the Files tab.

insert into storage.buckets (id, name, public)
values ('brace-files', 'brace-files', false)
on conflict (id) do nothing;

drop policy if exists "own files select" on storage.objects;
drop policy if exists "own files insert" on storage.objects;
drop policy if exists "own files update" on storage.objects;
drop policy if exists "own files delete" on storage.objects;

create policy "own files select" on storage.objects for select to authenticated
using (bucket_id = 'brace-files' and exists (select 1 from public.databases d where d.id::text = (storage.foldername(name))[1] and d.owner_id = auth.uid()));

create policy "own files insert" on storage.objects for insert to authenticated
with check (bucket_id = 'brace-files' and exists (select 1 from public.databases d where d.id::text = (storage.foldername(name))[1] and d.owner_id = auth.uid()));

create policy "own files update" on storage.objects for update to authenticated
using (bucket_id = 'brace-files' and exists (select 1 from public.databases d where d.id::text = (storage.foldername(name))[1] and d.owner_id = auth.uid()))
with check (bucket_id = 'brace-files' and exists (select 1 from public.databases d where d.id::text = (storage.foldername(name))[1] and d.owner_id = auth.uid()));

create policy "own files delete" on storage.objects for delete to authenticated
using (bucket_id = 'brace-files' and exists (select 1 from public.databases d where d.id::text = (storage.foldername(name))[1] and d.owner_id = auth.uid()));
