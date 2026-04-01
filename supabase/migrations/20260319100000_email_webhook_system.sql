-- ============================================================================
-- Email Webhook Pub/Sub System
-- Gmail (Google Cloud Pub/Sub) + Outlook (Microsoft Graph Change Notifications)
-- Real-time email/calendar notifications with user-defined triggers
-- ============================================================================

-- Table: email_webhook_subscriptions
-- Tracks active Gmail watch / Outlook subscription per email account
create table if not exists public.email_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  handle text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  account_email text not null,
  -- Google-specific
  history_id text,
  -- Microsoft-specific
  subscription_id text,
  client_state text,
  -- Common
  resource text,
  expiration timestamptz not null,
  active boolean not null default true,
  error_count int not null default 0,
  last_error text,
  last_renewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, account_email)
);

create index if not exists email_webhook_subs_active_exp_idx
  on public.email_webhook_subscriptions (expiration)
  where active = true;

create index if not exists email_webhook_subs_provider_email_idx
  on public.email_webhook_subscriptions (provider, account_email);

create index if not exists email_webhook_subs_handle_idx
  on public.email_webhook_subscriptions (handle);

alter table public.email_webhook_subscriptions enable row level security;

-- Table: email_webhook_events
-- Write-ahead buffer for incoming webhook notifications
create table if not exists public.email_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('google', 'microsoft')),
  account_email text not null,
  subscription_id uuid references public.email_webhook_subscriptions(id) on delete set null,
  history_id text,
  resource_data jsonb,
  change_type text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'skipped')),
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists email_webhook_events_pending_idx
  on public.email_webhook_events (created_at)
  where status = 'pending';

create index if not exists email_webhook_events_sub_idx
  on public.email_webhook_events (subscription_id, created_at desc);

alter table public.email_webhook_events enable row level security;

