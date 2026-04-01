-- Preferred greeting label (falls back to name). Used by automations + RPC.

alter table public.user_profiles
  add column if not exists display_name text;

comment on column public.user_profiles.display_name is 'Preferred name for greetings; coalesced with name when null.';

update public.user_profiles
set display_name = name
where display_name is null
  and name is not null
  and trim(name) <> '';
