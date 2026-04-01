-- Ashburton Cycles business portal login (brand_key matches /login dropdown)
INSERT INTO nest_brand_portal_secrets (brand_key, portal_password)
VALUES ('ash', 'ash')
ON CONFLICT (brand_key) DO UPDATE SET
  portal_password = EXCLUDED.portal_password,
  updated_at = now();
