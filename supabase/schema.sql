-- VK COIN Exchange: private request storage.
-- Run in the Supabase SQL Editor before deploying Edge Functions.
create extension if not exists pgcrypto;

create table if not exists public.exchange_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sell','buy')),
  telegram_user_id bigint,
  telegram_username text,
  telegram_first_name text,
  coin_amount numeric(24,3) not null check (coin_amount > 0),
  rub_amount numeric(18,2) not null check (rub_amount >= 0),
  bank_name text,
  payout_details text,
  status text not null default 'pending' check (status in ('pending','reviewing','paid','rejected','awaiting_payment')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  admin_note text
);

create index if not exists exchange_requests_created_at_idx on public.exchange_requests (created_at desc);
create index if not exists exchange_requests_status_idx on public.exchange_requests (status);

alter table public.exchange_requests enable row level security;

-- No direct browser access. Only server-side Edge Functions use the service-role key.
revoke all on public.exchange_requests from anon, authenticated;
drop policy if exists "No public access to exchange requests" on public.exchange_requests;
create policy "No public access to exchange requests"
on public.exchange_requests for all
to anon, authenticated
using (false)
with check (false);

comment on table public.exchange_requests is 'Private VK COIN exchange requests. Access only through verified Edge Functions.';
