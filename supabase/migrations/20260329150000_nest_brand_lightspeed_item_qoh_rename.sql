-- Single column for shop 1 QOH: rename qoh_shop_1 → qoh

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nest_brand_lightspeed_item'
      AND column_name = 'qoh_shop_1'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nest_brand_lightspeed_item'
      AND column_name = 'qoh'
  ) THEN
    ALTER TABLE public.nest_brand_lightspeed_item RENAME COLUMN qoh_shop_1 TO qoh;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nest_brand_lightspeed_item'
      AND column_name = 'qoh'
  ) THEN
    ALTER TABLE public.nest_brand_lightspeed_item ADD COLUMN qoh integer;
  END IF;
END $$;
