create table if not exists public.pending_actions (
  id bigint generated always as identity primary key,
  chat_id text not null,
  action_type text not null,
  status text not null default 'awaiting_confirmation',
  draft_id text,
  account text,
  to_recipients jsonb not null default '[]'::jsonb,
  subject text,
  source_turn_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text
);

create index if not exists pending_actions_chat_created_idx
  on public.pending_actions (chat_id, created_at desc);

create index if not exists pending_actions_chat_status_idx
  on public.pending_actions (chat_id, status, created_at desc);

create index if not exists pending_actions_expires_idx
  on public.pending_actions (expires_at)
  where expires_at is not null;

alter table public.pending_actions enable row level security;

drop policy if exists "anon_full_access_pending_actions" on public.pending_actions;
create policy "anon_full_access_pending_actions"
  on public.pending_actions
  for all
  to anon, authenticated
  using (true)
  with check (true);

drop trigger if exists pending_actions_set_updated_at on public.pending_actions;
create trigger pending_actions_set_updated_at
before update on public.pending_actions
for each row
execute function public.set_updated_at();
