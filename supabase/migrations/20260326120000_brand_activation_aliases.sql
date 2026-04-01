-- Extra "Hey <word>" triggers beyond the canonical brand_key (single token, lowercase in storage).

ALTER TABLE nest_brand_chat_config
ADD COLUMN IF NOT EXISTS activation_aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN nest_brand_chat_config.activation_aliases IS
  'Additional activation words for parseHeyBrand (lowercase). Primary trigger is always brand_key.';

CREATE INDEX IF NOT EXISTS idx_nest_brand_chat_config_activation_aliases
  ON nest_brand_chat_config USING GIN (activation_aliases);
