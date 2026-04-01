-- ============================================================================
-- Moments System — admin-configurable, production-grade automation engine
--
-- Replaces the hardcoded automation rules with database-driven moment
-- definitions that admins can create, edit, target, schedule, deploy,
-- pause, and monitor without code changes.
-- ============================================================================

-- ─────────────────────────────────────────────
-- 1. Enum types
-- ─────────────────────────────────────────────

create type moment_status as enum ('draft', 'active', 'paused', 'archived');

create type moment_trigger_type as enum (
  'relative_time',
  'inactivity',
  'event',
  'scheduled',
  'table_condition',
  'opt_in'
);

create type moment_action_type as enum (
  'send_message',
  'run_agentic_task',
  'create_reminder',
  'trigger_morning_brief'
);

create type moment_exec_status as enum (
  'pending', 'executing', 'sent', 'failed',
  'skipped', 'deduplicated', 'cooldown_blocked',
  'frequency_capped', 'suppressed', 'dry_run'
);

-- ─────────────────────────────────────────────
-- 2. moments — core moment definitions
-- ─────────────────────────────────────────────

create table public.moments (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  description           text,
  status                moment_status not null default 'draft',
  version               integer not null default 1,

  trigger_type          moment_trigger_type not null,
  trigger_config        jsonb not null default '{}',

  audience_config       jsonb not null default '{"mode": "all_active"}',
  conditions            jsonb not null default '[]',

  action_type           moment_action_type not null default 'send_message',
  action_config         jsonb not null default '{}',

  prompt_template       text,
  prompt_system_context text,
  prompt_variables      jsonb not null default '[]',

  cooldown_hours        integer not null default 24,
  max_per_day_per_user  integer not null default 1,
  max_per_user_total    integer,
  priority              integer not null default 100,
  quiet_hours_start     integer not null default 21,
  quiet_hours_end       integer not null default 7,

  rollout_pct           integer not null default 100 check (rollout_pct between 0 and 100),
  test_mode             boolean not null default false,
  test_handles          text[] not null default '{}',

  timezone_behavior     text not null default 'user_local',
  timezone_fixed        text,

  window_start_hour     integer,
  window_end_hour       integer,

  tags                  text[] not null default '{}',

  is_system             boolean not null default false,
  created_by            text not null default 'system',
  updated_by            text not null default 'system',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  activated_at          timestamptz,
  paused_at             timestamptz
);

create index moments_status_idx on moments (status) where status = 'active';
create index moments_trigger_type_idx on moments (trigger_type, status);

-- ─────────────────────────────────────────────
-- 3. moment_versions — audit trail for edits
-- ─────────────────────────────────────────────

create table public.moment_versions (
  id              bigint generated always as identity primary key,
  moment_id       uuid not null references moments(id) on delete cascade,
  version         integer not null,
  snapshot        jsonb not null,
  changed_by      text not null,
  change_summary  text,
  created_at      timestamptz not null default now(),
  unique (moment_id, version)
);

-- ─────────────────────────────────────────────
-- 4. moment_executions — every execution attempt
-- ─────────────────────────────────────────────

create table public.moment_executions (
  id                bigint generated always as identity primary key,
  moment_id         uuid not null references moments(id),
  moment_version    integer not null,
  handle            text not null,
  chat_id           text,

  status            moment_exec_status not null default 'pending',
  skip_reason       text,

  rendered_content  text,
  prompt_used       text,

  sent_at           timestamptz,
  delivered_at      timestamptz,
  replied_at        timestamptz,
  ignored           boolean not null default false,

  metadata          jsonb not null default '{}',
  error_message     text,
  execution_ms      integer,
  idempotency_key   text not null,

  created_at        timestamptz not null default now()
);

create unique index moment_exec_idemp_idx
  on moment_executions (idempotency_key);
create index moment_exec_moment_handle_idx
  on moment_executions (moment_id, handle, created_at desc);
create index moment_exec_handle_sent_idx
  on moment_executions (handle, sent_at desc)
  where status = 'sent';
create index moment_exec_moment_status_idx
  on moment_executions (moment_id, status, created_at desc);

-- ─────────────────────────────────────────────
-- 5. moment_user_suppressions — user opt-outs
-- ─────────────────────────────────────────────

create table public.moment_user_suppressions (
  id            bigint generated always as identity primary key,
  handle        text not null,
  moment_id     uuid references moments(id) on delete cascade,
  scope         text not null default 'specific',
  reason        text,
  created_at    timestamptz not null default now()
);

create unique index moment_user_suppress_idx
  on moment_user_suppressions (handle, moment_id)
  where moment_id is not null;
create unique index moment_user_suppress_all_idx
  on moment_user_suppressions (handle)
  where scope = 'all' and moment_id is null;

-- ─────────────────────────────────────────────
-- 6. moment_global_config — system-wide guardrails
-- ─────────────────────────────────────────────

