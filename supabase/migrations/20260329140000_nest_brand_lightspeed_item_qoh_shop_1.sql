-- Quantity on hand for shop 1 only (from ItemShop rows in item_shops jsonb).

ALTER TABLE public.nest_brand_lightspeed_item
  ADD COLUMN IF NOT EXISTS qoh_shop_1 integer;
