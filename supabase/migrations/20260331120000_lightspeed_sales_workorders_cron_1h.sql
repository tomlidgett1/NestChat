-- Hourly incremental sync: sales, sale lines, and work orders for every Lightspeed-connected brand.
-- Uses the same app.settings.supabase_url and app.settings.service_role_key as lightspeed-inventory-cron-3h.
-- Schedule: every hour at minute 0 (UTC).

DO $body$
BEGIN
  PERFORM cron.unschedule('lightspeed-sales-workorders-cron-1h');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

SELECT cron.schedule(
  'lightspeed-sales-workorders-cron-1h',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/lightspeed-sync-sales-workorders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
