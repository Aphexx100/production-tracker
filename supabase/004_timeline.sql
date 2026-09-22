-- =====================================================================
-- Timeline — run once in SQL Editor after 002 and 003. Safe to re-run.
--
-- Adds planned date ranges to sequences and shots, and a table for
-- milestones (events such as "Shoot starts") and deadlines (dates that
-- must be met, e.g. "VFX turnover"). Milestones can belong to the whole
-- project, to one sequence, or to one shot.
-- =====================================================================

alter table public.sequences
  add column if not exists start_date date,
  add column if not exists end_date   date,
  add column if not exists color      text;
alter table public.sequences drop constraint if exists sequence_dates;
alter table public.sequences
  add constraint sequence_dates check (start_date is null or end_date is null or end_date >= start_date);
alter table public.sequences drop constraint if exists sequence_color;
alter table public.sequences
  add constraint sequence_color check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

alter table public.shots
  add column if not exists start_date date,
  add column if not exists end_date   date;
alter table public.shots drop constraint if exists shot_dates;
alter table public.shots
  add constraint shot_dates check (start_date is null or end_date is null or end_date >= start_date);

create table if not exists public.milestones (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(trim(title)) between 1 and 200),
  kind       text not null default 'milestone' check (kind in ('milestone', 'deadline')),
  date       date not null,
  sequence   text not null default '' check (length(sequence) <= 40), -- '' = whole project
  shot_id    uuid references public.shots (id) on delete cascade,
  notes      text not null default '' check (length(notes) <= 4000),
  done       boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists milestones_date_idx on public.milestones (date);
alter table public.milestones enable row level security;

drop trigger if exists touch on public.milestones;
create trigger touch before insert or update on public.milestones
  for each row execute function public.touch_row();

drop policy if exists "milestones all" on public.milestones;
create policy "milestones all" on public.milestones
  for all to authenticated using (public.is_approved()) with check (public.is_approved());

revoke all on public.milestones from anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'milestones'
  ) then
    alter publication supabase_realtime add table public.milestones;
  end if;
end;
$$;
