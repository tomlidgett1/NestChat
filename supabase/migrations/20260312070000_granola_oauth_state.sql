-- Temporary storage for Granola OAuth flow state (PKCE verifier, user binding).
-- Rows are cleaned up after callback or expire after 10 minutes.

create table if not exists public.granola_oauth_state (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  client_id text not null,
  client_secret text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now()
);

alter table public.granola_oauth_state enable row level security;

drop policy if exists "service_role_full_granola_oauth_state" on public.granola_oauth_state;
create policy "service_role_full_granola_oauth_state"
  on public.granola_oauth_state for all
  to service_role
  using (true)
  with check (true);
