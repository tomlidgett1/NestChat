-- ============================================================================
-- Automation Engine — scalable framework for proactive user engagement
--
-- Design principles:
--   1. Every automation type is a row-level concept, not a code branch
--   2. Every execution is logged with full context for debugging + dashboards
--   3. Eligibility is computed in SQL for performance (no N+1 in edge functions)
--   4. Frequency guardrails are enforced at the DB level
--   5. Adding a new automation type = adding a new evaluator function, nothing else
-- ============================================================================

-- ─────────────────────────────────────────────
-- 1. automation_runs — the single source of truth for all proactive outreach
-- ─────────────────────────────────────────────

create table if not exists public.automation_runs (
  id            bigint generated always as identity primary key,
  handle        text not null,
  chat_id       text,

  -- What automation fired
  automation_type text not null,
  -- e.g. 'morning_briefing', 'calendar_heads_up', 'feature_discovery_day3',
  --      'inactivity_day3', 'inactivity_day5', 'inactivity_day7',
  --      'follow_up_loop', 'memory_moment', 'important_email_alert'

  -- The message that was sent
  content       text not null,

  -- Engagement tracking
  sent_at       timestamptz not null default now(),
  delivered_at  timestamptz,
  replied_at    timestamptz,
  ignored       boolean not null default false,

  -- Rich context for debugging + dashboard
  metadata      jsonb not null default '{}'::jsonb,
  -- metadata can include: { calendar_events: [...], email_subjects: [...],
  --   generation_model: "gpt-4.1-mini", generation_latency_ms: 450,
  --   trigger_reason: "30min_before_event", event_title: "Dentist" }

  -- Was this triggered manually from the dashboard?
  manual_trigger boolean not null default false,
  triggered_by  text  -- admin handle or 'system'
);

create index automation_runs_handle_type_idx
  on automation_runs (handle, automation_type, sent_at desc);

create index automation_runs_handle_sent_idx
  on automation_runs (handle, sent_at desc);

create index automation_runs_type_sent_idx
  on automation_runs (automation_type, sent_at desc);

-- ─────────────────────────────────────────────
-- 2. automation_preferences — per-user opt-in/out + schedule overrides
-- ─────────────────────────────────────────────

create table if not exists public.automation_preferences (
  handle          text not null,
  automation_type text not null,

  enabled         boolean not null default true,
  -- User can say "stop morning briefings" → enabled = false

  schedule_override jsonb,
  -- e.g. { "hour": 7, "minute": 30 } for morning briefing
  -- e.g. { "lead_minutes": 45 } for calendar heads-up

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (handle, automation_type)
);

-- ─────────────────────────────────────────────
-- 3. RPC: record_automation_run — insert + update user profile
-- ─────────────────────────────────────────────

