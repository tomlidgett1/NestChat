-- ============================================================================
-- Turn traces: comprehensive observability for every orchestrator turn
-- ============================================================================

create table if not exists public.turn_traces (
  id bigint generated always as identity primary key,
  turn_id uuid not null,
  chat_id text not null,
  sender_handle text not null,
  created_at timestamptz not null default now(),

  -- Input
  user_message text,
  timezone_resolved text,

  -- Routing
  route_agent text not null,
  route_mode text,
  route_confidence real,
  route_fast_path boolean default false,
  route_latency_ms integer default 0,
  route_namespaces text[] default '{}',

  -- Context
  system_prompt_length integer default 0,
  system_prompt_hash text,
  memory_items_loaded integer default 0,
  summaries_loaded integer default 0,
  rag_evidence_blocks integer default 0,
  connected_accounts_count integer default 0,
  history_messages_count integer default 0,
  context_build_latency_ms integer default 0,

  -- Agent loop
  agent_name text not null,
  model_used text not null,
  agent_loop_rounds integer default 0,
  agent_loop_latency_ms integer default 0,

  -- Tool calls (detailed JSONB array)
  tool_calls jsonb not null default '[]'::jsonb,
  tool_calls_blocked jsonb not null default '[]'::jsonb,
  tool_call_count integer default 0,
  tool_total_latency_ms integer default 0,

  -- Model usage
  input_tokens integer default 0,
  output_tokens integer default 0,

  -- Response
  response_text text,
  response_length integer default 0,

  -- Overall
  total_latency_ms integer default 0,

  -- Error tracking
  error_message text,
  error_stage text
);

create index if not exists turn_traces_chat_id_idx
  on public.turn_traces (chat_id, created_at desc);

create index if not exists turn_traces_sender_handle_idx
  on public.turn_traces (sender_handle, created_at desc);

create index if not exists turn_traces_created_at_idx
  on public.turn_traces (created_at desc);

create index if not exists turn_traces_agent_name_idx
  on public.turn_traces (agent_name, created_at desc);

alter table public.turn_traces enable row level security;
