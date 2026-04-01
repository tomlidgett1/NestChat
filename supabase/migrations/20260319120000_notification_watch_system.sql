-- ============================================================================
-- Notification Watch System (v2)
-- Generalizes email-only webhooks → unified email + calendar notifications
-- Renames tables, adds calendar support, time constraints, new RPCs
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Rename tables: email_* → notification_*
-- ════════════════════════════════════════════════════════════════════════════

alter table if exists public.email_webhook_subscriptions
  rename to notification_webhook_subscriptions;

alter table if exists public.email_webhook_events
  rename to notification_webhook_events;

alter table if exists public.email_watch_triggers
  rename to notification_watch_triggers;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Add resource_type to subscriptions (email vs calendar)
-- ════════════════════════════════════════════════════════════════════════════

alter table public.notification_webhook_subscriptions
  add column if not exists resource_type text not null default 'email';

-- Add CHECK constraint (safe: won't fail if column already has valid data)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notification_webhook_subs_resource_type_check'
  ) then
    alter table public.notification_webhook_subscriptions
      add constraint notification_webhook_subs_resource_type_check
        check (resource_type in ('email', 'calendar'));
  end if;
end $$;

-- Google Calendar watch fields
alter table public.notification_webhook_subscriptions
  add column if not exists channel_id text,
  add column if not exists resource_id text;

-- Update unique constraint: (provider, account_email, resource_type)
drop index if exists email_webhook_subscriptions_provider_account_email_idx;
-- Also drop the original unique constraint from CREATE TABLE
alter table public.notification_webhook_subscriptions
  drop constraint if exists email_webhook_subscriptions_provider_account_email_key;

create unique index if not exists notification_webhook_subs_unique_idx
  on public.notification_webhook_subscriptions (provider, account_email, resource_type);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Add source_type to events
-- ════════════════════════════════════════════════════════════════════════════

alter table public.notification_webhook_events
  add column if not exists source_type text not null default 'email';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notification_webhook_events_source_type_check'
  ) then
    alter table public.notification_webhook_events
      add constraint notification_webhook_events_source_type_check
        check (source_type in ('email', 'calendar'));
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Add source_type + time_constraint to triggers
-- ════════════════════════════════════════════════════════════════════════════

alter table public.notification_watch_triggers
  add column if not exists source_type text not null default 'email',
  add column if not exists time_constraint jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notification_watch_triggers_source_type_check'
  ) then
    alter table public.notification_watch_triggers
      add constraint notification_watch_triggers_source_type_check
        check (source_type in ('email', 'calendar', 'any'));
  end if;
end $$;

-- Expand trigger_type to include calendar types
alter table public.notification_watch_triggers
  drop constraint if exists email_watch_triggers_trigger_type_check;

alter table public.notification_watch_triggers
  drop constraint if exists notification_watch_triggers_trigger_type_check;

alter table public.notification_watch_triggers
  add constraint notification_watch_triggers_trigger_type_check
    check (trigger_type in (
      'sender', 'subject', 'content', 'label', 'importance', 'custom',
      'new_invite', 'cancellation', 'reschedule', 'calendar_custom'
    ));

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Updated RPCs (using new table names + new columns)
--    DROP functions whose return type changed before re-creating them
-- ════════════════════════════════════════════════════════════════════════════

drop function if exists public.claim_pending_webhook_events(int);
drop function if exists public.get_active_triggers_for_handle(text);
drop function if exists public.get_expiring_subscriptions(int);
drop function if exists public.get_user_email_watch_triggers(text);

