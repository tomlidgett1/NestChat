-- Third-party connections for the business portal (Deputy, etc.). Accessed only via service role from Vercel APIs.

CREATE TABLE IF NOT EXISTS nest_brand_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL,
  provider text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nest_brand_oauth_states_expires ON nest_brand_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS nest_brand_portal_connections (
  brand_key text NOT NULL,
  provider text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  api_endpoint text NOT NULL,
  access_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, provider)
);

ALTER TABLE nest_brand_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE nest_brand_portal_connections ENABLE ROW LEVEL SECURITY;
