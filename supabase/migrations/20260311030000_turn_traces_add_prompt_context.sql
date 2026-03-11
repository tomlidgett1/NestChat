-- Add full prompt context to turn_traces for debug dashboard visibility
alter table public.turn_traces
  add column if not exists system_prompt text,
  add column if not exists initial_messages jsonb,
  add column if not exists available_tool_names text[] default '{}';
