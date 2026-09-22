-- =====================================================================
-- References (per sequence) — add to an existing project
--
-- Run this once in SQL Editor if you set up the project before the
-- References tab existed. Fresh installs get it from schema.sql already.
-- Safe to run more than once.
-- =====================================================================

-- Sequence containers. `code` matches the "Seq" column in the shot tracker.
create table if not exists public.sequences (
  code       text primary key check (length(code) <= 40),
  title      text not null default '' check (length(title) <= 200),
  notes      text not null default '' check (length(notes) <= 4000),
  sort_order double precision not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.sequences enable row level security;

drop trigger if exists touch on public.sequences;
create trigger touch before insert or update on public.sequences
  for each row execute function public.touch_row();

drop policy if exists "sequences all" on public.sequences;
create policy "sequences all" on public.sequences
  for all to authenticated using (public.is_approved()) with check (public.is_approved());

-- One row per reference: an uploaded file or a web link.
-- sequence = '' means "General" (not tied to a sequence).
create table if not exists public.refs (
  id           uuid primary key default gen_random_uuid(),
  sequence     text not null default '' check (length(sequence) <= 40),
  kind         text not null
               check (kind in ('video', 'image', 'pdf', 'link', 'audio', 'doc', 'model', 'other')),
  title        text not null default '' check (length(title) <= 300),
  notes        text not null default '' check (length(notes) <= 4000),
  url          text check (url is null or url ~* '^https?://'),
  storage_path text,
  thumb_path   text,
  file_name    text,
  mime         text,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now(),
  constraint ref_has_target check (
    (kind = 'link' and url is not null) or (kind <> 'link' and storage_path is not null))
);
create index if not exists refs_sequence_idx on public.refs (sequence, kind);
alter table public.refs enable row level security;

drop trigger if exists touch on public.refs;
create trigger touch before insert or update on public.refs
  for each row execute function public.touch_row();

drop policy if exists "refs read" on public.refs;
create policy "refs read" on public.refs
  for select to authenticated using (public.is_approved());
drop policy if exists "refs insert" on public.refs;
create policy "refs insert" on public.refs
  for insert to authenticated with check (public.is_approved());
drop policy if exists "refs update" on public.refs;
create policy "refs update" on public.refs
  for update to authenticated using (public.is_approved()) with check (public.is_approved());
-- Only the uploader or an admin may delete a reference.
drop policy if exists "refs delete" on public.refs;
create policy "refs delete" on public.refs
  for delete to authenticated
  using (public.is_approved() and (created_by = auth.uid() or public.is_admin()));

revoke all on public.sequences, public.refs from anon;

-- Private bucket for reference files. No size or type limit on the bucket
-- itself: the project-wide upload limit applies (Storage > Settings).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('references', 'references', false, null, null)
on conflict (id) do update set public = false;

drop policy if exists "references read" on storage.objects;
create policy "references read" on storage.objects
  for select to authenticated
  using (bucket_id = 'references' and public.is_approved());

drop policy if exists "references upload" on storage.objects;
create policy "references upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'references' and public.is_approved());

drop policy if exists "references delete" on storage.objects;
create policy "references delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'references' and public.is_approved()
         and (owner_id = auth.uid()::text or public.is_admin()));

do $$
declare
  t text;
begin
  foreach t in array array['sequences', 'refs'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
