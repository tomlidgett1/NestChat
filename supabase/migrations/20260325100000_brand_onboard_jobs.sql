-- Brand onboarding job queue: tracks website scraping + prompt generation progress

CREATE TABLE IF NOT EXISTS nest_brand_onboard_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL,
  business_name text NOT NULL,
  website_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  pages_found int NOT NULL DEFAULT 0,
  pages_scraped int NOT NULL DEFAULT 0,
  scraped_content text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nest_brand_onboard_jobs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_nest_brand_onboard_jobs_brand ON nest_brand_onboard_jobs (brand_key);
CREATE INDEX IF NOT EXISTS idx_nest_brand_onboard_jobs_status ON nest_brand_onboard_jobs (status);
