create or replace function public.configure_keep_warm_cron(
  p_project_url text,
  p_service_role_key text,
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
    perform cron.unschedule('keep-warm-webhook');
  exception
    when others then null;
  end;

  select cron.schedule(
    'keep-warm-webhook',
    p_schedule,
    format(
      $schedule$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb
      ) as request_id;
      $schedule$,
      rtrim(p_project_url, '/') || '/functions/v1/sendblue-webhook',
      p_service_role_key
    )
  ) into v_job_id;

  return v_job_id;
end;
$$;
