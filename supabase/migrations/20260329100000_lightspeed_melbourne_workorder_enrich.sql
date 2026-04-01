-- Melbourne wall-clock text columns (Australia/Melbourne, honours DST). Canonical timestamptz columns unchanged.
-- Triggers maintain *_melbourne (GENERATED not used: AT TIME ZONE is not immutable).
-- Work order: customer_name + workorder_line_items (enriched at sync from nest_brand_lightspeed_item).

ALTER TABLE public.nest_brand_lightspeed_workorder
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS workorder_line_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.nest_brand_lightspeed_sale
  ADD COLUMN IF NOT EXISTS create_time_melbourne text,
  ADD COLUMN IF NOT EXISTS complete_time_melbourne text,
  ADD COLUMN IF NOT EXISTS time_stamp_melbourne text,
  ADD COLUMN IF NOT EXISTS updated_at_melbourne text;

ALTER TABLE public.nest_brand_lightspeed_sale_line
  ADD COLUMN IF NOT EXISTS updated_at_melbourne text;

ALTER TABLE public.nest_brand_lightspeed_workorder
  ADD COLUMN IF NOT EXISTS time_in_melbourne text,
  ADD COLUMN IF NOT EXISTS eta_out_melbourne text,
  ADD COLUMN IF NOT EXISTS time_stamp_melbourne text,
  ADD COLUMN IF NOT EXISTS updated_at_melbourne text;

ALTER TABLE public.nest_brand_lightspeed_item
  ADD COLUMN IF NOT EXISTS synced_at_melbourne text,
  ADD COLUMN IF NOT EXISTS updated_at_melbourne text;

CREATE OR REPLACE FUNCTION public.nest_brand_lightspeed_sale_set_melbourne()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.create_time_melbourne := CASE WHEN NEW.create_time IS NULL THEN NULL
    ELSE to_char(NEW.create_time AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.complete_time_melbourne := CASE WHEN NEW.complete_time IS NULL THEN NULL
    ELSE to_char(NEW.complete_time AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.time_stamp_melbourne := CASE WHEN NEW.time_stamp IS NULL THEN NULL
    ELSE to_char(NEW.time_stamp AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.updated_at_melbourne := CASE WHEN NEW.updated_at IS NULL THEN NULL
    ELSE to_char(NEW.updated_at AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nest_brand_lightspeed_sale_melbourne_biub ON public.nest_brand_lightspeed_sale;
CREATE TRIGGER nest_brand_lightspeed_sale_melbourne_biub
  BEFORE INSERT OR UPDATE ON public.nest_brand_lightspeed_sale
  FOR EACH ROW EXECUTE FUNCTION public.nest_brand_lightspeed_sale_set_melbourne();

CREATE OR REPLACE FUNCTION public.nest_brand_lightspeed_sale_line_set_melbourne()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at_melbourne := CASE WHEN NEW.updated_at IS NULL THEN NULL
    ELSE to_char(NEW.updated_at AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nest_brand_lightspeed_sale_line_melbourne_biub ON public.nest_brand_lightspeed_sale_line;
CREATE TRIGGER nest_brand_lightspeed_sale_line_melbourne_biub
  BEFORE INSERT OR UPDATE ON public.nest_brand_lightspeed_sale_line
  FOR EACH ROW EXECUTE FUNCTION public.nest_brand_lightspeed_sale_line_set_melbourne();

CREATE OR REPLACE FUNCTION public.nest_brand_lightspeed_workorder_set_melbourne()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.time_in_melbourne := CASE WHEN NEW.time_in IS NULL THEN NULL
    ELSE to_char(NEW.time_in AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.eta_out_melbourne := CASE WHEN NEW.eta_out IS NULL THEN NULL
    ELSE to_char(NEW.eta_out AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.time_stamp_melbourne := CASE WHEN NEW.time_stamp IS NULL THEN NULL
    ELSE to_char(NEW.time_stamp AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.updated_at_melbourne := CASE WHEN NEW.updated_at IS NULL THEN NULL
    ELSE to_char(NEW.updated_at AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nest_brand_lightspeed_workorder_melbourne_biub ON public.nest_brand_lightspeed_workorder;
CREATE TRIGGER nest_brand_lightspeed_workorder_melbourne_biub
  BEFORE INSERT OR UPDATE ON public.nest_brand_lightspeed_workorder
  FOR EACH ROW EXECUTE FUNCTION public.nest_brand_lightspeed_workorder_set_melbourne();

CREATE OR REPLACE FUNCTION public.nest_brand_lightspeed_item_set_melbourne()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.synced_at_melbourne := CASE WHEN NEW.synced_at IS NULL THEN NULL
    ELSE to_char(NEW.synced_at AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  NEW.updated_at_melbourne := CASE WHEN NEW.updated_at IS NULL THEN NULL
    ELSE to_char(NEW.updated_at AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS') END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nest_brand_lightspeed_item_melbourne_biub ON public.nest_brand_lightspeed_item;
CREATE TRIGGER nest_brand_lightspeed_item_melbourne_biub
  BEFORE INSERT OR UPDATE ON public.nest_brand_lightspeed_item
  FOR EACH ROW EXECUTE FUNCTION public.nest_brand_lightspeed_item_set_melbourne();

UPDATE public.nest_brand_lightspeed_sale SET brand_key = brand_key WHERE true;
UPDATE public.nest_brand_lightspeed_sale_line SET brand_key = brand_key WHERE true;
UPDATE public.nest_brand_lightspeed_workorder SET brand_key = brand_key WHERE true;
UPDATE public.nest_brand_lightspeed_item SET brand_key = brand_key WHERE true;
