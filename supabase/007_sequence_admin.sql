-- =====================================================================
-- Rename / delete sequences — run once in SQL Editor after 002 and 004.
-- Safe to re-run.
--
-- A sequence name is stored as text on shots, references and milestones.
-- These functions change all of them in one transaction, so a rename can
-- never leave some rows behind. They run with the caller's rights, so
-- row-level security still applies (approved users only).
-- =====================================================================

-- Rename a sequence. If the new name already exists, the two are merged
-- (the existing sequence keeps its title, dates and colour).
create or replace function public.rename_sequence(old_code text, new_code text)
returns void
language plpgsql security invoker
set search_path = ''
as $$
begin
  if not public.is_approved() then
    raise exception 'Your account is not approved for this project';
  end if;
  new_code := trim(coalesce(new_code, ''));
  if new_code = '' or length(new_code) > 40 then
    raise exception 'Sequence names must be 1 to 40 characters';
  end if;
  if old_code = new_code then
    return;
  end if;
  if exists (select 1 from public.sequences where code = new_code) then
    delete from public.sequences where code = old_code;
  else
    update public.sequences set code = new_code where code = old_code;
  end if;
  update public.shots      set sequence = new_code where sequence = old_code;
  update public.refs       set sequence = new_code where sequence = old_code;
  update public.milestones set sequence = new_code where sequence = old_code;
end;
$$;

-- Delete a sequence. Nothing else is deleted: its shots, references and
-- milestones move to move_to ('' = no sequence).
create or replace function public.delete_sequence(seq_code text, move_to text default '')
returns void
language plpgsql security invoker
set search_path = ''
as $$
begin
  if not public.is_approved() then
    raise exception 'Your account is not approved for this project';
  end if;
  move_to := trim(coalesce(move_to, ''));
  if move_to = seq_code then
    raise exception 'Choose a different sequence to move its shots to';
  end if;
  update public.shots      set sequence = move_to where sequence = seq_code;
  update public.refs       set sequence = move_to where sequence = seq_code;
  update public.milestones set sequence = move_to where sequence = seq_code;
  delete from public.sequences where code = seq_code;
end;
$$;

revoke execute on function public.rename_sequence(text, text), public.delete_sequence(text, text) from anon, public;
grant execute on function public.rename_sequence(text, text), public.delete_sequence(text, text) to authenticated;
