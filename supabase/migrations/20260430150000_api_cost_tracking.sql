-- ── API Cost Tracking ────────────────────────────────────────────────────────
-- Multi-provider cost tracking for every LLM / AI API call.
--
-- Covers: OpenAI (chat, embeddings, DALL-E, Whisper, realtime),
--         Google Gemini (chat, embeddings), Anthropic Claude (chat).
--
-- Two-table design:
--   1. api_cost_logs    — one row per API call (raw audit trail)
--   2. api_daily_usage  — one row per (user, date), auto-maintained by trigger
--
-- Flow: App inserts into api_cost_logs → trigger fires → api_daily_usage upserted.

-- ═══════════════════════════════════════════════════════════════
-- 1. Raw log table — every single API call
-- ═══════════════════════════════════════════════════════════════

create table if not exists api_cost_logs (
  id                uuid          default gen_random_uuid() primary key,
  created_at        timestamptz   default now() not null,

  -- Who
  user_id           uuid          references auth.users(id) on delete set null,
  chat_id           text,                                       -- conversation / session ID
  sender_handle     text,                                       -- phone number or identifier

  -- What provider & model
  provider          text          not null,                     -- 'openai' | 'gemini' | 'anthropic'
  model             text          not null,                     -- e.g. 'gpt-5.4', 'gemini-3.1-flash-lite-preview', 'claude-sonnet-4-20250514'
  endpoint          text          not null default 'chat',      -- 'chat' | 'embeddings' | 'image_gen' | 'transcription' | 'tts' | 'realtime'

  -- Human-readable context
  description       text,                                       -- e.g. 'Agent called: send_email, get_calendar_events'
  agent_name        text,                                       -- 'casual' | 'productivity' | 'research' | 'operator' | etc.
  message_type      text          not null default 'text',      -- 'text' | 'voice' | 'image' | 'group_text' | 'group_voice' | 'proactive'

  -- Token breakdown
  tokens_in         integer       not null default 0,
  tokens_out        integer       not null default 0,
  tokens_total      integer       generated always as (tokens_in + tokens_out) stored,
  tokens_in_cached  integer       not null default 0,
  tokens_reasoning  integer       not null default 0,
  tokens_in_fresh   integer       generated always as (tokens_in - tokens_in_cached) stored,

  -- Cost breakdown (USD)
  cost_usd          numeric(12,8) not null default 0,           -- actual cost (with cache discount)
  cost_usd_no_cache numeric(12,8) not null default 0,           -- counterfactual cost without caching
  cache_savings_usd numeric(12,8) generated always as (cost_usd_no_cache - cost_usd) stored,

  -- Performance
  latency_ms        integer,
  agent_loop_round  integer,                                    -- which round of the agent loop (1, 2, 3...)

  -- Status
  status            text          not null default 'success',   -- 'success' | 'error'
  error_message     text,

  -- Extensible metadata
  metadata          jsonb
);

-- Indexes for common query patterns
create index if not exists api_cost_logs_user_created
  on api_cost_logs (user_id, created_at desc);

create index if not exists api_cost_logs_created
  on api_cost_logs (created_at desc);

create index if not exists api_cost_logs_chat_id
  on api_cost_logs (chat_id, created_at desc);

create index if not exists api_cost_logs_provider
  on api_cost_logs (provider, created_at desc);

create index if not exists api_cost_logs_sender
  on api_cost_logs (sender_handle, created_at desc);

create index if not exists api_cost_logs_agent
  on api_cost_logs (agent_name, created_at desc);

create index if not exists api_cost_logs_message_type
  on api_cost_logs (message_type, created_at desc);

-- ═══════════════════════════════════════════════════════════════
-- 2. Daily summary table — auto-aggregated by trigger
-- ═══════════════════════════════════════════════════════════════

create table if not exists api_daily_usage (
  id                 uuid          default gen_random_uuid() primary key,
  date               date          not null,
  user_id            uuid          references auth.users(id) on delete cascade,

  -- Cost totals
  daily_cost_usd     numeric(12,8) not null default 0,
  cost_usd_no_cache  numeric(12,8) not null default 0,
  cache_savings_usd  numeric(12,8) not null default 0,

  -- Token totals
  tokens_in          integer       not null default 0,
  tokens_out         integer       not null default 0,
  tokens_total       integer       not null default 0,
  tokens_cached      integer       not null default 0,
  tokens_reasoning   integer       not null default 0,

  -- Counts
  request_count      integer       not null default 0,

  updated_at         timestamptz   default now(),

  unique (date, user_id)
);

