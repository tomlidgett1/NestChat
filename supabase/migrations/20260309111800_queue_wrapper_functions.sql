create or replace function public.read_queue_messages(
  p_queue_name text,
  p_sleep_seconds integer,
  p_n integer
)
returns table(
  msg_id bigint,
  read_ct bigint,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = public, pgmq
as $$
  select msg_id, read_ct, enqueued_at, vt, message
  from pgmq.read(p_queue_name, p_sleep_seconds, p_n);
$$;

create or replace function public.delete_queue_message(
  p_queue_name text,
  p_message_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.delete(p_queue_name, p_message_id);
$$;

create or replace function public.archive_queue_message(
  p_queue_name text,
  p_message_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.archive(p_queue_name, p_message_id);
$$;
