-- Fix ambiguous column references in onboarding RPCs.
-- Must drop first because return type is changing.

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

drop function if exists public.activate_nest_user(uuid);

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
