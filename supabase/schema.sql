-- =====================================================================
-- Production Tracker — Supabase schema
--
-- Run this whole file once in the Supabase dashboard: SQL Editor > New query.
-- BEFORE running: replace ADMIN_EMAIL_HERE below with the email address of
-- the first administrator. That account is approved automatically once its
-- email is confirmed. Every other account must be approved by an admin.
--
-- Security model
--   * Passwords are handled by Supabase Auth (bcrypt hashes, never stored here).
--   * Every table has row-level security. Only signed-in users whose email is
--     confirmed AND whose profile an admin approved can read or write data.
--   * The anon role has no table access at all.
--   * Images live in the private storage bucket "media" with the same rule.
-- The file is idempotent: it is safe to run it again after changes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bootstrap admins (not readable through the API)
-- ---------------------------------------------------------------------
create table if not exists public.admin_emails (
  email text primary key
);
alter table public.admin_emails enable row level security;

insert into public.admin_emails (email)
values (lower('ADMIN_EMAIL_HERE'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Profiles (one row per auth user)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text not null default '',
  role         text not null default 'member' check (role in ('admin', 'member')),
  approved     boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Approved = admin approved the profile AND the email address is confirmed.
create or replace function public.is_approved()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = auth.uid()
      and p.approved
      and u.email_confirmed_at is not null
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_approved() and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  boot boolean;
begin
  boot := exists (select 1 from public.admin_emails a where a.email = lower(new.email));
  insert into public.profiles (id, email, display_name, role, approved)
  values (
    new.id,
    new.email,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
                  split_part(new.email, '@', 1)), 80),
    case when boot then 'admin' else 'member' end,
    boot
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Non-admins may only change their own display name.
-- auth.uid() is null in the SQL editor, so the dashboard can always fix roles.
create or replace function public.guard_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.id is distinct from old.id
       or new.email is distinct from old.email
       or new.role is distinct from old.role
       or new.approved is distinct from old.approved
       or new.created_at is distinct from old.created_at then
      raise exception 'Only an admin can change role or approval';
    end if;
  end if;
  if auth.uid() is not null and old.id = auth.uid()
     and (new.role <> 'admin' or not new.approved) and old.role = 'admin' then
    raise exception 'Admins cannot demote or revoke themselves';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile
  before update on public.profiles
  for each row execute function public.guard_profile();

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_approved());

drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------
create or replace function public.touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Project settings (single row)
-- ---------------------------------------------------------------------
create table if not exists public.project_settings (
  id           int primary key default 1 check (id = 1),
  project_name text not null default 'Untitled Production',
  fps          numeric(6, 3) not null default 24 check (fps > 0 and fps <= 240),
  created_by   uuid, created_at timestamptz not null default now(),
  updated_by   uuid, updated_at timestamptz not null default now()
);
insert into public.project_settings (id) values (1) on conflict do nothing;
alter table public.project_settings enable row level security;

drop trigger if exists touch on public.project_settings;
create trigger touch before insert or update on public.project_settings
  for each row execute function public.touch_row();

drop policy if exists "settings read" on public.project_settings;
create policy "settings read" on public.project_settings
  for select to authenticated using (public.is_approved());
drop policy if exists "settings write" on public.project_settings;
create policy "settings write" on public.project_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Team members (people who own to-do lists)
-- ---------------------------------------------------------------------
create table if not exists public.team_members (
  name       text primary key check (length(trim(name)) between 1 and 40),
  sort_order int not null default 0
);
insert into public.team_members (name, sort_order) values
  ('Mihai', 1), ('Miguel', 2), ('Rafael', 3), ('Micael', 4), ('Sascha', 5)
on conflict do nothing;
alter table public.team_members enable row level security;

drop policy if exists "team read" on public.team_members;
create policy "team read" on public.team_members
  for select to authenticated using (public.is_approved());
