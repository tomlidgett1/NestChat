-- Pre-computed deep profile snapshot: LLM-synthesised user profile
-- built after ingestion completes, used for instant "what do you know about me" responses.

alter table public.user_profiles
  add column if not exists deep_profile_snapshot jsonb null,
  add column if not exists deep_profile_built_at timestamptz null;

comment on column public.user_profiles.deep_profile_snapshot is 'LLM-synthesised profile snapshot built from ingested emails, calendar, contacts. Used for instant deep profile responses.';
comment on column public.user_profiles.deep_profile_built_at is 'When the deep profile snapshot was last built/refreshed.';
