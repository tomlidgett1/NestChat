alter table public.turn_traces
  add column if not exists pending_action_debug jsonb default '{}'::jsonb;
