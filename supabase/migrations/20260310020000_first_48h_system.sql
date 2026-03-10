-- First 48 Hours System: behavioural state machine, onboarding events,
-- proactive messages, experiment assignments.

-- ============================================================================
-- Extend user_profiles with onboarding state machine columns
-- ============================================================================

alter table public.user_profiles
  add column if not exists onboard_state text not null default 'new_user_unclassified',
  add column if not exists entry_state text,
  add column if not exists first_value_wedge text,
  add column if not exists first_value_delivered_at timestamptz,
  add column if not exists follow_through_delivered_at timestamptz,
  add column if not exists second_engagement_at timestamptz,
  add column if not exists checkin_opt_in boolean,
  add column if not exists checkin_decline_at timestamptz,
  add column if not exists checkin_last_permission_at timestamptz,
  add column if not exists memory_moment_delivered_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists at_risk_at timestamptz,
  add column if not exists last_proactive_sent_at timestamptz,
  add column if not exists last_proactive_ignored boolean not null default false,
  add column if not exists proactive_ignore_count integer not null default 0,
  add column if not exists recovery_nudge_sent_at timestamptz,
  add column if not exists timezone text,
  add column if not exists activation_score integer not null default 0,
  add column if not exists capability_categories_used text[] not null default '{}';

create index if not exists user_profiles_onboard_state_idx
  on public.user_profiles (onboard_state)
  where status = 'active' or status = 'pending';

create index if not exists user_profiles_proactive_eligible_idx
  on public.user_profiles (onboard_state, last_proactive_sent_at)
  where status = 'active';

-- ============================================================================
-- Table: onboarding_events
-- Structured event log for the first 48 hours (S21)
-- ============================================================================

