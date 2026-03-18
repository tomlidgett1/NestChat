-- ============================================================================
-- Reminders System
-- Cron-based and one-shot reminders delivered via Sendblue
-- ============================================================================

-- Table: reminders
create table if not exists public.reminders (
  id bigint generated always as identity primary key,
  handle text not null,
  chat_id text,
  action_description text not null,
  cron_expression text,
  repeating boolean not null default false,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  active boolean not null default true,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for the cron poller: find active reminders due to fire
create index if not exists reminders_active_fire_idx
  on public.reminders (next_fire_at)
  where active = true;

-- Index for listing a user's reminders
create index if not exists reminders_handle_active_idx
  on public.reminders (handle, active, created_at desc);

alter table public.reminders enable row level security;

-- ============================================================================
-- RPC: insert_reminder
-- ============================================================================

create or replace function public.insert_reminder(
  p_handle text,
  p_chat_id text,
  p_action_description text,
  p_cron_expression text,
  p_repeating boolean,
  p_next_fire_at timestamptz,
  p_timezone text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.reminders (
    handle, chat_id, action_description, cron_expression,
    repeating, next_fire_at, active, timezone
  )
  values (
    p_handle, p_chat_id, p_action_description, p_cron_expression,
    p_repeating, p_next_fire_at, true, coalesce(p_timezone, 'UTC')
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================================
-- RPC: get_due_reminders — returns reminders where next_fire_at <= now
-- ============================================================================

create or replace function public.get_due_reminders()
returns table (
  id bigint,
  handle text,
  chat_id text,
  action_description text,
  cron_expression text,
  repeating boolean,
  timezone text
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.handle,
    r.chat_id,
    r.action_description,
    r.cron_expression,
    r.repeating,
    r.timezone
  from public.reminders r
  where r.active = true
    and r.next_fire_at <= now()
  order by r.next_fire_at asc
  limit 50;
$$;

-- ============================================================================
-- RPC: mark_reminder_fired — update after delivery
-- ============================================================================

create or replace function public.mark_reminder_fired(
  p_id bigint,
  p_next_fire_at timestamptz  -- null for non-repeating (will deactivate)
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_next_fire_at is null then
    -- One-shot reminder: deactivate
    update public.reminders
    set last_fired_at = now(),
        active = false,
        updated_at = now()
    where id = p_id;
  else
    -- Repeating: advance to next fire time
    update public.reminders
    set last_fired_at = now(),
        next_fire_at = p_next_fire_at,
        updated_at = now()
    where id = p_id;
  end if;
end;
$$;

-- ============================================================================
-- RPC: get_user_reminders — list active reminders for a handle
-- ============================================================================

create or replace function public.get_user_reminders(
  p_handle text
)
returns table (
  id bigint,
  action_description text,
  cron_expression text,
  repeating boolean,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  timezone text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.action_description,
    r.cron_expression,
    r.repeating,
    r.next_fire_at,
    r.last_fired_at,
    r.timezone,
    r.created_at
  from public.reminders r
  where r.handle = p_handle
    and r.active = true
  order by r.created_at desc;
$$;

-- ============================================================================
-- RPC: delete_reminder — soft-delete (deactivate)
-- ============================================================================

create or replace function public.delete_reminder(
  p_id bigint,
  p_handle text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reminders
  set active = false, updated_at = now()
  where id = p_id and handle = p_handle and active = true;

  return found;
end;
$$;

-- ============================================================================
-- RPC: edit_reminder — update description, schedule, or active state
-- ============================================================================

create or replace function public.edit_reminder(
  p_id bigint,
  p_handle text,
  p_action_description text default null,
  p_cron_expression text default null,
  p_next_fire_at timestamptz default null,
  p_repeating boolean default null,
  p_active boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reminders
  set
    action_description = coalesce(p_action_description, action_description),
    cron_expression = coalesce(p_cron_expression, cron_expression),
    next_fire_at = coalesce(p_next_fire_at, next_fire_at),
    repeating = coalesce(p_repeating, repeating),
    active = coalesce(p_active, active),
    updated_at = now()
  where id = p_id and handle = p_handle;

  return found;
end;
$$;

-- ============================================================================
-- Cron scheduler: configure_reminders_cron
-- Calls the reminder-cron edge function every minute
-- ============================================================================

create or replace function public.configure_reminders_cron(
  p_project_url text,
  p_bearer_token text,
  p_schedule text default '* * * * *'
)
returns bigint
language plpgsql
security definer
set search_path = public, cron, net
as $$
declare
  v_job_id bigint;
begin
  begin
    perform cron.unschedule('fire-reminders');
  exception
    when others then null;
  end;

  select cron.schedule(
    'fire-reminders',
    p_schedule,
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb
      ) as request_id;
      $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/reminder-cron',
      p_bearer_token
    )
  ) into v_job_id;

  return v_job_id;
end;
$$;
