-- =====================================================================
-- Task priority — run once in SQL Editor after 005_tasks.sql. Safe to re-run.
-- =====================================================================
alter table public.todos
  add column if not exists priority text not null default 'normal';

alter table public.todos drop constraint if exists todo_priority;
alter table public.todos
  add constraint todo_priority check (priority in ('low', 'normal', 'high', 'urgent'));
