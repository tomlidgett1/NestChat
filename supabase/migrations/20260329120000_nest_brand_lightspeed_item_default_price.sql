-- Default retail price from Lightspeed Item.Prices → ItemPrice (useType Default / useTypeID 1).

ALTER TABLE public.nest_brand_lightspeed_item
  ADD COLUMN IF NOT EXISTS default_price double precision;
