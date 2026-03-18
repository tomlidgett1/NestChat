-- Capture user-submitted "bug:" reports from iMessage flows.

create table if not exists public.reported_bugs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  reported_date date generated always as ((created_at at time zone 'utc')::date) stored,
  reported_time time generated always as ((created_at at time zone 'utc')::time) stored,
  auth_user_id uuid null references auth.users(id) on delete set null,
  sender_handle text null,
  chat_id text not null,
  provider text null,
  service text null,
  message_text text not null,
  bug_text text not null,
  prior_messages jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists reported_bugs_created_at_idx
  on public.reported_bugs (created_at desc);

create index if not exists reported_bugs_auth_user_id_idx
  on public.reported_bugs (auth_user_id);

create index if not exists reported_bugs_chat_id_idx
  on public.reported_bugs (chat_id);
