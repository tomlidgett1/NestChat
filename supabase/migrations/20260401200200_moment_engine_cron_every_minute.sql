-- Schedule moment-engine to run every minute via pg_cron + pg_net.
-- Reads URL + bearer from nest_pg_net_edge_settings (same pattern as other crons).

DO $body$
BEGIN
  PERFORM cron.unschedule('moment-engine');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

DO $body$
BEGIN
  PERFORM cron.unschedule('automation-engine');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

SELECT cron.schedule(
  'moment-engine',
  '* * * * *',
  $cmd$
  SELECT net.http_post(
    url    := rtrim((SELECT supabase_url FROM public.nest_pg_net_edge_settings WHERE id = 1), '/') || '/functions/v1/moment-engine',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT service_role_key FROM public.nest_pg_net_edge_settings WHERE id = 1)
    ),
    body   := '{"limit": 50}'::jsonb
  );
  $cmd$
);
