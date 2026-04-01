-- ============================================================================
-- Seed existing hardcoded automation rules as system moments
--
-- These correspond to the 7 rules in _shared/automations.ts:
--   1. onboarding_morning  (Day 2 Morning)
--   2. onboarding_feature  (Day 3 Feature Discovery)
--   3. morning_briefing    (Morning Briefing)
--   4. calendar_heads_up   (Calendar Heads-Up)
--   5. feature_discovery   (Feature Discovery Tips)
--   6. inactivity_reengagement (Inactivity Re-engagement)
--   7. follow_up_loop      (Follow-Up Loop Closer)
-- ============================================================================

-- 1. Day 2 Morning — morning greeting or briefing on Day 2 after sign-up
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template, prompt_system_context,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Day 2 Morning',
  'Morning greeting or briefing on Day 2 after sign-up at 8:15am local',
  'active',
  'relative_time',
  '{"reference": "first_seen", "reference_is_epoch": true, "delay_hours": 24, "window_hours": 24}'::jsonb,
  '{"mode": "all_active", "min_days_since_signup": 0}'::jsonb,
  'send_message',
  E'Generate a morning briefing or warm greeting for {{user.first_name}}. This is their FIRST morning message from you (Day 2 after signing up), so make it extra warm and welcoming.\n\nToday''s calendar:\n{{context.calendar_today}}\n\nUnread emails:\n{{context.unread_emails}}\n\nRules:\n- Start with a warm, welcoming morning greeting using their name\n- If calendar/email data is available, summarise the day naturally\n- If no data, send a warm greeting and offer to send daily check-ins\n- 2-4 lines max, split into max 2 bubbles with ---\n- Australian spelling',
  null,
  20, 1, 1, 10,
  8, 9,
  '{"onboarding", "lifecycle"}',
  true, 'system'
);

-- 2. Day 3 Feature Discovery — contextual reminders tip
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Day 3 Reminders Tip',
  'Contextual reminders feature discovery on Day 3 (only if user responded on Day 2)',
  'active',
  'relative_time',
  '{"reference": "first_seen", "reference_is_epoch": true, "delay_hours": 48, "window_hours": 24}'::jsonb,
  '{"mode": "all_active", "min_days_since_signup": 0}'::jsonb,
  'send_message',
  E'Generate a warm feature discovery message about REMINDERS for {{user.first_name}}. This is Day 3 after they signed up.\n\nWhat you know about them:\n{{context.memories}}\n\nOpen topics from conversations:\n{{context.open_loops}}\n\nRules:\n- Start with a warm greeting using their name\n- Frame it like a friend sharing a genuinely useful tip, not a product tutorial\n- Personalise using what you know about them\n- Give ONE specific example they could text right now\n- 2-3 lines max\n- End with something encouraging but not a question\n- Australian spelling',
  20, 1, 1, 15,
  8, 9,
  '{"onboarding", "lifecycle", "feature_discovery"}',
  true, 'system'
);

-- 3. Morning Briefing — daily morning summary
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Morning Briefing',
  'Daily morning summary of calendar, emails, and key info',
  'active',
  'scheduled',
  '{"cron": "0 7,8 * * *"}'::jsonb,
  '{"mode": "filter", "require_connected_accounts": true, "min_days_since_signup": 3, "filters": [{"column": "onboard_count", "op": "gte", "value": 2}]}'::jsonb,
  'send_message',
  E'Generate a morning briefing text message for {{user.first_name}}.\n\nToday''s calendar:\n{{context.calendar_today}}\n\nUnread emails:\n{{context.unread_emails}}\n\nRules:\n- Start with a warm, varied morning greeting using their name\n- Summarise the day naturally — mention specific events, times, and key people\n- Only mention emails if genuinely interesting\n- If no events: warmly note it''s a quiet day\n- 2-4 lines max, split into max 2 bubbles with ---\n- Australian spelling',
  20, 1, null, 20,
  7, 9,
  '{"daily", "engagement"}',
  true, 'system'
);

