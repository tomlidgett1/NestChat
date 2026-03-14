-- Granola MCP account table for storing OAuth tokens.
-- Granola uses browser-based OAuth via the MCP endpoint at https://mcp.granola.ai/mcp

create table if not exists public.user_granola_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  granola_email text not null,
  granola_name text,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, granola_email)
);

create index if not exists user_granola_accounts_user_id_idx
  on public.user_granola_accounts (user_id);

alter table public.user_granola_accounts enable row level security;

drop policy if exists "users_select_own_granola_accounts" on public.user_granola_accounts;
create policy "users_select_own_granola_accounts"
  on public.user_granola_accounts for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users_delete_own_granola_accounts" on public.user_granola_accounts;
create policy "users_delete_own_granola_accounts"
  on public.user_granola_accounts for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "service_role_full_granola_accounts" on public.user_granola_accounts;
create policy "service_role_full_granola_accounts"
  on public.user_granola_accounts for all
  to service_role
  using (true)
  with check (true);
