-- The handshake trigger used current_setting('app.settings.supabase_url') without missing_ok.
-- Those settings are not defined in-repo; when unset, PostgreSQL aborted the INSERT/UPDATE and
-- the portal saw save_failed. Initial sync is handled from Vercel (waitUntil + Edge Functions).

DROP TRIGGER IF EXISTS nest_lightspeed_oauth_handshake_initial_sync ON public.nest_brand_portal_connections;

DROP FUNCTION IF EXISTS public.nest_lightspeed_after_oauth_handshake();