-- record_webhook_event: now accepts source_type
create or replace function public.record_webhook_event(
  p_provider text,
  p_account_email text,
  p_subscription_id uuid,
  p_history_id text default null,
  p_resource_data jsonb default null,
  p_change_type text default null,
  p_source_type text default 'email'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.notification_webhook_events (
    provider, account_email, subscription_id,
    history_id, resource_data, change_type, source_type
  )
  values (
    p_provider, p_account_email, p_subscription_id,
    p_history_id, p_resource_data, p_change_type, p_source_type
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- claim_pending_webhook_events: now returns source_type
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
  change_type text,
  source_type text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select e.id
    from public.notification_webhook_events e
    where e.status = 'pending'
    order by e.created_at asc
    limit p_limit
    for update skip locked
  )
  update public.notification_webhook_events e
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
    e.change_type,
    e.source_type;
end;
$$;

-- complete_webhook_event: same logic, new table name
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
  update public.notification_webhook_events
  set status = p_status,
      processed_at = now(),
      error = p_error
  where id = p_id;
end;
$$;

-- get_active_triggers_for_handle: now returns source_type + time_constraint
create or replace function public.get_active_triggers_for_handle(
  p_handle text,
  p_source_type text default null
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
  delivery_method text,
  source_type text,
  time_constraint jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    t.id, t.account_email, t.provider, t.name, t.description,
    t.trigger_type, t.match_sender, t.match_subject_pattern,
    t.match_labels, t.use_ai_matching, t.ai_prompt, t.delivery_method,
    t.source_type, t.time_constraint
  from public.notification_watch_triggers t
  where t.handle = p_handle
    and t.active = true
    and (p_source_type is null or t.source_type in (p_source_type, 'any'))
  order by t.created_at desc;
$$;

-- get_expiring_subscriptions: new table name + resource_type
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
  error_count int,
  resource_type text,
  channel_id text,
  resource_id text
)
language sql
security definer
set search_path = public
as $$
  select
    s.id, s.handle, s.provider, s.account_email,
    s.history_id, s.subscription_id, s.expiration, s.error_count,
    s.resource_type, s.channel_id, s.resource_id
  from public.notification_webhook_subscriptions s
  where s.active = true
    and s.expiration <= now() + (p_within_hours || ' hours')::interval
  order by s.expiration asc;
$$;

-- insert_notification_watch_trigger: replaces insert_email_watch_trigger
create or replace function public.insert_notification_watch_trigger(
  p_handle text,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_source_type text default 'email',
  p_account_email text default null,
  p_provider text default null,
  p_match_sender text default null,
  p_match_subject_pattern text default null,
  p_match_labels text[] default null,
  p_use_ai_matching boolean default true,
  p_ai_prompt text default null,
  p_delivery_method text default 'message',
  p_time_constraint jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.notification_watch_triggers (
    handle, account_email, provider, name, description,
    trigger_type, source_type, match_sender, match_subject_pattern,
    match_labels, use_ai_matching, ai_prompt, delivery_method,
    time_constraint
  )
  values (
    p_handle, p_account_email, p_provider, p_name, p_description,
    p_trigger_type, p_source_type, p_match_sender, p_match_subject_pattern,
    p_match_labels, p_use_ai_matching, p_ai_prompt,
    coalesce(p_delivery_method, 'message'), p_time_constraint
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- delete_notification_watch_trigger: replaces delete_email_watch_trigger
create or replace function public.delete_notification_watch_trigger(
  p_id bigint,
  p_handle text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_watch_triggers
  set active = false, updated_at = now()
  where id = p_id and handle = p_handle and active = true;

  return found;
end;
$$;

-- get_user_notification_watch_triggers: replaces get_user_email_watch_triggers
create or replace function public.get_user_notification_watch_triggers(
  p_handle text
)
returns table (
  id bigint,
  name text,
  description text,
  trigger_type text,
  source_type text,
  account_email text,
  provider text,
  match_sender text,
  match_subject_pattern text,
  use_ai_matching boolean,
  ai_prompt text,
  delivery_method text,
  time_constraint jsonb,
  fire_count int,
  last_fired_at timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    t.id, t.name, t.description, t.trigger_type, t.source_type,
    t.account_email, t.provider, t.match_sender,
    t.match_subject_pattern, t.use_ai_matching, t.ai_prompt,
    t.delivery_method, t.time_constraint,
    t.fire_count, t.last_fired_at, t.created_at
  from public.notification_watch_triggers t
  where t.handle = p_handle
    and t.active = true
  order by t.created_at desc;
$$;

-- mark_trigger_fired: new table name
create or replace function public.mark_trigger_fired(
  p_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_watch_triggers
  set fire_count = fire_count + 1,
      last_fired_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

-- Keep old function names as aliases for backward compatibility during transition
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
language sql
security definer
set search_path = public
as $$
  select public.insert_notification_watch_trigger(
    p_handle, p_name, p_description, p_trigger_type, 'email',
    p_account_email, p_provider, p_match_sender, p_match_subject_pattern,
    p_match_labels, p_use_ai_matching, p_ai_prompt, p_delivery_method, null
  );
$$;

create or replace function public.delete_email_watch_trigger(
  p_id bigint,
  p_handle text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.delete_notification_watch_trigger(p_id, p_handle);
$$;

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
  from public.notification_watch_triggers t
  where t.handle = p_handle
    and t.active = true
    and t.source_type in ('email', 'any')
  order by t.created_at desc;
$$;
