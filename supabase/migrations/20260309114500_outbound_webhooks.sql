create table if not exists public.sendblue_status_events (
  id bigint generated always as identity primary key,
  provider_message_id text not null,
  chat_id text not null,
  direction text not null,
  status text not null,
  raw_payload jsonb not null,
  error text null,
  created_at timestamptz not null default now()
);

create index if not exists sendblue_status_events_message_idx
  on public.sendblue_status_events (provider_message_id, created_at desc);

create unique index if not exists outbound_messages_provider_message_id_uidx
  on public.outbound_messages (provider_message_id);

alter table public.sendblue_status_events enable row level security;
