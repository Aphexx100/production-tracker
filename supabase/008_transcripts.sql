-- =====================================================================
-- Call transcripts — run once in SQL Editor after 002. Safe to re-run.
--
-- A daily summary can carry the raw transcript of the call (uploaded as
-- .txt/.vtt/.srt/.md). It is kept out of the written summary, and used
-- by the AI buttons to draft the summary and to find action items.
-- =====================================================================

alter table public.dailies
  add column if not exists transcript      text,
  add column if not exists transcript_name text;

alter table public.dailies drop constraint if exists daily_transcript_len;
alter table public.dailies
  add constraint daily_transcript_len check (transcript is null or length(transcript) <= 400000);

alter table public.dailies drop constraint if exists daily_transcript_name_len;
alter table public.dailies
  add constraint daily_transcript_name_len check (transcript_name is null or length(transcript_name) <= 200);
