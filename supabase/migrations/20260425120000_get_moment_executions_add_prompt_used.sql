-- Include prompt_used in admin execution history (dry_run / logging often store text here).
-- Return type change requires drop + create (not CREATE OR REPLACE).

drop function if exists public.get_moment_executions(uuid, integer, integer);

create function public.get_moment_executions(
  p_moment_id uuid,
  p_limit     integer default 50,
  p_offset    integer default 0
)
returns table(
  id               bigint,
  moment_version   integer,
  handle           text,
  chat_id          text,
  status           moment_exec_status,
  skip_reason      text,
  rendered_content text,
  prompt_used      text,
  sent_at          timestamptz,
  replied_at       timestamptz,
  ignored          boolean,
  metadata         jsonb,
  error_message    text,
  execution_ms     integer,
  created_at       timestamptz
)
language sql stable
as $$
  select
    me.id, me.moment_version, me.handle, me.chat_id,
    me.status, me.skip_reason, me.rendered_content, me.prompt_used,
    me.sent_at, me.replied_at, me.ignored,
    me.metadata, me.error_message, me.execution_ms, me.created_at
  from moment_executions me
  where me.moment_id = p_moment_id
  order by me.created_at desc
  limit p_limit offset p_offset;
$$;
