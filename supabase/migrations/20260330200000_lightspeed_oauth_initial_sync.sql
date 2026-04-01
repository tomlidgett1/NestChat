-- After Lightspeed OAuth completes, the Vercel callback sets lightspeed_oauth_handshake_at.
-- A trigger enqueues a sequential initial sync (inventory then sales/work orders) via pg_net.
-- Token refresh updates (persistRefreshedTokens) do not touch this column, so they do not re-fire.

ALTER TABLE public.nest_brand_portal_connections
  ADD COLUMN IF NOT EXISTS lightspeed_oauth_handshake_at timestamptz;

COMMENT ON COLUMN public.nest_brand_portal_connections.lightspeed_oauth_handshake_at IS
  'Set only by the Lightspeed OAuth callback. Used to trigger one-shot initial sync without firing on token refresh.';

CREATE OR REPLACE FUNCTION public.nest_lightspeed_after_oauth_handshake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.provider <> 'lightspeed' THEN
    RETURN NEW;
  END IF;
  IF NEW.lightspeed_oauth_handshake_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.lightspeed_oauth_handshake_at IS NOT DISTINCT FROM OLD.lightspeed_oauth_handshake_at THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/lightspeed-initial-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('brand_key', NEW.brand_key)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nest_lightspeed_oauth_handshake_initial_sync ON public.nest_brand_portal_connections;

CREATE TRIGGER nest_lightspeed_oauth_handshake_initial_sync
  AFTER INSERT OR UPDATE OF lightspeed_oauth_handshake_at ON public.nest_brand_portal_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.nest_lightspeed_after_oauth_handshake();
