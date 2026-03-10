create extension if not exists pgmq;

do $$
begin
  perform pgmq.create('inbound_events');
exception
  when duplicate_table or duplicate_object then null;
end $$;

alter table public.conversations enable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists "anon_full_access_conversations" on public.conversations;
drop policy if exists "anon_full_access_user_profiles" on public.user_profiles;

create table if not exists public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_message_id text not null,
  chat_id text not null,
  sender_handle text not null,
  bot_number text not null,
  event_type text not null default 'message.received',
  status text not null default 'queued',
  raw_payload jsonb not null,
  normalized_payload jsonb not null,
  last_error text null,
  processing_started_at timestamptz null,
  processed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_message_id)
);

create index if not exists webhook_events_status_idx
  on public.webhook_events (status, created_at desc);

create table if not exists public.conversation_messages (
  id bigint generated always as identity primary key,
  chat_id text not null,
  role text not null,
  content text not null,
  handle text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists conversation_messages_chat_id_created_at_idx
  on public.conversation_messages (chat_id, created_at desc);

create index if not exists conversation_messages_expires_at_idx
  on public.conversation_messages (expires_at);

create table if not exists public.outbound_messages (
  id bigint generated always as identity primary key,
  chat_id text not null,
  kind text not null,
  payload jsonb not null,
  provider_message_id text null,
  status text not null default 'pending',
  error text null,
  created_at timestamptz not null default now(),
  sent_at timestamptz null
);

create index if not exists outbound_messages_chat_id_created_at_idx
  on public.outbound_messages (chat_id, created_at desc);

create table if not exists public.job_failures (
  id bigint generated always as identity primary key,
  queue_name text not null,
  queue_message_id bigint not null,
  webhook_event_id bigint null references public.webhook_events(id) on delete set null,
  attempt_number integer not null,
  error text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists job_failures_queue_message_id_idx
  on public.job_failures (queue_name, queue_message_id, created_at desc);

alter table public.webhook_events enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.job_failures enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists webhook_events_set_updated_at on public.webhook_events;
create trigger webhook_events_set_updated_at
before update on public.webhook_events
for each row
execute function public.set_updated_at();

create or replace function public.enqueue_webhook_event(
  p_provider text,
  p_provider_message_id text,
  p_chat_id text,
  p_sender_handle text,
  p_bot_number text,
  p_raw_payload jsonb,
  p_normalized_payload jsonb
)
returns table(event_id bigint, created boolean)
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_event_id bigint;
begin
  select id
    into v_event_id
  from public.webhook_events
  where provider = p_provider
    and provider_message_id = p_provider_message_id;

  if v_event_id is not null then
    return query select v_event_id, false;
    return;
  end if;

  insert into public.webhook_events (
    provider,
    provider_message_id,
    chat_id,
    sender_handle,
    bot_number,
    raw_payload,
    normalized_payload
  )
  values (
    p_provider,
    p_provider_message_id,
    p_chat_id,
    p_sender_handle,
    p_bot_number,
    p_raw_payload,
    p_normalized_payload
  )
  returning id into v_event_id;

  perform * from pgmq.send(
    'inbound_events',
    jsonb_build_object(
      'event_id', v_event_id,
      'provider', p_provider,
      'provider_message_id', p_provider_message_id
    ),
    0
  );

  return query select v_event_id, true;
end;
$$;

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
  v_expires_at timestamptz := now() + interval '1 hour';
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

create or replace function public.get_conversation_window(
  p_chat_id text,
  p_limit integer default 20
)
returns table(
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
  select recent.role, recent.content, recent.handle, recent.metadata, recent.created_at
  from (
    select
      cm.role,
      cm.content,
      cm.handle,
      cm.metadata,
      cm.created_at
    from public.conversation_messages cm
    where cm.chat_id = p_chat_id
      and cm.expires_at > now()
    order by cm.created_at desc
    limit greatest(p_limit, 1)
  ) as recent
  order by recent.created_at asc;
$$;

create or replace function public.clear_conversation_history(
  p_chat_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.conversation_messages where chat_id = p_chat_id;
  delete from public.conversations where chat_id = p_chat_id;
end;
$$;