create index if not exists api_daily_usage_user_date
  on api_daily_usage (user_id, date desc);

-- ═══════════════════════════════════════════════════════════════
-- 3. Daily usage by PROVIDER — one row per (user, date, provider)
-- ═══════════════════════════════════════════════════════════════

create table if not exists api_daily_usage_by_provider (
  id                 uuid          default gen_random_uuid() primary key,
  date               date          not null,
  user_id            uuid          references auth.users(id) on delete cascade,
  provider           text          not null,

  daily_cost_usd     numeric(12,8) not null default 0,
  cost_usd_no_cache  numeric(12,8) not null default 0,
  cache_savings_usd  numeric(12,8) not null default 0,
  tokens_in          integer       not null default 0,
  tokens_out         integer       not null default 0,
  tokens_total       integer       not null default 0,
  tokens_cached      integer       not null default 0,
  tokens_reasoning   integer       not null default 0,
  request_count      integer       not null default 0,
  updated_at         timestamptz   default now(),

  unique (date, user_id, provider)
);

create index if not exists api_daily_provider_user_date
  on api_daily_usage_by_provider (user_id, date desc);

-- ═══════════════════════════════════════════════════════════════
-- 4. Daily usage by MESSAGE TYPE — one row per (user, date, message_type)
-- ═══════════════════════════════════════════════════════════════

create table if not exists api_daily_usage_by_message_type (
  id                 uuid          default gen_random_uuid() primary key,
  date               date          not null,
  user_id            uuid          references auth.users(id) on delete cascade,
  message_type       text          not null,

  daily_cost_usd     numeric(12,8) not null default 0,
  tokens_in          integer       not null default 0,
  tokens_out         integer       not null default 0,
  tokens_total       integer       not null default 0,
  request_count      integer       not null default 0,
  updated_at         timestamptz   default now(),

  unique (date, user_id, message_type)
);

create index if not exists api_daily_msgtype_user_date
  on api_daily_usage_by_message_type (user_id, date desc);

-- ═══════════════════════════════════════════════════════════════
-- 5. Upsert functions — called by the trigger
-- ═══════════════════════════════════════════════════════════════

-- 5a. Main daily usage upsert
create or replace function upsert_api_daily_usage(
  p_user_id           uuid,
  p_cost_usd          numeric,
  p_cost_usd_no_cache numeric,
  p_tokens_in         integer,
  p_tokens_out        integer,
  p_tokens_cached     integer,
  p_tokens_reasoning  integer
)
returns void
language sql
security definer
as $$
  insert into api_daily_usage (
    date, user_id,
    daily_cost_usd, cost_usd_no_cache, cache_savings_usd,
    tokens_in, tokens_out, tokens_total,
    tokens_cached, tokens_reasoning,
    request_count, updated_at
  )
  values (
    current_date, p_user_id,
    p_cost_usd, p_cost_usd_no_cache, p_cost_usd_no_cache - p_cost_usd,
    p_tokens_in, p_tokens_out, p_tokens_in + p_tokens_out,
    p_tokens_cached, p_tokens_reasoning,
    1, now()
  )
  on conflict (date, user_id)
  do update set
    daily_cost_usd    = api_daily_usage.daily_cost_usd    + excluded.daily_cost_usd,
    cost_usd_no_cache = api_daily_usage.cost_usd_no_cache + excluded.cost_usd_no_cache,
    cache_savings_usd = api_daily_usage.cache_savings_usd + (excluded.cost_usd_no_cache - excluded.daily_cost_usd),
    tokens_in         = api_daily_usage.tokens_in         + excluded.tokens_in,
    tokens_out        = api_daily_usage.tokens_out        + excluded.tokens_out,
    tokens_total      = api_daily_usage.tokens_total      + excluded.tokens_total,
    tokens_cached     = api_daily_usage.tokens_cached     + excluded.tokens_cached,
    tokens_reasoning  = api_daily_usage.tokens_reasoning  + excluded.tokens_reasoning,
    request_count     = api_daily_usage.request_count     + 1,
    updated_at        = now();
$$;

