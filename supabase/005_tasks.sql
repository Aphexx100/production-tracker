-- =====================================================================
-- Tasks — run once in SQL Editor after 004_timeline.sql. Safe to re-run.
--
-- Tasks are the existing per-person to-dos, extended with a due date, a
-- link to a milestone or deadline, the milestone title a call mentioned
-- (before it exists on the timeline), and the daily summary they came from.
-- =====================================================================

alter table public.todos
  add column if not exists due_date        date,
  add column if not exists milestone_id    uuid references public.milestones (id) on delete set null,
  add column if not exists milestone_title text,
  add column if not exists daily_id        uuid references public.dailies (id) on delete set null,
  add column if not exists source_quote    text;

alter table public.todos drop constraint if exists todo_milestone_title_len;
alter table public.todos
  add constraint todo_milestone_title_len check (milestone_title is null or length(milestone_title) <= 200);
alter table public.todos drop constraint if exists todo_source_quote_len;
alter table public.todos
  add constraint todo_source_quote_len check (source_quote is null or length(source_quote) <= 1000);

create index if not exists todos_milestone_idx on public.todos (milestone_id);
create index if not exists todos_daily_idx on public.todos (daily_id);
