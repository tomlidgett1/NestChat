-- Queued Deputy roster mutations awaiting explicit CONFIRM ADD / CONFIRM DELETE in brand chat.

CREATE TABLE IF NOT EXISTS nest_brand_deputy_pending_actions (
  chat_id text PRIMARY KEY,
  brand_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('roster_discard', 'roster_add')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nest_brand_deputy_pending_expires ON nest_brand_deputy_pending_actions (expires_at);

ALTER TABLE nest_brand_deputy_pending_actions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE nest_brand_deputy_pending_actions IS
  'Service-role only: pending Deputy roster add/discard until user sends CONFIRM ADD / CONFIRM DELETE.';
