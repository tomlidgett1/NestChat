-- Fix: DROP the function first so we can change its return type
-- (PostgreSQL cannot ALTER return type of an existing function via CREATE OR REPLACE)

drop function if exists public.get_due_user_automations(integer);

create or replace function public.get_due_user_automations(p_limit integer default 50)
returns table(
  automation_id     uuid,
  user_id           uuid,
  automation_type   text,
  config            jsonb,
  label             text,
  next_run_at       timestamptz,
  handle            text,
  name              text,
  greeting_name     text,
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
    coalesce(nullif(trim(up.display_name), ''), nullif(trim(up.name), '')) as greeting_name,
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
    and ua.automation_type <> 'bill_reminders'
    and ua.next_run_at is not null
    and ua.next_run_at <= now()
    and up.status = 'active'
    and up.bot_number is not null
  order by ua.next_run_at asc
  limit p_limit;
$$;