-- 5b. Provider-level daily usage upsert
create or replace function upsert_api_daily_usage_by_provider(
  p_user_id           uuid,
  p_provider          text,
  p_cost_usd          numeric,
  p_cost_usd_no_cache numeric,
  p_tokens_in         integer,
  p_tokens_out        integer,
  p_tokens_cached     integer,
  p_tokens_reasoning  integer
)
returns void
language sql
security definer
as $$
  insert into api_daily_usage_by_provider (
    date, user_id, provider,
    daily_cost_usd, cost_usd_no_cache, cache_savings_usd,
    tokens_in, tokens_out, tokens_total,
    tokens_cached, tokens_reasoning,
    request_count, updated_at
  )
  values (
    current_date, p_user_id, p_provider,
    p_cost_usd, p_cost_usd_no_cache, p_cost_usd_no_cache - p_cost_usd,
    p_tokens_in, p_tokens_out, p_tokens_in + p_tokens_out,
    p_tokens_cached, p_tokens_reasoning,
    1, now()
  )
  on conflict (date, user_id, provider)
  do update set
    daily_cost_usd    = api_daily_usage_by_provider.daily_cost_usd    + excluded.daily_cost_usd,
    cost_usd_no_cache = api_daily_usage_by_provider.cost_usd_no_cache + excluded.cost_usd_no_cache,
    cache_savings_usd = api_daily_usage_by_provider.cache_savings_usd + (excluded.cost_usd_no_cache - excluded.daily_cost_usd),
    tokens_in         = api_daily_usage_by_provider.tokens_in         + excluded.tokens_in,
    tokens_out        = api_daily_usage_by_provider.tokens_out        + excluded.tokens_out,
    tokens_total      = api_daily_usage_by_provider.tokens_total      + excluded.tokens_total,
    tokens_cached     = api_daily_usage_by_provider.tokens_cached     + excluded.tokens_cached,
    tokens_reasoning  = api_daily_usage_by_provider.tokens_reasoning  + excluded.tokens_reasoning,
    request_count     = api_daily_usage_by_provider.request_count     + 1,
    updated_at        = now();
$$;

-- 5c. Message-type daily usage upsert
create or replace function upsert_api_daily_usage_by_message_type(
  p_user_id       uuid,
  p_message_type  text,
  p_cost_usd      numeric,
  p_tokens_in     integer,
  p_tokens_out    integer
)
returns void
language sql
security definer
as $$
  insert into api_daily_usage_by_message_type (
    date, user_id, message_type,
    daily_cost_usd,
    tokens_in, tokens_out, tokens_total,
    request_count, updated_at
  )
  values (
    current_date, p_user_id, p_message_type,
    p_cost_usd,
    p_tokens_in, p_tokens_out, p_tokens_in + p_tokens_out,
    1, now()
  )
  on conflict (date, user_id, message_type)
  do update set
    daily_cost_usd = api_daily_usage_by_message_type.daily_cost_usd + excluded.daily_cost_usd,
    tokens_in      = api_daily_usage_by_message_type.tokens_in      + excluded.tokens_in,
    tokens_out     = api_daily_usage_by_message_type.tokens_out     + excluded.tokens_out,
    tokens_total   = api_daily_usage_by_message_type.tokens_total   + excluded.tokens_total,
    request_count  = api_daily_usage_by_message_type.request_count  + 1,
    updated_at     = now();
$$;

-- ═══════════════════════════════════════════════════════════════
-- 6. Trigger — fires on every api_cost_logs insert
-- ═══════════════════════════════════════════════════════════════

create or replace function trigger_upsert_api_daily_usage()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Only aggregate successful calls with a non-null user
  if NEW.status = 'success' and NEW.user_id is not null then
    -- Main daily rollup
    perform upsert_api_daily_usage(
      NEW.user_id,
      NEW.cost_usd,
      NEW.cost_usd_no_cache,
      NEW.tokens_in,
      NEW.tokens_out,
      NEW.tokens_in_cached,
      NEW.tokens_reasoning
    );

    -- Provider-level rollup
    perform upsert_api_daily_usage_by_provider(
      NEW.user_id,
      NEW.provider,
      NEW.cost_usd,
      NEW.cost_usd_no_cache,
      NEW.tokens_in,
      NEW.tokens_out,
      NEW.tokens_in_cached,
      NEW.tokens_reasoning
    );

    -- Message-type rollup
    perform upsert_api_daily_usage_by_message_type(
      NEW.user_id,
      NEW.message_type,
      NEW.cost_usd,
      NEW.tokens_in,
      NEW.tokens_out
    );
  end if;
  return NEW;
