-- Memory System v2: typed memory items, conversation summaries, tool traces
-- Replaces flat user_profiles.facts with structured, provenance-tracked memory

-- ============================================================================
-- Table: memory_items
-- Canonical structured memory store with provenance, confidence, and lifecycle
-- ============================================================================

create table if not exists public.memory_items (
  id bigint generated always as identity primary key,
  handle text not null,
  chat_id text,
  memory_type text not null,
  category text not null default 'general',
  value_text text not null,
  normalized_value text,
  confidence numeric not null default 0.0,
  status text not null default 'active',
  scope text not null default 'user',
  source_kind text not null,
  source_message_ids jsonb not null default '[]'::jsonb,
  source_summary_id bigint,
  extractor_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_confirmed_at timestamptz,
  expiry_at timestamptz,
  supersedes_memory_id bigint references public.memory_items(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memory_items_handle_status_type_idx
  on public.memory_items (handle, status, memory_type);

create index if not exists memory_items_handle_status_last_seen_idx
  on public.memory_items (handle, status, last_seen_at desc);

create index if not exists memory_items_handle_normalized_value_idx
  on public.memory_items (handle, normalized_value);

create index if not exists memory_items_expiry_idx
  on public.memory_items (expiry_at)
  where expiry_at is not null;

alter table public.memory_items enable row level security;

drop trigger if exists memory_items_set_updated_at on public.memory_items;
create trigger memory_items_set_updated_at
before update on public.memory_items
for each row
execute function public.set_updated_at();

-- ============================================================================
-- Table: conversation_summaries
-- Compressed retrieval artifacts — secondary to raw messages and memory_items
-- ============================================================================

create table if not exists public.conversation_summaries (
  id bigint generated always as identity primary key,
  chat_id text not null,
  sender_handle text,
  summary text not null,
  topics text[] not null default '{}',
  open_loops text[] not null default '{}',
  summary_kind text not null default 'segment',
  first_message_at timestamptz not null,
  last_message_at timestamptz not null,
  message_count integer not null,
  confidence numeric not null default 0.8,
  source_message_ids jsonb not null default '[]'::jsonb,
  extractor_version text,
  created_at timestamptz not null default now()
);

create index if not exists conversation_summaries_chat_id_last_msg_idx
  on public.conversation_summaries (chat_id, last_message_at desc);

create index if not exists conversation_summaries_sender_handle_idx
  on public.conversation_summaries (sender_handle, last_message_at desc);

create index if not exists conversation_summaries_topics_gin_idx
  on public.conversation_summaries using gin (topics);

alter table public.conversation_summaries enable row level security;

-- ============================================================================
-- Table: tool_traces
-- Safe tool usage records, separate from message text
-- ============================================================================

create table if not exists public.tool_traces (
  id bigint generated always as identity primary key,
  chat_id text not null,
  message_id bigint,
  tool_name text not null,
  outcome text not null,
  safe_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tool_traces_chat_id_created_at_idx
  on public.tool_traces (chat_id, created_at desc);

alter table public.tool_traces enable row level security;

-- ============================================================================
-- Extend conversation_messages TTL from 1 hour to 24 hours
-- ============================================================================

create or replace function public.append_conversation_message(
  p_chat_id text,
  p_role text,
  p_content text,
  p_handle text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_is_group_chat boolean default false,
  p_chat_name text default null,
  p_participant_names jsonb default '[]'::jsonb,
  p_service text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_expires_at timestamptz := now() + interval '24 hours';
begin
  insert into public.conversations (
    chat_id,
    messages,
    last_active,
    expires_at
  )
  values (
    p_chat_id,
    '[]'::jsonb,
    extract(epoch from v_now)::bigint,
    v_expires_at
  )
  on conflict (chat_id) do update
    set last_active = excluded.last_active,
        expires_at = excluded.expires_at;

  insert into public.conversation_messages (
    chat_id,
    role,
    content,
    handle,
    metadata,
    created_at,
    expires_at
  )
  values (
    p_chat_id,
    p_role,
    p_content,
    p_handle,
    coalesce(p_metadata, '{}'::jsonb),
    v_now,
    v_expires_at
  );
end;
$$;

-- ============================================================================
-- RPCs: memory_items
-- ============================================================================

create or replace function public.insert_memory_item(
  p_handle text,
  p_chat_id text,
  p_memory_type text,
  p_category text,
  p_value_text text,
  p_normalized_value text,
  p_confidence numeric,
  p_status text,
  p_scope text,
  p_source_kind text,
  p_source_message_ids jsonb,
  p_source_summary_id bigint default null,
  p_extractor_version text default null,
  p_expiry_at timestamptz default null,
  p_supersedes_memory_id bigint default null,
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
  insert into public.memory_items (
    handle, chat_id, memory_type, category, value_text, normalized_value,
    confidence, status, scope, source_kind, source_message_ids,
    source_summary_id, extractor_version, expiry_at,
    supersedes_memory_id, metadata, last_confirmed_at
  )
  values (
    p_handle, p_chat_id, p_memory_type, p_category, p_value_text,
    p_normalized_value, p_confidence, p_status, p_scope, p_source_kind,
    coalesce(p_source_message_ids, '[]'::jsonb),
    p_source_summary_id, p_extractor_version, p_expiry_at,
    p_supersedes_memory_id, coalesce(p_metadata, '{}'::jsonb),
    case when p_status = 'active' then now() else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.supersede_memory_item(
  p_old_id bigint,
  p_new_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.memory_items
    set status = 'superseded',
        updated_at = now()
    where id = p_old_id
      and status = 'active';

  update public.memory_items
    set supersedes_memory_id = p_old_id,
        updated_at = now()
    where id = p_new_id;
end;
$$;

create or replace function public.mark_memory_item_status(
  p_id bigint,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.memory_items
    set status = p_status,
        updated_at = now(),
        last_confirmed_at = case
          when p_status = 'active' then now()
          else last_confirmed_at
        end
    where id = p_id;
end;
$$;

create or replace function public.confirm_memory_item(
  p_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.memory_items
    set last_confirmed_at = now(),
        last_seen_at = now(),
        updated_at = now()
    where id = p_id;
end;
$$;

create or replace function public.get_active_memory_items(
  p_handle text,
  p_limit integer default 30
)
returns table(
  id bigint,
  handle text,
  chat_id text,
  memory_type text,
  category text,
  value_text text,
  normalized_value text,
  confidence numeric,
  status text,
  scope text,
  source_kind text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_confirmed_at timestamptz,
  expiry_at timestamptz,
  metadata jsonb,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    mi.id, mi.handle, mi.chat_id, mi.memory_type, mi.category,
    mi.value_text, mi.normalized_value, mi.confidence, mi.status,
    mi.scope, mi.source_kind, mi.first_seen_at, mi.last_seen_at,
    mi.last_confirmed_at, mi.expiry_at, mi.metadata, mi.created_at
  from public.memory_items mi
  where mi.handle = p_handle
    and mi.status = 'active'
    and (mi.expiry_at is null or mi.expiry_at > now())
  order by mi.last_seen_at desc
  limit greatest(p_limit, 1);
$$;

create or replace function public.expire_stale_memory_items()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.memory_items
    set status = 'expired',
        updated_at = now()
    where status = 'active'
      and expiry_at is not null
      and expiry_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============================================================================
-- RPCs: conversation_summaries
-- ============================================================================

create or replace function public.get_idle_conversations_needing_summary(
  p_idle_minutes integer default 15,
  p_limit integer default 10
)
returns table(
  chat_id text,
  message_count bigint,
  first_message_at timestamptz,
  last_message_at timestamptz,
  since_ts timestamptz
)
language sql
security definer
set search_path = public
as $$
  with latest_messages as (
    select
      cm.chat_id,
      count(*) as message_count,
      min(cm.created_at) as first_message_at,
      max(cm.created_at) as last_message_at
    from public.conversation_messages cm
    where cm.expires_at > now()
    group by cm.chat_id
    having max(cm.created_at) < now() - make_interval(mins => p_idle_minutes)
  ),
  latest_summaries as (
    select
      cs.chat_id,
      max(cs.last_message_at) as last_summarised_at
    from public.conversation_summaries cs
    group by cs.chat_id
  )
  select
    lm.chat_id,
    lm.message_count,
    lm.first_message_at,
    lm.last_message_at,
    coalesce(ls.last_summarised_at, '1970-01-01T00:00:00Z'::timestamptz) as since_ts
  from latest_messages lm
  left join latest_summaries ls on ls.chat_id = lm.chat_id
  where lm.last_message_at > coalesce(ls.last_summarised_at, '1970-01-01T00:00:00Z'::timestamptz)
  order by lm.last_message_at asc
  limit greatest(p_limit, 1);
$$;

create or replace function public.get_unsummarised_messages(
  p_chat_id text,
  p_since timestamptz default '1970-01-01T00:00:00Z'::timestamptz
)
returns table(
  id bigint,
  role text,
  content text,
  handle text,
  metadata jsonb,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    cm.id, cm.role, cm.content, cm.handle, cm.metadata, cm.created_at
  from public.conversation_messages cm
  where cm.chat_id = p_chat_id
    and cm.created_at > p_since
  order by cm.created_at asc;
$$;

create or replace function public.save_conversation_summary(
  p_chat_id text,
  p_sender_handle text,
  p_summary text,
  p_topics text[],
  p_open_loops text[],
  p_summary_kind text,
  p_first_message_at timestamptz,
  p_last_message_at timestamptz,
  p_message_count integer,
  p_confidence numeric,
  p_source_message_ids jsonb,
  p_extractor_version text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if exists (
    select 1 from public.conversation_summaries
    where chat_id = p_chat_id
      and last_message_at >= p_last_message_at
  ) then
    return null;
  end if;

  insert into public.conversation_summaries (
    chat_id, sender_handle, summary, topics, open_loops, summary_kind,
    first_message_at, last_message_at, message_count, confidence,
    source_message_ids, extractor_version
  )
  values (
    p_chat_id, p_sender_handle, p_summary, coalesce(p_topics, '{}'),
    coalesce(p_open_loops, '{}'), p_summary_kind,
    p_first_message_at, p_last_message_at, p_message_count,
    p_confidence, coalesce(p_source_message_ids, '[]'::jsonb),
    p_extractor_version
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.get_conversation_summaries(
  p_chat_id text,
  p_limit integer default 5
)
returns table(
  id bigint,
  chat_id text,
  sender_handle text,
  summary text,
  topics text[],
  open_loops text[],
  summary_kind text,
  first_message_at timestamptz,
  last_message_at timestamptz,
  message_count integer,
  confidence numeric,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    cs.id, cs.chat_id, cs.sender_handle, cs.summary, cs.topics,
    cs.open_loops, cs.summary_kind, cs.first_message_at,
    cs.last_message_at, cs.message_count, cs.confidence, cs.created_at
  from public.conversation_summaries cs
  where cs.chat_id = p_chat_id
  order by cs.last_message_at desc
  limit greatest(p_limit, 1);
$$;

-- ============================================================================
-- RPCs: tool_traces
-- ============================================================================

create or replace function public.insert_tool_trace(
  p_chat_id text,
  p_message_id bigint,
  p_tool_name text,
  p_outcome text,
  p_safe_summary text default null,
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
  insert into public.tool_traces (
    chat_id, message_id, tool_name, outcome, safe_summary, metadata
  )
  values (
    p_chat_id, p_message_id, p_tool_name, p_outcome,
    p_safe_summary, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.get_recent_tool_traces(
  p_chat_id text,
  p_limit integer default 5
)
returns table(
  id bigint,
  chat_id text,
  tool_name text,
  outcome text,
  safe_summary text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    tt.id, tt.chat_id, tt.tool_name, tt.outcome,
    tt.safe_summary, tt.created_at
  from public.tool_traces tt
  where tt.chat_id = p_chat_id
  order by tt.created_at desc
  limit greatest(p_limit, 1);
$$;

-- ============================================================================
-- Cron: summarise idle conversations + expire stale memories
-- ============================================================================

create or replace function public.configure_memory_cron_jobs(
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
    perform cron.unschedule('summarise-idle-conversations');
  exception
    when others then null;
  end;

  perform cron.schedule(
    'summarise-idle-conversations',
    '*/5 * * * *',
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"batchSize":10}'::jsonb
      ) as request_id;
      $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/summarise-conversations',
      p_bearer_token
    )
  );

  begin
    perform cron.unschedule('expire-stale-memories');
  exception
    when others then null;
  end;

  perform cron.schedule(
    'expire-stale-memories',
    '0 * * * *',
    $expire$select public.expire_stale_memory_items();$expire$
  );
end;
$fn$;
