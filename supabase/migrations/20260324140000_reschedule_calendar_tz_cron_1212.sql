-- Reschedule calendar-timezone-cron to 12:12 PM Melbourne (01:12 UTC).

DO $body$
BEGIN
  PERFORM cron.unschedule('calendar-timezone-cron-daily');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

SELECT cron.schedule(
  'calendar-timezone-cron-daily',
  '12 1 * * *',
  $cmd$
  SELECT net.http_post(
    url := rtrim((SELECT supabase_url FROM public.nest_pg_net_edge_settings WHERE id = 1), '/') || '/functions/v1/calendar-timezone-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT service_role_key FROM public.nest_pg_net_edge_settings WHERE id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
