create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.configure_inbound_queue_cron(
  p_project_url text,
  p_bearer_token text,
  p_schedule text default '* * * * *'
)
returns bigint
language plpgsql
security definer
set search_path = public, cron, net
as $$
declare
  v_job_id bigint;
begin
  begin
    perform cron.unschedule('drain-inbound-events');
  exception
    when others then null;
  end;

  select cron.schedule(
    'drain-inbound-events',
    p_schedule,
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"batchSize":3}'::jsonb
      ) as request_id;
      $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/process-inbound-queue',
      p_bearer_token
    )
  ) into v_job_id;

  return v_job_id;
end;
$$;