drop policy if exists "team write" on public.team_members;
create policy "team write" on public.team_members
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Daily call summaries
-- ---------------------------------------------------------------------
create table if not exists public.dailies (
  id         uuid primary key default gen_random_uuid(),
  day        date not null default current_date,
  title      text not null default '' check (length(title) <= 200),
  content    text not null default '',          -- editor HTML, sanitized on render
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists dailies_day_idx on public.dailies (day desc, created_at desc);
alter table public.dailies enable row level security;

drop trigger if exists touch on public.dailies;
create trigger touch before insert or update on public.dailies
  for each row execute function public.touch_row();

drop policy if exists "dailies all" on public.dailies;
create policy "dailies all" on public.dailies
  for all to authenticated using (public.is_approved()) with check (public.is_approved());

-- ---------------------------------------------------------------------
-- Shots
-- ---------------------------------------------------------------------
create table if not exists public.shots (
  id          uuid primary key default gen_random_uuid(),
  sort_order  double precision not null default 0,
  status      text not null default 'wtg'
              check (status in ('wtg', 'rdy', 'ip', 'shot', 'rev', 'apr', 'hld', 'omt')),
  priority    text not null default 'normal'
              check (priority in ('low', 'normal', 'high', 'urgent')),
  sequence    text not null default '',
  scene       text not null default '',
  shot_name   text not null default '',
  description text not null default '',         -- editor HTML, sanitized on render
  shot_type   text not null default '',
  lens        text not null default '',
  camera      text not null default '',
  movement    text not null default '',
  frame_in    int,
  frame_out   int,
  handles     int not null default 0 check (handles >= 0),
  duration    int generated always as (
                case when frame_in is not null and frame_out is not null
                     then frame_out - frame_in + 1 end) stored,
  location    text not null default '',
  int_ext     text not null default '',
  day_night   text not null default '',
  shoot_day   date,
  assignee    text references public.team_members (name) on update cascade on delete set null,
  due_date    date,
  comments    text not null default '',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  constraint frames_order check (frame_in is null or frame_out is null or frame_out >= frame_in)
);
create index if not exists shots_sort_idx on public.shots (sort_order);
alter table public.shots enable row level security;

drop trigger if exists touch on public.shots;
create trigger touch before insert or update on public.shots
  for each row execute function public.touch_row();

drop policy if exists "shots all" on public.shots;
create policy "shots all" on public.shots
  for all to authenticated using (public.is_approved()) with check (public.is_approved());

-- ---------------------------------------------------------------------
-- To-dos (per person, optionally tied to a shot)
-- ---------------------------------------------------------------------
create table if not exists public.todos (
  id         uuid primary key default gen_random_uuid(),
  shot_id    uuid references public.shots (id) on delete cascade,
  person     text not null references public.team_members (name) on update cascade on delete cascade,
  body       text not null check (length(trim(body)) between 1 and 2000),
  done       boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists todos_shot_idx on public.todos (shot_id);
create index if not exists todos_person_idx on public.todos (person, done);
alter table public.todos enable row level security;

drop trigger if exists touch on public.todos;
create trigger touch before insert or update on public.todos
  for each row execute function public.touch_row();

drop policy if exists "todos all" on public.todos;
create policy "todos all" on public.todos
  for all to authenticated using (public.is_approved()) with check (public.is_approved());

-- ---------------------------------------------------------------------
-- Lock out the anon role completely (defense in depth on top of RLS)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on function public.is_approved(), public.is_admin() from anon, public;
grant execute on function public.is_approved(), public.is_admin() to authenticated;
revoke all on public.admin_emails from authenticated;

-- ---------------------------------------------------------------------
-- Private image storage
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media read" on storage.objects;
create policy "media read" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and public.is_approved());

drop policy if exists "media upload" on storage.objects;
create policy "media upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and public.is_approved());

drop policy if exists "media delete" on storage.objects;
create policy "media delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and public.is_admin());

-- ---------------------------------------------------------------------
-- Realtime: other users' edits show up live (RLS still applies)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['dailies', 'shots', 'todos'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