-- Table: email_watch_triggers
-- User-defined alert rules evaluated by AI
create table if not exists public.email_watch_triggers (
  id bigint generated always as identity primary key,
  handle text not null,
  account_email text,
  provider text check (provider in ('google', 'microsoft') or provider is null),
  name text not null,
  description text not null,
  trigger_type text not null check (trigger_type in ('sender', 'subject', 'content', 'label', 'importance', 'calendar', 'custom')),
  -- Fast pre-filter fields
  match_sender text,
  match_subject_pattern text,
  match_labels text[],
  -- AI matching
  use_ai_matching boolean not null default true,
  ai_prompt text,
  -- Delivery
  delivery_method text not null default 'message' check (delivery_method in ('message', 'silent_log')),
  active boolean not null default true,
  fire_count int not null default 0,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_watch_triggers_handle_active_idx
  on public.email_watch_triggers (handle, active);

alter table public.email_watch_triggers enable row level security;

-- ============================================================================
-- RPC: record_webhook_event
-- ============================================================================

create or replace function public.record_webhook_event(
  p_provider text,
  p_account_email text,
  p_subscription_id uuid,
  p_history_id text default null,
  p_resource_data jsonb default null,
  p_change_type text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.email_webhook_events (
    provider, account_email, subscription_id,
    history_id, resource_data, change_type
  )
  values (
    p_provider, p_account_email, p_subscription_id,
    p_history_id, p_resource_data, p_change_type
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================================
-- RPC: claim_pending_webhook_events
-- Atomically claims a batch of pending events for processing
-- ============================================================================

create or replace function public.claim_pending_webhook_events(
  p_limit int default 10
)
returns table (
  id bigint,
  provider text,
  account_email text,
  subscription_id uuid,
  history_id text,
  resource_data jsonb,
  change_type text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select e.id
    from public.email_webhook_events e
    where e.status = 'pending'
    order by e.created_at asc
    limit p_limit
    for update skip locked
  )
  update public.email_webhook_events e
  set status = 'processing'
  from claimed
  where e.id = claimed.id
  returning
    e.id,
    e.provider,
    e.account_email,
    e.subscription_id,
    e.history_id,
    e.resource_data,
    e.change_type;
end;
$$;

-- ============================================================================
-- RPC: complete_webhook_event
-- ============================================================================

create or replace function public.complete_webhook_event(
  p_id bigint,
  p_status text default 'completed',
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_webhook_events
  set status = p_status,
      processed_at = now(),
      error = p_error
  where id = p_id;
end;
$$;

-- ============================================================================
-- RPC: get_active_triggers_for_handle
-- ============================================================================

create or replace function public.get_active_triggers_for_handle(
  p_handle text
)
returns table (
  id bigint,
  account_email text,
  provider text,
  name text,
  description text,
  trigger_type text,
  match_sender text,
  match_subject_pattern text,
  match_labels text[],
  use_ai_matching boolean,
  ai_prompt text,
  delivery_method text
)
language sql
security definer
set search_path = public
as $$
  select
    t.id, t.account_email, t.provider, t.name, t.description,
    t.trigger_type, t.match_sender, t.match_subject_pattern,
    t.match_labels, t.use_ai_matching, t.ai_prompt, t.delivery_method
  from public.email_watch_triggers t
  where t.handle = p_handle
    and t.active = true
  order by t.created_at desc;
$$;

-- ============================================================================
-- RPC: get_expiring_subscriptions
-- ============================================================================

create or replace function public.get_expiring_subscriptions(
  p_within_hours int default 48
)
returns table (
  id uuid,
  handle text,
  provider text,
  account_email text,
  history_id text,
  subscription_id text,
  expiration timestamptz,
  error_count int
)
language sql
security definer
set search_path = public
as $$
  select
    s.id, s.handle, s.provider, s.account_email,
    s.history_id, s.subscription_id, s.expiration, s.error_count
  from public.email_webhook_subscriptions s
  where s.active = true
    and s.expiration <= now() + (p_within_hours || ' hours')::interval
  order by s.expiration asc;
$$;

-- ============================================================================
-- RPC: insert_email_watch_trigger
-- ============================================================================

create or replace function public.insert_email_watch_trigger(
  p_handle text,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_account_email text default null,
  p_provider text default null,
  p_match_sender text default null,
  p_match_subject_pattern text default null,
  p_match_labels text[] default null,
  p_use_ai_matching boolean default true,
  p_ai_prompt text default null,
  p_delivery_method text default 'message'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.email_watch_triggers (
    handle, account_email, provider, name, description,
    trigger_type, match_sender, match_subject_pattern, match_labels,
    use_ai_matching, ai_prompt, delivery_method
  )
  values (
    p_handle, p_account_email, p_provider, p_name, p_description,
    p_trigger_type, p_match_sender, p_match_subject_pattern, p_match_labels,
    p_use_ai_matching, p_ai_prompt, coalesce(p_delivery_method, 'message')
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================================
-- RPC: delete_email_watch_trigger (soft delete)
-- ============================================================================

create or replace function public.delete_email_watch_trigger(
  p_id bigint,
  p_handle text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_watch_triggers
  set active = false, updated_at = now()
  where id = p_id and handle = p_handle and active = true;

  return found;
end;
$$;

-- ============================================================================
-- RPC: get_user_email_watch_triggers
-- ============================================================================

create or replace function public.get_user_email_watch_triggers(
  p_handle text
)
returns table (
  id bigint,
  name text,
  description text,
  trigger_type text,
  account_email text,
  provider text,
  match_sender text,
  match_subject_pattern text,
  use_ai_matching boolean,
  delivery_method text,
  fire_count int,
  last_fired_at timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    t.id, t.name, t.description, t.trigger_type,
    t.account_email, t.provider, t.match_sender,
    t.match_subject_pattern, t.use_ai_matching,
    t.delivery_method, t.fire_count, t.last_fired_at, t.created_at
  from public.email_watch_triggers t
  where t.handle = p_handle
    and t.active = true
  order by t.created_at desc;
$$;

-- ============================================================================
-- RPC: mark_trigger_fired
-- ============================================================================

create or replace function public.mark_trigger_fired(
  p_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_watch_triggers
  set fire_count = fire_count + 1,
      last_fired_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

-- ============================================================================
-- Cron scheduler: configure_email_webhook_cron
-- Sets up two pg_cron jobs:
--   1. process-email-webhooks: every minute (process incoming events)
--   2. renew-email-webhooks: every 6 hours (renew expiring subscriptions)
-- ============================================================================

create or replace function public.configure_email_webhook_cron(
  p_project_url text,
  p_bearer_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, cron, net
as $$
declare
  v_process_job_id bigint;
  v_renew_job_id bigint;
  v_base_url text := rtrim(p_project_url, '/');
begin
  -- Unschedule existing jobs if any
  begin
    perform cron.unschedule('process-email-webhooks');
  exception when others then null;
  end;

  begin
    perform cron.unschedule('renew-email-webhooks');
  exception when others then null;
  end;

  -- Process events every minute
  select cron.schedule(
    'process-email-webhooks',
    '* * * * *',
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"mode":"process"}'::jsonb
      ) as request_id;
      $schedule$,
      v_base_url || '/functions/v1/email-webhook-cron',
      p_bearer_token
    )
  ) into v_process_job_id;

  -- Renew subscriptions every 6 hours
  select cron.schedule(
    'renew-email-webhooks',
    '0 */6 * * *',
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"mode":"renew"}'::jsonb
      ) as request_id;
      $schedule$,
      v_base_url || '/functions/v1/email-webhook-cron',
      p_bearer_token
    )
  ) into v_renew_job_id;

  return jsonb_build_object(
    'process_job_id', v_process_job_id,
    'renew_job_id', v_renew_job_id
  );
end;
$$;
