-- IPSec business portal login password
INSERT INTO nest_brand_portal_secrets (brand_key, portal_password)
VALUES ('ipsec', 'ash')
ON CONFLICT (brand_key) DO UPDATE SET
  portal_password = EXCLUDED.portal_password,
  updated_at = now();
