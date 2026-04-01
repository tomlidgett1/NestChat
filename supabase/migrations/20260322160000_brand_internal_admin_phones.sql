-- Mobile numbers authorised for internal / operational answers (Deputy, rosters, etc.) vs customer-only mode.

ALTER TABLE nest_brand_chat_config
  ADD COLUMN IF NOT EXISTS internal_admin_phone_e164s text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN nest_brand_chat_config.internal_admin_phone_e164s IS
  'E.164 numbers allowed internal operational answers (rosters, timesheets). Empty = all senders treated as customers for internal data.';
