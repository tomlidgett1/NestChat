-- OAuth account tables for Google and Microsoft multi-account support.
-- Stores refresh tokens, profile info, and scopes per linked account.

-- ============================================================================
-- user_google_accounts
-- ============================================================================

create table if not exists public.user_google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_email text not null,
  google_name text,
  google_avatar_url text,
  refresh_token text not null,
  scopes text[] not null default '{}',
  is_primary boolean not null default false,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, google_email)
);

create index if not exists user_google_accounts_user_id_idx
  on public.user_google_accounts (user_id);

alter table public.user_google_accounts enable row level security;

drop policy if exists "users_select_own_google_accounts" on public.user_google_accounts;
create policy "users_select_own_google_accounts"
  on public.user_google_accounts for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users_delete_own_google_accounts" on public.user_google_accounts;
create policy "users_delete_own_google_accounts"
  on public.user_google_accounts for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "service_role_full_google_accounts" on public.user_google_accounts;
create policy "service_role_full_google_accounts"
  on public.user_google_accounts for all
  to service_role
  using (true)
  with check (true);

-- ============================================================================
-- user_microsoft_accounts
-- ============================================================================

create table if not exists public.user_microsoft_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  microsoft_email text not null,
  microsoft_name text,
  microsoft_avatar_url text,
  refresh_token text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, microsoft_email)
);

create index if not exists user_microsoft_accounts_user_id_idx
  on public.user_microsoft_accounts (user_id);

alter table public.user_microsoft_accounts enable row level security;

drop policy if exists "users_select_own_microsoft_accounts" on public.user_microsoft_accounts;
create policy "users_select_own_microsoft_accounts"
  on public.user_microsoft_accounts for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users_delete_own_microsoft_accounts" on public.user_microsoft_accounts;
create policy "users_delete_own_microsoft_accounts"
  on public.user_microsoft_accounts for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "service_role_full_microsoft_accounts" on public.user_microsoft_accounts;
create policy "service_role_full_microsoft_accounts"
  on public.user_microsoft_accounts for all
  to service_role
  using (true)
  with check (true);

-- ============================================================================
-- Link user_profiles to Supabase auth users
-- ============================================================================

alter table public.user_profiles
  add column if not exists auth_user_id uuid;

create index if not exists user_profiles_auth_user_id_idx
  on public.user_profiles (auth_user_id)
  where auth_user_id is not null;

-- ============================================================================
-- Update ensure_nest_user to return auth_user_id
-- ============================================================================

drop function if exists public.ensure_nest_user(text, text);

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
  out_pdl_profile jsonb,
  out_auth_user_id uuid,
  out_onboard_state text,
  out_entry_state text,
  out_first_value_wedge text,
  out_first_value_delivered_at timestamptz,
  out_second_engagement_at timestamptz,
  out_checkin_opt_in boolean,
  out_activation_score integer,
  out_capability_categories_used text[],
  out_last_proactive_sent_at timestamptz,
  out_last_proactive_ignored boolean,
  out_proactive_ignore_count integer,
  out_recovery_nudge_sent_at timestamptz,
  out_timezone text,
  out_first_seen bigint,
  out_last_seen bigint
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
           up.onboard_count, up.bot_number, up.pdl_profile,
           up.auth_user_id,
           up.onboard_state, up.entry_state,
           up.first_value_wedge, up.first_value_delivered_at,
           up.second_engagement_at, up.checkin_opt_in,
           up.activation_score, up.capability_categories_used,
           up.last_proactive_sent_at, up.last_proactive_ignored,
           up.proactive_ignore_count, up.recovery_nudge_sent_at,
           up.timezone,
           up.first_seen, up.last_seen
    from public.user_profiles up
    where up.handle = p_handle;
end;
$$;
