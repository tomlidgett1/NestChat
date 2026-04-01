-- Move pg_net / pg_cron Edge Function auth off legacy service_role bearer tokens.
-- Stores a dedicated internal shared secret in nest_pg_net_edge_settings and sends
-- it via x-internal-secret headers for scheduled Edge Function calls.

alter table if exists public.nest_pg_net_edge_settings
  add column if not exists internal_shared_secret text;

alter table if exists public.nest_pg_net_edge_settings
  alter column service_role_key drop not null;

comment on table public.nest_pg_net_edge_settings is
  'Singleton pg_net settings for scheduled Edge Function calls. Stores project URL, legacy service_role key for transitional tooling, and a dedicated internal shared secret for machine-to-machine auth.';

comment on column public.nest_pg_net_edge_settings.internal_shared_secret is
  'Dedicated shared secret for pg_net -> Edge Function auth. Seed separately from Supabase API keys.';

comment on column public.nest_pg_net_edge_settings.service_role_key is
  'Legacy transitional column. No longer used by scheduled Edge Function calls after the internal shared secret cutover.';

do $body$
begin
  perform cron.unschedule('lightspeed-inventory-cron-3h');
exception
  when others then null;
end;
$body$;

do $body$
begin
  perform cron.unschedule('lightspeed-sales-workorders-cron-1h');
exception
  when others then null;
end;
$body$;

do $body$
begin
  perform cron.unschedule('moment-engine');
exception
  when others then null;
end;
$body$;

do $body$
begin
  perform cron.unschedule('calendar-timezone-cron-daily');
exception
  when others then null;
end;
$body$;

select cron.schedule(
  'lightspeed-inventory-cron-3h',
  '0 */3 * * *',
  $cmd$
  select net.http_post(
    url := rtrim((select supabase_url from public.nest_pg_net_edge_settings where id = 1), '/') || '/functions/v1/lightspeed-inventory-cron',
    headers := jsonb_build_object(
      'x-internal-secret', (select internal_shared_secret from public.nest_pg_net_edge_settings where id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

select cron.schedule(
  'lightspeed-sales-workorders-cron-1h',
  '0 * * * *',
  $cmd$
  select net.http_post(
    url := rtrim((select supabase_url from public.nest_pg_net_edge_settings where id = 1), '/') || '/functions/v1/lightspeed-sync-sales-workorders',
    headers := jsonb_build_object(
      'x-internal-secret', (select internal_shared_secret from public.nest_pg_net_edge_settings where id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

select cron.schedule(
  'moment-engine',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := rtrim((select supabase_url from public.nest_pg_net_edge_settings where id = 1), '/') || '/functions/v1/moment-engine',
    headers := jsonb_build_object(
      'x-internal-secret', (select internal_shared_secret from public.nest_pg_net_edge_settings where id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{"limit": 50}'::jsonb
  );
  $cmd$
);

select cron.schedule(
  'calendar-timezone-cron-daily',
  '12 1 * * *',
  $cmd$
  select net.http_post(
    url := rtrim((select supabase_url from public.nest_pg_net_edge_settings where id = 1), '/') || '/functions/v1/calendar-timezone-cron',
    headers := jsonb_build_object(
      'x-internal-secret', (select internal_shared_secret from public.nest_pg_net_edge_settings where id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

create or replace function public.nest_pg_net_lightspeed_sales_ping()
returns bigint
language sql
security definer
set search_path = public
as $$
  select net.http_post(
    url := rtrim(s.supabase_url, '/') || '/functions/v1/lightspeed-sync-sales-workorders',
    headers := jsonb_build_object(
      'x-internal-secret', s.internal_shared_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  from public.nest_pg_net_edge_settings s
  where s.id = 1;
$$;

comment on function public.nest_pg_net_lightspeed_sales_ping() is
  'Returns pg_net request id; verifies nest_pg_net_edge_settings + x-internal-secret scheduled auth path.';
