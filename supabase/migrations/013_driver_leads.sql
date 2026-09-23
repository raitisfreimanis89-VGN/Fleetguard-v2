-- 013_driver_leads.sql
-- Public recruiting form (fleetguards.app/vgn/) writes leads here via the
-- driver-apply Edge Function (service role). Readable ONLY by admins or the
-- dedicated leads viewer reinox12@gmail.com. No public/anon read, no client writes.

create table if not exists public.driver_leads (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  full_name      text not null,
  phone          text not null,
  cdl_experience text,
  sap            text,
  best_time      text,
  consent        boolean not null default false,
  source         text,
  ua             text,
  sms_status     text
);

create index if not exists driver_leads_created_idx on public.driver_leads (created_at desc);

alter table public.driver_leads enable row level security;

-- Read: admins OR the single leads-viewer email. Nobody else (anon gets nothing).
drop policy if exists driver_leads_select on public.driver_leads;
create policy driver_leads_select on public.driver_leads
  for select to authenticated
  using ( is_admin() or (auth.jwt() ->> 'email') = 'reinox12@gmail.com' );

-- No insert/update/delete policies are defined, so only the service role
-- (the driver-apply Edge Function) can write. Browsers cannot.
