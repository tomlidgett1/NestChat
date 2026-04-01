alter table public.user_profiles
add column if not exists context_profile jsonb not null default '{}'::jsonb;