end;
$$;

create trigger on_api_cost_log_insert
  after insert on api_cost_logs
  for each row
  execute function trigger_upsert_api_daily_usage();

-- ═══════════════════════════════════════════════════════════════
-- 7. Analytics views
-- ═══════════════════════════════════════════════════════════════

-- 7a. Running total per user (with cache hit %)
create or replace view api_usage_running_total as
select
  d.date,
  d.user_id,
  u.email,
  d.daily_cost_usd,
  d.cost_usd_no_cache,
  d.cache_savings_usd,
  round(
    case
      when d.cost_usd_no_cache > 0
      then (d.cache_savings_usd / d.cost_usd_no_cache) * 100
      else 0
    end, 1
  ) as cache_hit_pct,
  round(
    sum(d.daily_cost_usd) over (
      partition by d.user_id order by d.date asc rows unbounded preceding
    ), 8
  ) as running_total_usd,
  round(
    sum(d.cache_savings_usd) over (
      partition by d.user_id order by d.date asc rows unbounded preceding
    ), 8
  ) as running_savings_usd,
  d.tokens_in,
  d.tokens_out,
  d.tokens_total,
  d.tokens_cached,
  d.tokens_reasoning,
  d.request_count,
  d.updated_at
from api_daily_usage d
left join auth.users u on u.id = d.user_id
order by d.date desc, d.daily_cost_usd desc;

-- 7b. Per-endpoint breakdown (which endpoint costs the most?)
create or replace view api_usage_by_endpoint as
select
  date_trunc('day', created_at at time zone 'utc')::date as date,
  user_id,
  provider,
  endpoint,
  model,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  sum(tokens_in_cached)                             as tokens_cached,
  sum(tokens_reasoning)                             as tokens_reasoning,
  round(sum(cost_usd)::numeric, 8)                  as cost_usd,
  round(sum(cost_usd_no_cache)::numeric, 8)         as cost_usd_no_cache,
  round(sum(cache_savings_usd)::numeric, 8)         as cache_savings_usd,
  round(avg(latency_ms))                            as avg_latency_ms,
  round(
    case
      when sum(tokens_in) > 0
      then (sum(tokens_in_cached)::numeric / sum(tokens_in)) * 100
      else 0
    end, 1
  )                                                 as cache_hit_pct
from api_cost_logs
where status = 'success'
group by 1, 2, 3, 4, 5
order by 1 desc, cost_usd desc;

-- 7c. Per-model breakdown (which model costs the most?)
create or replace view api_usage_by_model as
select
  date_trunc('day', created_at at time zone 'utc')::date as date,
  user_id,
  provider,
  model,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  sum(tokens_in_cached)                             as tokens_cached,
  sum(tokens_reasoning)                             as tokens_reasoning,
  round(sum(cost_usd)::numeric, 8)                  as cost_usd,
  round(sum(cost_usd_no_cache)::numeric, 8)         as cost_usd_no_cache,
  round(sum(cache_savings_usd)::numeric, 8)         as cache_savings_usd,
  round(avg(latency_ms))                            as avg_latency_ms,
  round(
    case
      when sum(tokens_in) > 0
      then (sum(tokens_in_cached)::numeric / sum(tokens_in)) * 100
      else 0
    end, 1
  )                                                 as cache_hit_pct
from api_cost_logs
where status = 'success'
group by 1, 2, 3, 4
order by 1 desc, cost_usd desc;

-- 7d. Per-provider breakdown (OpenAI vs Gemini vs Anthropic)
create or replace view api_usage_by_provider as
select
  date_trunc('day', created_at at time zone 'utc')::date as date,
  user_id,
  provider,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  sum(tokens_in_cached)                             as tokens_cached,
  sum(tokens_reasoning)                             as tokens_reasoning,
  round(sum(cost_usd)::numeric, 8)                  as cost_usd,
  round(sum(cost_usd_no_cache)::numeric, 8)         as cost_usd_no_cache,
  round(sum(cache_savings_usd)::numeric, 8)         as cache_savings_usd,
  round(avg(latency_ms))                            as avg_latency_ms
from api_cost_logs
where status = 'success'
group by 1, 2, 3
order by 1 desc, cost_usd desc;

