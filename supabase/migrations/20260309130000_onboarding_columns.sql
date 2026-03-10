-- Onboarding columns on user_profiles
-- Tracks verification status, onboarding conversation, and PDL enrichment.

alter table public.user_profiles
  add column if not exists status text not null default 'pending',
  add column if not exists onboarding_token uuid not null default gen_random_uuid(),
  add column if not exists onboard_messages jsonb not null default '[]',
  add column if not exists onboard_count integer not null default 0,
  add column if not exists bot_number text null,
  add column if not exists pdl_profile jsonb null;

-- Token lookup for web callback
create unique index if not exists user_profiles_onboarding_token_idx
  on public.user_profiles (onboarding_token);

-- Backfill: anyone already in the table is grandfathered as active
update public.user_profiles set status = 'active' where status = 'pending';

-- Atomic upsert: creates a pending user or returns the existing one.
-- Single round-trip for the hot path (every inbound message).
create or replace function public.ensure_nest_user(
  p_handle text,
  p_bot_number text
)
returns table(
  out_handle text,
  out_name text,
  out_status text,
  out_onboarding_token uuid,
  out_onboard_messages jsonb,
  out_onboard_count integer,
  out_bot_number text,
  out_pdl_profile jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := extract(epoch from now())::bigint;
begin
  insert into public.user_profiles (handle, first_seen, last_seen, bot_number)
  values (p_handle, v_now, v_now, p_bot_number)
  on conflict (handle) do update
    set last_seen = v_now,
        bot_number = coalesce(user_profiles.bot_number, excluded.bot_number);

  return query
    select up.handle, up.name, up.status,
           up.onboarding_token, up.onboard_messages,
           up.onboard_count, up.bot_number, up.pdl_profile
    from public.user_profiles up
    where up.handle = p_handle;
end;
$$;

-- Activate a user by onboarding token (called from nest-onboard after OAuth).
create or replace function public.activate_nest_user(
  p_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handle text;
begin
  update public.user_profiles up
    set status = 'active'
  where up.onboarding_token = p_token
    and up.status != 'active'
  returning up.handle into v_handle;

  return v_handle;
end;
$$;
