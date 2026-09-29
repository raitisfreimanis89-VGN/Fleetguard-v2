-- 015_page_view_dwell.sql
-- Time-on-page tracking. The visit beacon now sends a client visit id (vid) on
-- load and a dwell time when the visitor leaves; track-view updates the row by vid.

alter table public.page_views add column if not exists vid text;
alter table public.page_views add column if not exists dwell_ms integer;

create index if not exists page_views_vid_idx on public.page_views (vid);
