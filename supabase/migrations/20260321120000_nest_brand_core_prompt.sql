-- Full baseline system prompt (migrated from code registry); editable in business portal.
ALTER TABLE nest_brand_chat_config
ADD COLUMN IF NOT EXISTS core_system_prompt text NOT NULL DEFAULT '';

COMMENT ON COLUMN nest_brand_chat_config.core_system_prompt IS 'Full baseline instructions for the brand chatbot. When non-empty, replaces the in-repo registry prompt; portal section fields still append as LIVE BUSINESS CONFIG.';