create table public.moment_global_config (
  key         text primary key,
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

insert into moment_global_config (key, value) values
  ('global_daily_cap', '2'),
  ('global_cooldown_hours', '2'),
  ('quiet_hours', '{"start": 21, "end": 7}'),
  ('max_consecutive_ignores', '3'),
  ('ignore_hold_hours', '72'),
  ('kill_switch', 'false');

-- ─────────────────────────────────────────────
-- 7. RPCs — record a moment execution
-- ─────────────────────────────────────────────

create or replace function public.record_moment_execution(
  p_moment_id       uuid,
  p_moment_version  integer,
  p_handle          text,
  p_chat_id         text,
  p_status          moment_exec_status,
  p_skip_reason     text default null,
  p_rendered_content text default null,
  p_prompt_used     text default null,
  p_metadata        jsonb default '{}'::jsonb,
  p_error_message   text default null,
  p_execution_ms    integer default null,
  p_idempotency_key text default null
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into public.moment_executions (
    moment_id, moment_version, handle, chat_id,
    status, skip_reason, rendered_content, prompt_used,
    sent_at, metadata, error_message, execution_ms, idempotency_key
  )
  values (
    p_moment_id, p_moment_version, p_handle, p_chat_id,
    p_status, p_skip_reason, p_rendered_content, p_prompt_used,
    case when p_status = 'sent' then now() else null end,
    p_metadata, p_error_message, p_execution_ms,
    coalesce(p_idempotency_key, p_moment_id::text || ':' || p_handle || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is not null and p_status = 'sent' then
    update public.user_profiles
    set last_proactive_sent_at = now()
    where handle = p_handle;
  end if;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────
-- 8. RPCs — check idempotency
-- ─────────────────────────────────────────────

create or replace function public.moment_execution_exists(p_idempotency_key text)
returns boolean
language sql stable
as $$
  select exists(
    select 1 from moment_executions where idempotency_key = p_idempotency_key
  );
$$;

-- ─────────────────────────────────────────────
-- 9. RPCs — count user's moment sends today
-- ─────────────────────────────────────────────

create or replace function public.moment_sends_today(p_handle text)
returns integer
language sql stable
as $$
  select count(*)::integer
  from moment_executions
  where handle = p_handle
    and status = 'sent'
    and sent_at > now() - interval '24 hours';
$$;

-- ─────────────────────────────────────────────
-- 10. RPCs — last send of specific moment to user
-- ─────────────────────────────────────────────

create or replace function public.moment_last_sent(p_moment_id uuid, p_handle text)
returns timestamptz
language sql stable
as $$
  select max(sent_at)
  from moment_executions
  where moment_id = p_moment_id
    and handle = p_handle
    and status = 'sent';
$$;

-- ─────────────────────────────────────────────
-- 11. RPCs — total sends of moment to user
-- ─────────────────────────────────────────────

create or replace function public.moment_total_sends(p_moment_id uuid, p_handle text)
returns integer
language sql stable
as $$
  select count(*)::integer
  from moment_executions
  where moment_id = p_moment_id
    and handle = p_handle
    and status = 'sent';
$$;

-- ─────────────────────────────────────────────
-- 12. RPCs — check user suppression
-- ─────────────────────────────────────────────

create or replace function public.is_moment_suppressed(p_handle text, p_moment_id uuid)
returns boolean
language sql stable
as $$
  select exists(
    select 1 from moment_user_suppressions
    where handle = p_handle
      and (moment_id = p_moment_id or scope = 'all')
  );
$$;

-- ─────────────────────────────────────────────
-- 13. RPCs — get global config value
-- ─────────────────────────────────────────────

create or replace function public.get_moment_config(p_key text)
returns jsonb
language sql stable
as $$
  select value from moment_global_config where key = p_key;
$$;

-- ─────────────────────────────────────────────
-- 14. RPCs — mark moment execution replied
-- ─────────────────────────────────────────────

create or replace function public.mark_moment_replied(p_handle text)
returns void
language plpgsql
as $$
begin
  update moment_executions
  set replied_at = now(), ignored = false
  where id = (
    select id from moment_executions
    where handle = p_handle
      and status = 'sent'
      and replied_at is null
    order by sent_at desc
    limit 1
  );

  update user_profiles
  set last_proactive_ignored = false,
      proactive_ignore_count = 0
  where handle = p_handle;
end;
$$;

-- ─────────────────────────────────────────────
-- 15. RPCs — get moment stats (aggregate metrics)
-- ─────────────────────────────────────────────

create or replace function public.get_moment_stats(p_moment_id uuid)
returns table(
  total_sent        bigint,
  total_skipped     bigint,
  total_failed      bigint,
  total_deduplicated bigint,
  total_cooldown    bigint,
  total_suppressed  bigint,
  total_dry_run     bigint,
  unique_users      bigint,
  replied_count     bigint,
  ignored_count     bigint,
  avg_execution_ms  numeric,
  last_sent_at      timestamptz
)
language sql stable
as $$
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'skipped'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status = 'deduplicated'),
    count(*) filter (where status = 'cooldown_blocked'),
    count(*) filter (where status = 'suppressed'),
    count(*) filter (where status = 'dry_run'),
    count(distinct handle) filter (where status = 'sent'),
    count(*) filter (where replied_at is not null),
    count(*) filter (where ignored = true),
    avg(execution_ms) filter (where execution_ms is not null),
    max(sent_at)
  from moment_executions
  where moment_id = p_moment_id;
$$;

-- ─────────────────────────────────────────────
-- 16. RPCs — get moment executions (paginated)
-- ─────────────────────────────────────────────

create or replace function public.get_moment_executions(
  p_moment_id uuid,
  p_limit     integer default 50,
  p_offset    integer default 0
)
returns table(
  id               bigint,
  moment_version   integer,
  handle           text,
  chat_id          text,
  status           moment_exec_status,
  skip_reason      text,
  rendered_content text,
  sent_at          timestamptz,
  replied_at       timestamptz,
  ignored          boolean,
  metadata         jsonb,
  error_message    text,
  execution_ms     integer,
  created_at       timestamptz
)
language sql stable
as $$
  select
    me.id, me.moment_version, me.handle, me.chat_id,
    me.status, me.skip_reason, me.rendered_content,
    me.sent_at, me.replied_at, me.ignored,
    me.metadata, me.error_message, me.execution_ms, me.created_at
  from moment_executions me
  where me.moment_id = p_moment_id
  order by me.created_at desc
  limit p_limit offset p_offset;
$$;

-- ─────────────────────────────────────────────
-- 17. RPCs — get global moment stats
-- ─────────────────────────────────────────────

create or replace function public.get_global_moment_stats()
returns table(
  total_moments     bigint,
  active_moments    bigint,
  paused_moments    bigint,
  draft_moments     bigint,
  total_sent_24h    bigint,
  total_sent_7d     bigint,
  unique_users_24h  bigint,
  unique_users_7d   bigint
)
language sql stable
as $$
  select
    (select count(*) from moments),
    (select count(*) from moments where status = 'active'),
    (select count(*) from moments where status = 'paused'),
    (select count(*) from moments where status = 'draft'),
    (select count(*) from moment_executions where status = 'sent' and sent_at > now() - interval '24 hours'),
    (select count(*) from moment_executions where status = 'sent' and sent_at > now() - interval '7 days'),
    (select count(distinct handle) from moment_executions where status = 'sent' and sent_at > now() - interval '24 hours'),
    (select count(distinct handle) from moment_executions where status = 'sent' and sent_at > now() - interval '7 days');
$$;

-- ─────────────────────────────────────────────
-- 18. RPCs — get user moment history
-- ─────────────────────────────────────────────

create or replace function public.get_user_moment_history(
  p_handle text,
  p_limit  integer default 50
)
returns table(
  id               bigint,
  moment_id        uuid,
  moment_name      text,
  moment_version   integer,
  status           moment_exec_status,
  rendered_content text,
  sent_at          timestamptz,
  replied_at       timestamptz,
  ignored          boolean,
  created_at       timestamptz
)
language sql stable
as $$
  select
    me.id, me.moment_id, m.name, me.moment_version,
    me.status, me.rendered_content,
    me.sent_at, me.replied_at, me.ignored, me.created_at
  from moment_executions me
  join moments m on m.id = me.moment_id
  where me.handle = p_handle
  order by me.created_at desc
  limit p_limit;
$$;

-- ─────────────────────────────────────────────
-- 19. RPCs — save moment version snapshot
-- ─────────────────────────────────────────────

create or replace function public.save_moment_version(
  p_moment_id     uuid,
  p_changed_by    text,
  p_change_summary text default null
)
returns integer
language plpgsql
as $$
declare
  v_version integer;
  v_snapshot jsonb;
begin
  select version into v_version from moments where id = p_moment_id;
  select to_jsonb(m) into v_snapshot from moments m where m.id = p_moment_id;

  insert into moment_versions (moment_id, version, snapshot, changed_by, change_summary)
  values (p_moment_id, v_version, v_snapshot, p_changed_by, p_change_summary)
  on conflict (moment_id, version) do update
    set snapshot = excluded.snapshot,
        changed_by = excluded.changed_by,
        change_summary = excluded.change_summary,
        created_at = now();

  return v_version;
end;
$$;

-- ─────────────────────────────────────────────
-- 20. RPCs — last send time of ANY moment to user
-- ─────────────────────────────────────────────

create or replace function public.moment_last_sent_any(p_handle text)
returns timestamptz
language sql stable
as $$
  select max(sent_at)
  from moment_executions
  where handle = p_handle and status = 'sent';
$$;

-- ─────────────────────────────────────────────
-- 21. Cron configuration for moment engine
-- ─────────────────────────────────────────────

create or replace function public.configure_moment_engine_cron(
  p_project_url  text,
  p_bearer_token text
)
returns void
language plpgsql
as $$
begin
  -- Remove old automation-engine cron (replaced by moment-engine)
  begin
    perform cron.unschedule('automation-engine');
  exception when others then
    raise notice 'automation-engine cron not found, skipping unschedule';
  end;

  perform cron.schedule(
    'moment-engine',
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
      rtrim(p_project_url, '/') || '/functions/v1/moment-engine',
      p_bearer_token
    )
  );
exception
  when others then
    raise notice 'Cron configuration skipped (pg_cron may not be available): %', sqlerrm;
end;
$$;
