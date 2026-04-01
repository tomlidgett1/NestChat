alter table public.user_profiles
add column if not exists test_route_llm boolean not null default false;
