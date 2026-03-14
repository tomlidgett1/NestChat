-- Add context_path column to track light vs full context build
alter table public.turn_traces
  add column if not exists context_path text default 'full';
