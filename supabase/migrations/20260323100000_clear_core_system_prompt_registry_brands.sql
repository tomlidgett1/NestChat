-- Ensure standard brands use the in-code registry playbook + portal appendix.
-- Non-empty core_system_prompt replaces the registry baseline; clear it for these keys
-- so Laser Raiders / Ash / IPSec / Ruby keep the full prompts from brand-registry.ts.
UPDATE nest_brand_chat_config
SET
  core_system_prompt = '',
  updated_at = now()
WHERE brand_key IN ('raider', 'ash', 'ipsec', 'ruby')
  AND trim(coalesce(core_system_prompt, '')) <> '';
