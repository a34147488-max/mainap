-- VK COIN Exchange: private exchange requests and server-authoritative player wallet.
create extension if not exists pgcrypto;
create table if not exists public.exchange_requests (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('sell','buy')),
 telegram_user_id bigint, telegram_username text, telegram_first_name text,
 coin_amount numeric(24,3) not null check(coin_amount>0), rub_amount numeric(18,2) not null check(rub_amount>=0),
 bank_name text, payout_details text, status text not null default 'pending' check(status in ('pending','reviewing','paid','rejected','awaiting_payment')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), admin_note text
);
create index if not exists exchange_requests_created_at_idx on public.exchange_requests(created_at desc);
create index if not exists exchange_requests_status_idx on public.exchange_requests(status);
alter table public.exchange_requests enable row level security;
revoke all on public.exchange_requests from anon,authenticated;
drop policy if exists "No public access to exchange requests" on public.exchange_requests;
create policy "No public access to exchange requests" on public.exchange_requests for all to anon,authenticated using(false) with check(false);

create table if not exists public.player_wallets (
 telegram_user_id bigint primary key, username text, first_name text,
 balance numeric(24,3) not null default 0 check(balance>=0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists player_wallets_username_ci_idx on public.player_wallets(lower(username)) where username is not null and username<>'';
create table if not exists public.player_transfers (
 id uuid primary key default gen_random_uuid(),
 sender_id bigint not null references public.player_wallets(telegram_user_id),
 recipient_id bigint not null references public.player_wallets(telegram_user_id),
 amount numeric(24,3) not null check(amount>0), created_at timestamptz not null default now(), check(sender_id<>recipient_id)
);
create index if not exists player_transfers_sender_created_idx on public.player_transfers(sender_id,created_at desc);
create index if not exists player_transfers_recipient_created_idx on public.player_transfers(recipient_id,created_at desc);
alter table public.player_wallets enable row level security;
alter table public.player_transfers enable row level security;
revoke all on public.player_wallets,public.player_transfers from anon,authenticated;
drop policy if exists "No direct wallet access" on public.player_wallets;
create policy "No direct wallet access" on public.player_wallets for all to anon,authenticated using(false) with check(false);
drop policy if exists "No direct transfer history access" on public.player_transfers;
create policy "No direct transfer history access" on public.player_transfers for all to anon,authenticated using(false) with check(false);

create or replace function public.execute_player_transfer(p_sender_id bigint,p_recipient_username text,p_amount numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_recipient_id bigint; v_sender_balance numeric(24,3); v_transfer_id uuid;
begin
 if p_amount is null or p_amount<=0 or p_amount>1000000000000 then raise exception 'INVALID_AMOUNT'; end if;
 if p_recipient_username is null or length(trim(p_recipient_username))<3 then raise exception 'INVALID_RECIPIENT'; end if;
 select telegram_user_id into v_recipient_id from public.player_wallets
 where lower(username)=lower(regexp_replace(trim(p_recipient_username),'^@','')) for update;
 if v_recipient_id is null then raise exception 'RECIPIENT_NOT_REGISTERED'; end if;
 if v_recipient_id=p_sender_id then raise exception 'SELF_TRANSFER'; end if;
 perform 1 from public.player_wallets where telegram_user_id=p_sender_id for update;
 if not found then raise exception 'SENDER_NOT_REGISTERED'; end if;
 select balance into v_sender_balance from public.player_wallets where telegram_user_id=p_sender_id;
 if v_sender_balance<p_amount then raise exception 'INSUFFICIENT_BALANCE'; end if;
 update public.player_wallets set balance=balance-p_amount,updated_at=now() where telegram_user_id=p_sender_id;
 update public.player_wallets set balance=balance+p_amount,updated_at=now() where telegram_user_id=v_recipient_id;
 insert into public.player_transfers(sender_id,recipient_id,amount) values(p_sender_id,v_recipient_id,p_amount) returning id into v_transfer_id;
 return jsonb_build_object('id',v_transfer_id,'amount',p_amount,'recipient_id',v_recipient_id);
end; $$;
revoke all on function public.execute_player_transfer(bigint,text,numeric) from public,anon,authenticated;
grant execute on function public.execute_player_transfer(bigint,text,numeric) to service_role;
