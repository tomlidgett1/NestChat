-- Daily job: compare each user's linked calendar timezone to user_profiles.timezone;
-- send an iMessage when it changes (Edge Function: calendar-timezone-cron).

DO $body$
BEGIN
  PERFORM cron.unschedule('calendar-timezone-cron-daily');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

SELECT cron.schedule(
  'calendar-timezone-cron-daily',
  '0 1 * * *',
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
