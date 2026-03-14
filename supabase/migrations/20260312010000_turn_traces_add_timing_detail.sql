-- Add granular timing detail columns to turn_traces for latency diagnostics
alter table public.turn_traces
  add column if not exists context_sub_timings jsonb,
  add column if not exists round_traces jsonb default '[]'::jsonb,
  add column if not exists prompt_compose_ms integer default 0,
  add column if not exists tool_filter_ms integer default 0,
  add column if not exists router_context_ms integer default 0;
