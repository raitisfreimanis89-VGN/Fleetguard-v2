-- 016_page_view_source.sql
-- Capture the ad platform each visit came from. The beacon reads ?utm_source=
-- off the recruiting URL and sends it; track-view stores it here.

alter table public.page_views add column if not exists source text;

create index if not exists page_views_source_idx on public.page_views (source);