-- 7e. Per-agent breakdown (which agent costs the most?)
create or replace view api_usage_by_agent as
select
  date_trunc('day', created_at at time zone 'utc')::date as date,
  user_id,
  agent_name,
  model,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  sum(tokens_in_cached)                             as tokens_cached,
  sum(tokens_reasoning)                             as tokens_reasoning,
  round(sum(cost_usd)::numeric, 8)                  as cost_usd,
  round(sum(cost_usd_no_cache)::numeric, 8)         as cost_usd_no_cache,
  round(avg(latency_ms))                            as avg_latency_ms
from api_cost_logs
where status = 'success'
group by 1, 2, 3, 4
order by 1 desc, cost_usd desc;

-- 7f. Per-message-type breakdown (text vs voice vs image vs group)
create or replace view api_usage_by_message_type as
select
  date_trunc('day', created_at at time zone 'utc')::date as date,
  user_id,
  message_type,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  round(sum(cost_usd)::numeric, 8)                  as cost_usd,
  round(avg(latency_ms))                            as avg_latency_ms
from api_cost_logs
where status = 'success'
group by 1, 2, 3
order by 1 desc, cost_usd desc;

-- 7g. Per-chat breakdown (cost per conversation)
create or replace view api_usage_by_chat as
select
  chat_id,
  user_id,
  min(created_at)                                   as first_call,
  max(created_at)                                   as last_call,
  count(*)                                          as request_count,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  round(sum(cost_usd)::numeric, 8)                  as total_cost_usd,
  round(avg(cost_usd)::numeric, 8)                  as avg_cost_per_call,
  round(avg(latency_ms))                            as avg_latency_ms
from api_cost_logs
where status = 'success' and chat_id is not null
group by 1, 2
order by total_cost_usd desc;

-- 7h. All-time summary per user (dashboard card)
create or replace view api_usage_summary as
select
  d.user_id,
  u.email,
  sum(d.daily_cost_usd)    as total_cost_usd,
  sum(d.cost_usd_no_cache) as total_cost_no_cache_usd,
  sum(d.cache_savings_usd) as total_cache_savings_usd,
  round(
    case
      when sum(d.cost_usd_no_cache) > 0
      then (sum(d.cache_savings_usd) / sum(d.cost_usd_no_cache)) * 100
      else 0
    end, 1
  )                        as overall_cache_hit_pct,
  sum(d.request_count)     as total_requests,
  sum(d.tokens_total)      as total_tokens,
  sum(d.tokens_cached)     as total_tokens_cached,
  sum(d.tokens_reasoning)  as total_tokens_reasoning,
  min(d.date)              as first_call_date,
  max(d.date)              as last_call_date,
  round(
    case
      when max(d.date) > min(d.date)
      then sum(d.daily_cost_usd) / (max(d.date) - min(d.date) + 1)
      else sum(d.daily_cost_usd)
    end, 8
  )                        as avg_daily_cost_usd
from api_daily_usage d
left join auth.users u on u.id = d.user_id
group by d.user_id, u.email;

-- 7i. Sender-level cost summary (cost per phone number / handle)
create or replace view api_usage_by_sender as
select
  sender_handle,
  user_id,
  count(*)                                          as request_count,
  min(created_at)                                   as first_call,
  max(created_at)                                   as last_call,
  sum(tokens_in)                                    as tokens_in,
  sum(tokens_out)                                   as tokens_out,
  round(sum(cost_usd)::numeric, 8)                  as total_cost_usd,
  round(avg(cost_usd)::numeric, 8)                  as avg_cost_per_call,
  round(avg(latency_ms))                            as avg_latency_ms
from api_cost_logs
where status = 'success' and sender_handle is not null
group by 1, 2
order by total_cost_usd desc;

-- ═══════════════════════════════════════════════════════════════
-- 8. RLS — service-role write, users read their own data
-- ═══════════════════════════════════════════════════════════════

alter table api_cost_logs                enable row level security;
alter table api_daily_usage              enable row level security;
alter table api_daily_usage_by_provider  enable row level security;
alter table api_daily_usage_by_message_type enable row level security;

create policy "Users can read their own cost logs"
  on api_cost_logs for select
  using (auth.uid() = user_id);

create policy "Users can read their own daily usage"
  on api_daily_usage for select
  using (auth.uid() = user_id);

create policy "Users can read their own provider usage"
  on api_daily_usage_by_provider for select
  using (auth.uid() = user_id);

create policy "Users can read their own message type usage"
  on api_daily_usage_by_message_type for select
  using (auth.uid() = user_id);
