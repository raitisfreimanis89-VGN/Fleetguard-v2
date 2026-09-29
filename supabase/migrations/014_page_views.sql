-- 014_page_views.sql
-- First-party visit tracking for the public recruiting page (fleetguards.app/vgn/).
-- The track-view Edge Function (service role) inserts one row per page load.
-- Readable only by admins or the leads viewer (reinox12@gmail.com); no client writes.

create table if not exists public.page_views (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  path       text,
  referrer   text,
  ua         text
);

create index if not exists page_views_created_idx on public.page_views (created_at desc);

alter table public.page_views enable row level security;

drop policy if exists page_views_select on public.page_views;
create policy page_views_select on public.page_views
  for select to authenticated
  using ( is_admin() or (auth.jwt() ->> 'email') = 'reinox12@gmail.com' );