create or replace function public.record_automation_run(
  p_handle          text,
  p_chat_id         text,
  p_automation_type text,
  p_content         text,
  p_metadata        jsonb default '{}'::jsonb,
  p_manual_trigger  boolean default false,
  p_triggered_by    text default 'system'
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into public.automation_runs (handle, chat_id, automation_type, content, metadata, manual_trigger, triggered_by)
  values (p_handle, p_chat_id, p_automation_type, p_content, p_metadata, p_manual_trigger, p_triggered_by)
  returning id into v_id;

  -- Update last proactive sent timestamp on user profile
  update public.user_profiles
  set last_proactive_sent_at = now()
  where handle = p_handle;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────
-- 4. RPC: mark_automation_replied — called when user responds after an automation
-- ─────────────────────────────────────────────

create or replace function public.mark_automation_replied(p_handle text)
returns void
language plpgsql
as $$
begin
  -- Mark the most recent unreplied automation as replied
  update public.automation_runs
  set replied_at = now(),
      ignored = false
  where id = (
    select id from public.automation_runs
    where handle = p_handle
      and replied_at is null
    order by sent_at desc
    limit 1
  );

  -- Reset ignore flag on profile
  update public.user_profiles
  set last_proactive_ignored = false
  where handle = p_handle;
end;
$$;

-- ─────────────────────────────────────────────
-- 5. RPC: get_automation_eligible_users — ALL active users, not just first-48h
-- ─────────────────────────────────────────────

create or replace function public.get_automation_eligible_users(p_limit integer default 50)
returns table(
  handle                    text,
  name                      text,
  onboard_state             text,
  entry_state               text,
  first_value_wedge         text,
  first_value_delivered_at   timestamptz,
  follow_through_delivered_at timestamptz,
  second_engagement_at      timestamptz,
  memory_moment_delivered_at timestamptz,
  activated_at              timestamptz,
  at_risk_at                timestamptz,
  last_proactive_sent_at    timestamptz,
  last_proactive_ignored    boolean,
  proactive_ignore_count    integer,
  activation_score          integer,
  capability_categories_used text[],
  bot_number                text,
  first_seen                bigint,
  last_seen                 bigint,
  onboard_count             integer,
  timezone                  text,
  auth_user_id              uuid,
  status                    text,
  deep_profile_snapshot     jsonb
)
language sql stable
as $$
  select
    up.handle,
    up.name,
    coalesce(up.onboard_state, 'new_user_unclassified'),
    up.entry_state,
    up.first_value_wedge,
    up.first_value_delivered_at,
    up.follow_through_delivered_at,
    up.second_engagement_at,
    up.memory_moment_delivered_at,
    up.activated_at,
    up.at_risk_at,
    up.last_proactive_sent_at,
    coalesce(up.last_proactive_ignored, false),
    coalesce(up.proactive_ignore_count, 0),
    coalesce(up.activation_score, 0),
    coalesce(up.capability_categories_used, '{}'::text[]),
    up.bot_number,
    up.first_seen,
    up.last_seen,
    coalesce(up.onboard_count, 0),
    up.timezone,
    up.auth_user_id,
    up.status,
    up.deep_profile_snapshot
  from public.user_profiles up
  where up.status = 'active'
    and up.bot_number is not null
    -- Minimum gap between proactive messages: 2 hours
    and (
      up.last_proactive_sent_at is null
      or up.last_proactive_sent_at < now() - interval '2 hours'
    )
    -- Stop after 3 consecutive ignores
    and coalesce(up.proactive_ignore_count, 0) < 3
  order by up.last_seen asc
  limit p_limit;
$$;

-- ─────────────────────────────────────────────
-- 6. RPC: get_user_automation_history — for the dashboard
-- ─────────────────────────────────────────────

create or replace function public.get_user_automation_history(
  p_handle text default null,
  p_limit  integer default 200
)
returns table(
  id              bigint,
  handle          text,
  chat_id         text,
  automation_type text,
  content         text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  replied_at      timestamptz,
  ignored         boolean,
  metadata        jsonb,
  manual_trigger  boolean,
  triggered_by    text
)
language sql stable
as $$
  select
    ar.id, ar.handle, ar.chat_id, ar.automation_type, ar.content,
    ar.sent_at, ar.delivered_at, ar.replied_at, ar.ignored,
    ar.metadata, ar.manual_trigger, ar.triggered_by
  from public.automation_runs ar
  where (p_handle is null or ar.handle = p_handle)
  order by ar.sent_at desc
  limit p_limit;
$$;

-- ─────────────────────────────────────────────
-- 7. RPC: get_all_users_with_automation_status — dashboard overview
-- ─────────────────────────────────────────────

create or replace function public.get_all_users_with_automation_status()
returns table(
  handle                text,
  name                  text,
  status                text,
  first_seen            bigint,
  last_seen             bigint,
  timezone              text,
  onboard_state         text,
  activation_score      integer,
  bot_number            text,
  proactive_ignore_count integer,
  last_proactive_sent_at timestamptz,
  auth_user_id          uuid,
  -- Computed automation stats
  total_automations_sent bigint,
  last_automation_at    timestamptz,
  last_automation_type  text,
  automations_replied   bigint,
  automations_ignored   bigint
)
language sql stable
as $$
  select
    up.handle,
    up.name,
    up.status,
    up.first_seen,
    up.last_seen,
    up.timezone,
    coalesce(up.onboard_state, 'new_user_unclassified'),
    coalesce(up.activation_score, 0),
    up.bot_number,
    coalesce(up.proactive_ignore_count, 0),
    up.last_proactive_sent_at,
    up.auth_user_id,
    coalesce(stats.total_sent, 0),
    stats.last_sent_at,
    stats.last_type,
    coalesce(stats.total_replied, 0),
    coalesce(stats.total_ignored, 0)
  from public.user_profiles up
  left join lateral (
    select
      count(*) as total_sent,
      max(ar.sent_at) as last_sent_at,
      (select ar2.automation_type from public.automation_runs ar2 where ar2.handle = up.handle order by ar2.sent_at desc limit 1) as last_type,
      count(*) filter (where ar.replied_at is not null) as total_replied,
      count(*) filter (where ar.ignored = true) as total_ignored
    from public.automation_runs ar
    where ar.handle = up.handle
  ) stats on true
  where up.status = 'active'
  order by up.last_seen desc;
$$;

-- ─────────────────────────────────────────────
-- 8. RPC: get_automation_user_preferences
-- ─────────────────────────────────────────────

create or replace function public.get_automation_preferences(p_handle text)
returns table(
  automation_type   text,
  enabled           boolean,
  schedule_override jsonb
)
language sql stable
as $$
  select ap.automation_type, ap.enabled, ap.schedule_override
  from public.automation_preferences ap
  where ap.handle = p_handle;
$$;

-- ─────────────────────────────────────────────
-- 9. RPC: last_automation_of_type — when did we last send this type?
-- ─────────────────────────────────────────────

create or replace function public.last_automation_of_type(
  p_handle          text,
  p_automation_type text
)
returns timestamptz
language sql stable
as $$
  select max(sent_at)
  from public.automation_runs
  where handle = p_handle
    and automation_type = p_automation_type;
$$;

-- ─────────────────────────────────────────────
-- 10. Helper: count automations of type in last N hours
-- ─────────────────────────────────────────────

create or replace function public.automation_count_in_window(
  p_handle          text,
  p_automation_type text,
  p_hours           integer default 24
)
returns integer
language sql stable
as $$
  select count(*)::integer
  from public.automation_runs
  where handle = p_handle
    and automation_type = p_automation_type
    and sent_at > now() - make_interval(hours => p_hours);
$$;

-- ─────────────────────────────────────────────
-- 11. Helper: total automations sent today for a user (all types)
-- ─────────────────────────────────────────────

create or replace function public.automations_sent_today(p_handle text)
returns integer
language sql stable
as $$
  select count(*)::integer
  from public.automation_runs
  where handle = p_handle
    and sent_at > now() - interval '24 hours';
$$;

-- ─────────────────────────────────────────────
-- 12. Cron configuration for the automation engine
-- ─────────────────────────────────────────────

create or replace function public.configure_automation_engine_cron(
  p_project_url  text,
  p_bearer_token text
)
returns void
language plpgsql
as $$
begin
  -- Remove old proactive-orchestrator cron (replaced by automation-engine)
  perform cron.unschedule('proactive-orchestrator');

  -- Schedule automation engine every 5 minutes
  perform cron.schedule(
    'automation-engine',
    '*/5 * * * *',
    format($schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"limit":30}'::jsonb
      ) as request_id;
    $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/automation-engine',
      p_bearer_token
    )
  );
exception
  when others then
    raise notice 'Cron configuration skipped (pg_cron may not be available): %', sqlerrm;
end;
$$;
