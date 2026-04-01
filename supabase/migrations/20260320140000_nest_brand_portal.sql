-- Nest business portal: chatbot config + simple password sessions (service role only from APIs / edge functions)

-- Secrets for /login (plain text for MVP; rotate via Supabase dashboard)
CREATE TABLE IF NOT EXISTS nest_brand_portal_secrets (
  brand_key text PRIMARY KEY,
  portal_password text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Editable fields merged into brand system prompts at runtime
CREATE TABLE IF NOT EXISTS nest_brand_chat_config (
  brand_key text PRIMARY KEY,
  business_display_name text NOT NULL DEFAULT '',
  opening_line text NOT NULL DEFAULT '',
  hours_text text NOT NULL DEFAULT '',
  prices_text text NOT NULL DEFAULT '',
  services_products_text text NOT NULL DEFAULT '',
  policies_text text NOT NULL DEFAULT '',
  contact_text text NOT NULL DEFAULT '',
  booking_info_text text NOT NULL DEFAULT '',
  extra_knowledge text NOT NULL DEFAULT '',
  style_template text NOT NULL DEFAULT 'warm_local',
  style_notes text NOT NULL DEFAULT '',
  topics_to_avoid text NOT NULL DEFAULT '',
  escalation_text text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived portal sessions (Bearer token = id)
CREATE TABLE IF NOT EXISTS nest_brand_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nest_brand_portal_sessions_expires ON nest_brand_portal_sessions (expires_at);

ALTER TABLE nest_brand_portal_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nest_brand_chat_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE nest_brand_portal_sessions ENABLE ROW LEVEL SECURITY;

-- Default portal password for Laser Raiders (change in production if needed)
INSERT INTO nest_brand_portal_secrets (brand_key, portal_password)
VALUES ('raider', 'raider')
ON CONFLICT (brand_key) DO NOTHING;

-- Empty config rows so the portal can load known keys (optional convenience)
INSERT INTO nest_brand_chat_config (brand_key)
VALUES ('raider'), ('ash'), ('ipsec'), ('ruby')
ON CONFLICT (brand_key) DO NOTHING;
