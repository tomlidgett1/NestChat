-- pg_cron jobs cannot rely on current_setting('app.settings.*') unless a DBA sets them on
-- the instance (they are not set by default). Store project URL + service role in a singleton
-- table that pg_cron (running as a privileged role) can read. RLS denies anon/authenticated;
-- Supabase service_role bypasses RLS for the seed upsert from automation.

CREATE TABLE IF NOT EXISTS public.nest_pg_net_edge_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  supabase_url text NOT NULL,
  service_role_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.nest_pg_net_edge_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nest_pg_net_edge_settings_deny_anon_auth ON public.nest_pg_net_edge_settings;
CREATE POLICY nest_pg_net_edge_settings_deny_anon_auth
  ON public.nest_pg_net_edge_settings
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON public.nest_pg_net_edge_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nest_pg_net_edge_settings TO service_role;

COMMENT ON TABLE public.nest_pg_net_edge_settings IS
  'Singleton credentials for pg_cron net.http_post → Edge Functions. Seed via service_role. Not readable by portal JWTs.';

-- Reschedule Lightspeed crons to read URL + bearer from the table (not from GUCs).

DO $body$
BEGIN
  PERFORM cron.unschedule('lightspeed-inventory-cron-3h');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

DO $body$
BEGIN
  PERFORM cron.unschedule('lightspeed-sales-workorders-cron-1h');
EXCEPTION
  WHEN others THEN NULL;
END;
$body$;

SELECT cron.schedule(
  'lightspeed-inventory-cron-3h',
  '0 */3 * * *',
  $cmd$
  SELECT net.http_post(
    url := rtrim((SELECT supabase_url FROM public.nest_pg_net_edge_settings WHERE id = 1), '/') || '/functions/v1/lightspeed-inventory-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT service_role_key FROM public.nest_pg_net_edge_settings WHERE id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

SELECT cron.schedule(
  'lightspeed-sales-workorders-cron-1h',
  '0 * * * *',
  $cmd$
  SELECT net.http_post(
    url := rtrim((SELECT supabase_url FROM public.nest_pg_net_edge_settings WHERE id = 1), '/') || '/functions/v1/lightspeed-sync-sales-workorders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT service_role_key FROM public.nest_pg_net_edge_settings WHERE id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- Optional: service_role-only smoke test (same net.http_post shape as cron).
CREATE OR REPLACE FUNCTION public.nest_pg_net_lightspeed_sales_ping()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT net.http_post(
    url := rtrim(s.supabase_url, '/') || '/functions/v1/lightspeed-sync-sales-workorders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || s.service_role_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  FROM public.nest_pg_net_edge_settings s
  WHERE s.id = 1;
$$;

REVOKE ALL ON FUNCTION public.nest_pg_net_lightspeed_sales_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nest_pg_net_lightspeed_sales_ping() TO service_role;

COMMENT ON FUNCTION public.nest_pg_net_lightspeed_sales_ping() IS
  'Returns pg_net request id; verifies nest_pg_net_edge_settings + net.http_post path. service_role only.';
