-- =====================================================================
-- Upload size limit setting — run once in SQL Editor. Safe to re-run.
--
-- The app checks file sizes against this value before uploading, so a
-- too-large file is refused at once instead of after a long upload.
-- Keep it equal to Storage > Settings > "Upload file size limit"
-- (50 MB on the free plan). Admins can change it in the app's Admin window.
-- =====================================================================
alter table public.project_settings
  add column if not exists max_upload_mb integer not null default 50;

alter table public.project_settings drop constraint if exists max_upload_mb_range;
alter table public.project_settings
  add constraint max_upload_mb_range check (max_upload_mb between 1 and 500000);
