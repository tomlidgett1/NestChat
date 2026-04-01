-- List Lightspeed-related pg_cron jobs (service_role only). For ops verification.

CREATE OR REPLACE FUNCTION public.nest_debug_lightspeed_cron_jobs()
RETURNS TABLE(jobid bigint, jobname text, schedule text, command text, active boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public
AS $$
  SELECT j.jobid, j.jobname, j.schedule, j.command::text, j.active
  FROM cron.job j
  WHERE j.jobname LIKE '%lightspeed%'
  ORDER BY j.jobname;
$$;

REVOKE ALL ON FUNCTION public.nest_debug_lightspeed_cron_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nest_debug_lightspeed_cron_jobs() TO service_role;