create table if not exists public.onboarding_events (
  id bigint generated always as identity primary key,
  handle text not null,
  chat_id text,
  event_type text not null,
  message_turn_index integer,
  entry_state text,
  value_wedge text,
  current_state text,
  experiment_variant_ids jsonb not null default '[]'::jsonb,
  confidence_scores jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists onboarding_events_handle_idx
  on public.onboarding_events (handle, created_at desc);

create index if not exists onboarding_events_type_idx
  on public.onboarding_events (event_type, created_at desc);

alter table public.onboarding_events enable row level security;

-- ============================================================================
-- Table: proactive_messages
-- Tracks all proactive outbound messages for spam-hold enforcement
-- ============================================================================

create table if not exists public.proactive_messages (
  id bigint generated always as identity primary key,
  handle text not null,
  chat_id text,
  message_type text not null,
  content text not null,
  sent_at timestamptz not null default now(),
  replied_at timestamptz,
  ignored boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists proactive_messages_handle_sent_idx
  on public.proactive_messages (handle, sent_at desc);

alter table public.proactive_messages enable row level security;

-- ============================================================================
-- Table: experiment_assignments
-- A/B test variant assignments per user
-- ============================================================================

create table if not exists public.experiment_assignments (
  id bigint generated always as identity primary key,
  handle text not null,
  experiment_name text not null,
  variant text not null,
  assigned_at timestamptz not null default now(),
  constraint experiment_assignments_unique unique (handle, experiment_name)
);

create index if not exists experiment_assignments_handle_idx
  on public.experiment_assignments (handle);

alter table public.experiment_assignments enable row level security;

-- ============================================================================
-- RPC: emit_onboarding_event
-- Single-row insert for event instrumentation
-- ============================================================================

create or replace function public.emit_onboarding_event(
  p_handle text,
  p_chat_id text,
  p_event_type text,
  p_message_turn_index integer default null,
  p_entry_state text default null,
  p_value_wedge text default null,
  p_current_state text default null,
  p_experiment_variant_ids jsonb default '[]'::jsonb,
  p_confidence_scores jsonb default null,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.onboarding_events (
    handle, chat_id, event_type, message_turn_index,
    entry_state, value_wedge, current_state,
    experiment_variant_ids, confidence_scores, payload
  )
  values (
    p_handle, p_chat_id, p_event_type, p_message_turn_index,
    p_entry_state, p_value_wedge, p_current_state,
    coalesce(p_experiment_variant_ids, '[]'::jsonb),
    p_confidence_scores,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================================
-- RPC: update_onboard_state_machine
-- Atomic state transition with validation
-- ============================================================================

create or replace function public.update_onboard_state_machine(
  p_handle text,
  p_new_state text,
  p_entry_state text default null,
  p_first_value_wedge text default null,
  p_first_value_delivered boolean default false,
  p_follow_through_delivered boolean default false,
  p_second_engagement boolean default false,
  p_checkin_opt_in boolean default null,
  p_memory_moment_delivered boolean default false,
  p_activated boolean default false,
  p_at_risk boolean default false,
  p_capability_category text default null,
  p_timezone text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_state text;
  v_now timestamptz := now();
  v_categories text[];
  v_score integer;
begin
  select onboard_state into v_old_state
  from public.user_profiles
  where handle = p_handle;

  if v_old_state is null then
    return null;
  end if;

  update public.user_profiles
  set
    onboard_state = p_new_state,
    entry_state = coalesce(p_entry_state, entry_state),
    first_value_wedge = coalesce(p_first_value_wedge, first_value_wedge),
    first_value_delivered_at = case when p_first_value_delivered and first_value_delivered_at is null then v_now else first_value_delivered_at end,
    follow_through_delivered_at = case when p_follow_through_delivered and follow_through_delivered_at is null then v_now else follow_through_delivered_at end,
    second_engagement_at = case when p_second_engagement and second_engagement_at is null then v_now else second_engagement_at end,
    checkin_opt_in = coalesce(p_checkin_opt_in, checkin_opt_in),
    checkin_decline_at = case when p_checkin_opt_in = false then v_now else checkin_decline_at end,
    checkin_last_permission_at = case when p_checkin_opt_in is not null then v_now else checkin_last_permission_at end,
    memory_moment_delivered_at = case when p_memory_moment_delivered and memory_moment_delivered_at is null then v_now else memory_moment_delivered_at end,
    activated_at = case when p_activated and activated_at is null then v_now else activated_at end,
    at_risk_at = case when p_at_risk and at_risk_at is null then v_now else at_risk_at end,
    timezone = coalesce(p_timezone, timezone),
    capability_categories_used = case
      when p_capability_category is not null and not (capability_categories_used @> array[p_capability_category])
      then capability_categories_used || array[p_capability_category]
      else capability_categories_used
    end
  where handle = p_handle;

  -- Recompute activation score
  select capability_categories_used into v_categories
  from public.user_profiles where handle = p_handle;

  v_score := 0;
  -- Criterion 1: 2+ meaningful inbound messages (onboard_count >= 3 means at least 2 after opener)
  if (select onboard_count from public.user_profiles where handle = p_handle) >= 3 then
    v_score := v_score + 1;
  end if;
  -- Criterion 2: successful follow-through
  if (select follow_through_delivered_at from public.user_profiles where handle = p_handle) is not null then
    v_score := v_score + 1;
  end if;
  -- Criterion 3: check-in opt-in
  if (select checkin_opt_in from public.user_profiles where handle = p_handle) = true then
    v_score := v_score + 1;
  end if;
  -- Criterion 4: day-2 return (first_seen + 24h < second_engagement)
  if (select second_engagement_at from public.user_profiles where handle = p_handle) is not null
     and (select second_engagement_at from public.user_profiles where handle = p_handle)
         > to_timestamp((select first_seen from public.user_profiles where handle = p_handle)) + interval '20 hours' then
    v_score := v_score + 1;
  end if;
  -- Criterion 5: memory moment delivered
  if (select memory_moment_delivered_at from public.user_profiles where handle = p_handle) is not null then
    v_score := v_score + 1;
  end if;
  -- Criterion 6: second capability category used
  if array_length(v_categories, 1) >= 2 then
    v_score := v_score + 1;
  end if;

  update public.user_profiles
  set activation_score = v_score
  where handle = p_handle;

  return v_old_state;
end;
$$;

-- ============================================================================
-- RPC: record_proactive_message
-- ============================================================================

create or replace function public.record_proactive_message(
  p_handle text,
  p_chat_id text,
  p_message_type text,
  p_content text,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.proactive_messages (
    handle, chat_id, message_type, content, metadata
  )
  values (
    p_handle, p_chat_id, p_message_type, p_content,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  update public.user_profiles
  set last_proactive_sent_at = now()
  where handle = p_handle;

  return v_id;
end;
$$;

-- ============================================================================
-- RPC: mark_proactive_replied
-- ============================================================================

create or replace function public.mark_proactive_replied(
  p_handle text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.proactive_messages
  set replied_at = now()
  where handle = p_handle
    and replied_at is null
    and sent_at = (
      select max(sent_at) from public.proactive_messages
      where handle = p_handle and replied_at is null
    );

  update public.user_profiles
  set last_proactive_ignored = false
  where handle = p_handle;
end;
$$;

-- ============================================================================
-- RPC: get_proactive_eligible_users
-- Returns users who may need a proactive message
-- ============================================================================

create or replace function public.get_proactive_eligible_users(
  p_limit integer default 20
)
returns table(
  handle text,
  name text,
  onboard_state text,
  entry_state text,
  first_value_wedge text,
  first_value_delivered_at timestamptz,
  follow_through_delivered_at timestamptz,
  second_engagement_at timestamptz,
  checkin_opt_in boolean,
  checkin_decline_at timestamptz,
  memory_moment_delivered_at timestamptz,
  activated_at timestamptz,
  last_proactive_sent_at timestamptz,
  last_proactive_ignored boolean,
  proactive_ignore_count integer,
  recovery_nudge_sent_at timestamptz,
  activation_score integer,
  capability_categories_used text[],
  bot_number text,
  first_seen bigint,
  last_seen bigint,
  onboard_count integer,
  timezone text
)
language sql
security definer
set search_path = public
as $$
  select
    up.handle, up.name, up.onboard_state, up.entry_state,
    up.first_value_wedge, up.first_value_delivered_at,
    up.follow_through_delivered_at, up.second_engagement_at,
    up.checkin_opt_in, up.checkin_decline_at,
    up.memory_moment_delivered_at, up.activated_at,
    up.last_proactive_sent_at, up.last_proactive_ignored,
    up.proactive_ignore_count, up.recovery_nudge_sent_at,
    up.activation_score, up.capability_categories_used,
    up.bot_number, up.first_seen, up.last_seen,
    up.onboard_count, up.timezone
  from public.user_profiles up
  where up.status = 'active'
    and up.activated_at is null
    and up.first_seen > extract(epoch from now() - interval '48 hours')::bigint
    and (
      up.last_proactive_sent_at is null
      or up.last_proactive_sent_at < now() - interval '4 hours'
    )
    and up.proactive_ignore_count < 2
  order by up.last_seen asc
  limit greatest(p_limit, 1);
$$;

-- ============================================================================
-- RPC: assign_experiment
-- Idempotent experiment assignment
-- ============================================================================

create or replace function public.assign_experiment(
  p_handle text,
  p_experiment_name text,
  p_variants text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant text;
  v_existing text;
begin
  select variant into v_existing
  from public.experiment_assignments
  where handle = p_handle and experiment_name = p_experiment_name;

  if v_existing is not null then
    return v_existing;
  end if;

  v_variant := p_variants[1 + floor(random() * array_length(p_variants, 1))::integer];

  insert into public.experiment_assignments (handle, experiment_name, variant)
  values (p_handle, p_experiment_name, v_variant)
  on conflict (handle, experiment_name) do nothing;

  select variant into v_variant
  from public.experiment_assignments
  where handle = p_handle and experiment_name = p_experiment_name;

  return v_variant;
end;
$$;

-- ============================================================================
-- Cron: proactive orchestrator (every 5 minutes)
-- ============================================================================

create or replace function public.configure_proactive_cron(
  p_project_url text,
  p_bearer_token text
)
returns void
language plpgsql
security definer
set search_path = public, cron, net
as $fn$
begin
  begin
    perform cron.unschedule('proactive-orchestrator');
  exception
    when others then null;
  end;

  perform cron.schedule(
    'proactive-orchestrator',
    '*/5 * * * *',
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"limit":20}'::jsonb
      ) as request_id;
      $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/proactive-orchestrator',
      p_bearer_token
    )
  );
end;
$fn$;

-- ============================================================================
-- Update ensure_nest_user to return new columns
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
           up.onboard_state, up.entry_state,
           up.first_value_wedge, up.first_value_delivered_at,
           up.second_engagement_at, up.checkin_opt_in,
           up.activation_score, up.capability_categories_used,
           up.last_proactive_sent_at, up.last_proactive_ignored,
           up.proactive_ignore_count, up.recovery_nudge_sent_at,
           up.timezone, up.first_seen, up.last_seen
    from public.user_profiles up
    where up.handle = p_handle;
end;
$$;
