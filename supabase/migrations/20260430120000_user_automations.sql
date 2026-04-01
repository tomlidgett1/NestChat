-- ============================================================================
-- user_automations — user-configured scheduled automations from the website dashboard
--
-- This table is the source of truth for what the user has configured on the
-- Automations page (email_summary, daily_wrap, meeting_intel, etc.).
-- The automation-engine edge function reads due entries and executes them.
-- ============================================================================

-- 1. Table
create table if not exists public.user_automations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  automation_type text not null,
  active          boolean not null default true,
  config          jsonb not null default '{}'::jsonb,
  -- config shape: { time: "HH:mm", timezone: "Australia/Sydney", day?: "Sunday", prompt?: "...", frequency?: "daily"|"weekly"|"hourly"|"event"|"weekday" }
  label           text,
  last_run_at     timestamptz,
  next_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Unique constraint: one row per user per built-in type (custom can have many)
create unique index if not exists user_automations_unique_builtin
  on public.user_automations (user_id, automation_type)
  where automation_type != 'custom';

create index if not exists user_automations_due_idx
  on public.user_automations (next_run_at)
  where active = true and next_run_at is not null;

create index if not exists user_automations_user_idx
  on public.user_automations (user_id);

-- RLS: users can only manage their own automations
alter table public.user_automations enable row level security;

create policy "Users can view own automations"
  on public.user_automations for select
  using (user_id = auth.uid());

create policy "Users can insert own automations"
  on public.user_automations for insert
  with check (user_id = auth.uid());

create policy "Users can update own automations"
  on public.user_automations for update
  using (user_id = auth.uid());

create policy "Users can delete own automations"
  on public.user_automations for delete
  using (user_id = auth.uid());

-- Service role bypass for the automation engine
create policy "Service role full access"
  on public.user_automations for all
  using (auth.role() = 'service_role');

-- ─────────────────────────────────────────────
-- 2. RPC: get_due_user_automations
-- Returns user automations that are due (next_run_at <= now), joined with
-- user_profiles to get handle, bot_number, timezone, auth_user_id etc.
-- ─────────────────────────────────────────────

create or replace function public.get_due_user_automations(p_limit integer default 50)
returns table(
  automation_id     uuid,
  user_id           uuid,
  automation_type   text,
  config            jsonb,
  label             text,
  next_run_at       timestamptz,
  -- user profile fields
  handle            text,
  name              text,
  bot_number        text,
  timezone          text,
  auth_user_id      uuid,
  status            text,
  onboard_count     integer,
  activation_score  integer,
  last_seen         bigint,
  first_seen        bigint,
  deep_profile_snapshot jsonb
)
language sql stable
as $$
  select
    ua.id,
    ua.user_id,
    ua.automation_type,
    ua.config,
    ua.label,
    ua.next_run_at,
    up.handle,
    up.name,
    up.bot_number,
    up.timezone,
    up.auth_user_id,
    up.status,
    coalesce(up.onboard_count, 0),
    coalesce(up.activation_score, 0),
    up.last_seen,
    up.first_seen,
    up.deep_profile_snapshot
  from public.user_automations ua
  join public.user_profiles up on up.auth_user_id = ua.user_id
  where ua.active = true
    and ua.next_run_at is not null
    and ua.next_run_at <= now()
    and up.status = 'active'
    and up.bot_number is not null
  order by ua.next_run_at asc
  limit p_limit;
$$;

-- ─────────────────────────────────────────────
-- 3. RPC: advance_user_automation — update last_run_at and compute next_run_at
-- ─────────────────────────────────────────────

create or replace function public.advance_user_automation(p_automation_id uuid)
returns void
language plpgsql
as $$
declare
  v_config jsonb;
  v_type text;
  v_tz text;
  v_time text;
  v_day text;
  v_frequency text;
  v_next timestamptz;
  v_hour int;
  v_minute int;
  v_target_dow int;
  v_current_dow int;
  v_days_ahead int;
begin
  select config, automation_type into v_config, v_type
  from public.user_automations
  where id = p_automation_id;

  if not found then return; end if;

  v_tz := coalesce(v_config->>'timezone', 'Australia/Sydney');
  v_time := v_config->>'time';
  v_day := v_config->>'day';
  v_frequency := coalesce(v_config->>'frequency', 'daily');

  -- Parse time
  if v_time is not null then
    v_hour := split_part(v_time, ':', 1)::int;
    v_minute := split_part(v_time, ':', 2)::int;
  else
    v_hour := 8;
    v_minute := 0;
  end if;

  -- Compute next run in user's timezone
  if v_frequency = 'weekly' or v_day is not null then
    -- Weekly: advance by 7 days from the current next_run_at
    select next_run_at + interval '7 days' into v_next
    from public.user_automations where id = p_automation_id;
  elsif v_frequency = 'weekday' then
    -- Weekday: advance to next weekday
    select next_run_at + interval '1 day' into v_next
    from public.user_automations where id = p_automation_id;
    -- Skip weekends
    while extract(dow from v_next) in (0, 6) loop
      v_next := v_next + interval '1 day';
    end loop;
  elsif v_frequency = 'hourly' then
    v_next := now() + interval '1 hour';
  else
    -- Daily: advance by 1 day
    select next_run_at + interval '1 day' into v_next
    from public.user_automations where id = p_automation_id;
  end if;

  -- If computed next is in the past (e.g. engine was down), leap forward
  while v_next <= now() loop
    if v_frequency = 'weekly' or v_day is not null then
      v_next := v_next + interval '7 days';
    elsif v_frequency = 'weekday' then
      v_next := v_next + interval '1 day';
      while extract(dow from v_next) in (0, 6) loop
        v_next := v_next + interval '1 day';
      end loop;
    elsif v_frequency = 'hourly' then
      v_next := v_next + interval '1 hour';
    else
      v_next := v_next + interval '1 day';
    end if;
  end loop;

  update public.user_automations
  set last_run_at = now(),
      next_run_at = v_next,
      updated_at = now()
  where id = p_automation_id;
end;
$$;
