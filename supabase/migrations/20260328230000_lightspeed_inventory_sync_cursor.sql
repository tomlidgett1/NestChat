-- Chunked Lightspeed inventory sync: store pagination cursor so each Edge invocation can finish within HTTP limits.

ALTER TABLE public.nest_brand_lightspeed_sync_state
  DROP CONSTRAINT IF EXISTS nest_brand_lightspeed_sync_state_resource_check;

ALTER TABLE public.nest_brand_lightspeed_sync_state
  ADD CONSTRAINT nest_brand_lightspeed_sync_state_resource_check
  CHECK (resource IN ('sale', 'workorder', 'item'));

ALTER TABLE public.nest_brand_lightspeed_sync_state
  ADD COLUMN IF NOT EXISTS inventory_run_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_next_page_url text,
  ADD COLUMN IF NOT EXISTS inventory_last_completed_at timestamptz;