-- 4. Calendar Heads-Up — upcoming event notification
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Calendar Heads-Up',
  'Sends a heads-up 30-60 min before calendar events',
  'active',
  'scheduled',
  '{"cron": "0 7-20 * * *"}'::jsonb,
  '{"mode": "filter", "require_connected_accounts": true, "min_days_since_signup": 3, "filters": [{"column": "onboard_count", "op": "gte", "value": 3}]}'::jsonb,
  'send_message',
  E'Generate a friendly calendar heads-up text for {{user.first_name}}.\n\nToday''s calendar:\n{{context.calendar_today}}\n\nRules:\n- 1-2 lines max\n- Start with a gentle, kind heads-up\n- Mention the event name, roughly how long until it starts, and location if known\n- If there''s a location, offer to check travel time\n- Australian spelling',
  1, 1, null, 5,
  7, 21,
  '{"daily", "calendar", "time_sensitive"}',
  true, 'system'
);

-- 5. Feature Discovery Tips — progressive feature tips on Day 7, 14
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Feature Discovery Tips',
  'Progressive feature discovery on Day 7 and Day 14',
  'active',
  'relative_time',
  '{"reference": "first_seen", "reference_is_epoch": true, "delay_hours": 168, "window_hours": 168}'::jsonb,
  '{"mode": "all_active", "min_days_since_signup": 7}'::jsonb,
  'send_message',
  E'Generate a warm, personalised feature discovery message for {{user.first_name}} about a feature they haven''t used yet.\n\nWhat you know about them:\n{{context.memories}}\n\nRules:\n- Start with a warm greeting that feels natural\n- Frame it like a friend sharing a helpful tip\n- Personalise using what you know about them\n- Give ONE specific example they could try right now\n- 2-3 lines max\n- Australian spelling',
  48, 1, 2, 70,
  9, 19,
  '{"lifecycle", "feature_discovery"}',
  true, 'system'
);

-- 6. Inactivity Re-engagement — graduated nudges for inactive users
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Inactivity Re-engagement',
  'Graduated re-engagement for inactive users (3, 5, 7 day tiers)',
  'active',
  'inactivity',
  '{"reference": "last_seen", "reference_is_epoch": true, "threshold_hours": 72}'::jsonb,
  '{"mode": "filter", "min_days_since_signup": 3, "filters": [{"column": "onboard_count", "op": "gte", "value": 2}]}'::jsonb,
  'send_message',
  E'Generate a warm re-engagement text for {{user.first_name}} who hasn''t messaged in a while.\n\nWhat you know about them:\n{{context.memories}}\n\nToday''s calendar:\n{{context.calendar_today}}\n\nRules:\n- 1-2 lines max\n- Sound like a kind friend who genuinely cares, not a notification system\n- Reference specific things from their life to show thoughtfulness\n- Never sound desperate, clingy, or like marketing\n- Australian spelling',
  36, 1, 3, 60,
  9, 19,
  '{"retention", "reengagement"}',
  true, 'system'
);

-- 7. Follow-Up Loop Closer — follows up on open loops from conversations
insert into public.moments (
  name, description, status, trigger_type, trigger_config, audience_config,
  action_type, prompt_template,
  cooldown_hours, max_per_day_per_user, max_per_user_total, priority,
  window_start_hour, window_end_hour, tags, is_system, created_by
) values (
  'Follow-Up Loop Closer',
  'Follows up on open loops from conversations when user has been away 24-72h',
  'active',
  'inactivity',
  '{"reference": "last_seen", "reference_is_epoch": true, "threshold_hours": 24}'::jsonb,
  '{"mode": "filter", "min_days_since_signup": 3, "filters": [{"column": "onboard_count", "op": "gte", "value": 5}]}'::jsonb,
  'send_message',
  E'Generate a thoughtful follow-up text for {{user.first_name}} based on things they mentioned previously.\n\nOpen loops from recent conversations:\n{{context.open_loops}}\n\nWhat you know about them:\n{{context.memories}}\n\nRules:\n- Pick the MOST actionable or timely open loop\n- 1-2 lines max\n- Show you genuinely remembered and care\n- Reference the specific thing naturally, like a friend who was thinking of them\n- Gently offer to help with the next step\n- Australian spelling',
  24, 1, null, 50,
  10, 18,
  '{"engagement", "follow_up"}',
  true, 'system'
);
