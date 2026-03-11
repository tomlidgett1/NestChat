create table if not exists public.conversations (
  chat_id text primary key,
  messages jsonb not null default '[]'::jsonb,
  last_active bigint not null,
  expires_at timestamptz not null
);

create index if not exists conversations_expires_at_idx
  on public.conversations (expires_at);

create table if not exists public.user_profiles (
  handle text primary key,
  name text null,
  facts jsonb not null default '[]'::jsonb,
  use_linq boolean not null default false,
  first_seen bigint not null,
  last_seen bigint not null
);

alter table public.conversations enable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists "anon_full_access_conversations" on public.conversations;
create policy "anon_full_access_conversations"
  on public.conversations
  for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "anon_full_access_user_profiles" on public.user_profiles;
create policy "anon_full_access_user_profiles"
  on public.user_profiles
  for all
  to anon, authenticated
  using (true)
  with check (true);
