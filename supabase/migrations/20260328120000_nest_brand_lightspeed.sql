-- Lightspeed Retail (R-Series) mirrored data for brand portal syncs. Service role only.

-- ── Sync watermarks (incremental sale / workorder pulls) ─────────────────────

CREATE TABLE IF NOT EXISTS public.nest_brand_lightspeed_sync_state (
  brand_key text NOT NULL,
  resource text NOT NULL CHECK (resource IN ('sale', 'workorder')),
  last_time_stamp timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, resource)
);

ALTER TABLE public.nest_brand_lightspeed_sync_state ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_sync_state_updated
  ON public.nest_brand_lightspeed_sync_state (updated_at DESC);

-- ── Sales header ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nest_brand_lightspeed_sale (
  brand_key text NOT NULL,
  sale_id bigint NOT NULL,
  completed boolean,
  voided boolean,
  archived boolean,
  shop_id bigint,
  customer_id bigint,
  employee_id bigint,
  create_time timestamptz,
  complete_time timestamptz,
  time_stamp timestamptz,
  calc_total double precision,
  total double precision,
  balance double precision,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, sale_id)
);

ALTER TABLE public.nest_brand_lightspeed_sale ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_sale_brand_time
  ON public.nest_brand_lightspeed_sale (brand_key, time_stamp DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_sale_brand_complete
  ON public.nest_brand_lightspeed_sale (brand_key, complete_time DESC NULLS LAST);

-- ── Sale lines ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nest_brand_lightspeed_sale_line (
  brand_key text NOT NULL,
  sale_line_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  item_id bigint,
  unit_quantity double precision,
  unit_price double precision,
  calc_line_total double precision,
  note text,
  is_layaway boolean,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, sale_line_id),
  CONSTRAINT fk_nest_brand_lightspeed_sale_line_sale
    FOREIGN KEY (brand_key, sale_id)
    REFERENCES public.nest_brand_lightspeed_sale (brand_key, sale_id)
    ON DELETE CASCADE
);

ALTER TABLE public.nest_brand_lightspeed_sale_line ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_sale_line_sale
  ON public.nest_brand_lightspeed_sale_line (brand_key, sale_id);

-- ── Workorders (full nested tree in payload) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nest_brand_lightspeed_workorder (
  brand_key text NOT NULL,
  workorder_id bigint NOT NULL,
  time_in timestamptz,
  eta_out timestamptz,
  archived boolean,
  warranty boolean,
  workorder_status_id bigint,
  customer_id bigint,
  employee_id bigint,
  shop_id bigint,
  serialized_id bigint,
  sale_id bigint,
  system_sku text,
  time_stamp timestamptz,
  notes text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, workorder_id)
);

ALTER TABLE public.nest_brand_lightspeed_workorder ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_workorder_brand_time
  ON public.nest_brand_lightspeed_workorder (brand_key, time_stamp DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_workorder_brand_time_in
  ON public.nest_brand_lightspeed_workorder (brand_key, time_in DESC NULLS LAST);

-- ── Inventory snapshot (latest synced_at per run wins; stale rows deleted) ──

CREATE TABLE IF NOT EXISTS public.nest_brand_lightspeed_item (
  brand_key text NOT NULL,
  item_id bigint NOT NULL,
  synced_at timestamptz NOT NULL,
  description text,
  custom_sku text,
  upc text,
  ean text,
  archived boolean,
  item_type text,
  category_id bigint,
  manufacturer_id bigint,
  default_cost double precision,
  item_shops jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, item_id)
);

ALTER TABLE public.nest_brand_lightspeed_item ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_lightspeed_item_brand_synced
  ON public.nest_brand_lightspeed_item (brand_key, synced_at DESC);

-- ── pg_cron: inventory full snapshot every 3 hours (UTC) ─────────────────────

SELECT cron.schedule(
  'lightspeed-inventory-cron-3h',
  '0 */3 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/lightspeed-inventory-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
