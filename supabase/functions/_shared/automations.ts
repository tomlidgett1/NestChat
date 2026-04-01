import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import {
  getActiveMemoryItems,
  getConversationSummaries,
  getConnectedAccounts,
  emitOnboardingEvent,
} from './state.ts';
import { getAdminClient } from './supabase.ts';
import { USER_PROFILES_TABLE } from './env.ts';
import { liveCalendarLookup } from './calendar-helpers.ts';
import { gmailSearchTool } from './gmail-helpers.ts';

const client = getOpenAIClient();

// ============================================================================
// Types
// ============================================================================

export interface AutomationUser {
  handle: string;
  name: string | null;
  onboardState: string;
  entryState: string | null;
  firstValueWedge: string | null;
  firstValueDeliveredAt: string | null;
  followThroughDeliveredAt: string | null;
  secondEngagementAt: string | null;
  memoryMomentDeliveredAt: string | null;
  activatedAt: string | null;
  atRiskAt: string | null;
  lastProactiveSentAt: string | null;
  lastProactiveIgnored: boolean;
  proactiveIgnoreCount: number;
  activationScore: number;
  capabilityCategoriesUsed: string[];
  botNumber: string | null;
  firstSeen: number;
  lastSeen: number;
  onboardCount: number;
  timezone: string | null;
  authUserId: string | null;
  status: string;
  deepProfileSnapshot: Record<string, unknown> | null;
}

export interface AutomationAction {
  type: string;  // automation_type (e.g. 'morning_briefing')
  message: string;
  metadata: Record<string, unknown>;
}

export interface AutomationHold {
  type: 'hold';
  reason: string;
}

export interface AutomationSkip {
  type: 'skip';
  reason: string;
}

export type AutomationResult = AutomationAction | AutomationHold | AutomationSkip;

// ============================================================================
// Automation Registry — add new types here
// ============================================================================

export interface AutomationRule {
  type: string;
  name: string;
  description: string;
  /** Check if this user is eligible for this automation RIGHT NOW */
  evaluate: (user: AutomationUser, ctx: EvalContext) => Promise<AutomationResult>;
  /** Max sends per 24h for this type */
  maxPerDay: number;
  /** Minimum hours between sends of this type */
  minIntervalHours: number;
  /** Does this require connected accounts (calendar/email)? */
  requiresConnectedAccounts: boolean;
}

export interface EvalContext {
  nowEpoch: number;
  userLocalHour: number;
  userLocalDay: number; // 0=Sun, 6=Sat
  hoursSinceLastSeen: number;
  daysSinceFirstSeen: number;
  lastAutomationOfType: string | null; // ISO timestamp
  automationsToday: number;
  preferences: { enabled: boolean; scheduleOverride?: Record<string, unknown> } | null;
  hasConnectedAccounts: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/** Compute calendar days since a given epoch timestamp, in the user's timezone */
function getCalendarDaysSince(epochSeconds: number, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
    const firstLocal = fmt.format(new Date(epochSeconds * 1000));
    const nowLocal = fmt.format(new Date());
    const d1 = new Date(firstLocal + 'T00:00:00');
    const d2 = new Date(nowLocal + 'T00:00:00');
    return Math.round((d2.getTime() - d1.getTime()) / 86400000);
  } catch {
    return Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  }
}

// ============================================================================
// Onboarding rules — Day 2 and Day 3 only
// ============================================================================

const onboardingMorningRule: AutomationRule = {
  type: 'onboarding_morning',
  name: 'Day 2 Morning',
  description: 'Morning greeting or briefing on Day 2 after sign-up at 8:15am local',
  maxPerDay: 1,
  minIntervalHours: 20,
  requiresConnectedAccounts: false,

  async evaluate(user, ctx) {
    const tz = user.timezone || 'Australia/Sydney';
    const calendarDays = getCalendarDaysSince(user.firstSeen, tz);

    if (calendarDays !== 1) {
      return { type: 'skip', reason: calendarDays < 1 ? 'still_day_1' : 'past_day_2' };
    }

    // Target 8:15am local — fire in the 8am-9am window
    if (ctx.userLocalHour < 8 || ctx.userLocalHour >= 9) {
      return { type: 'skip', reason: 'outside_8am_window' };
    }

    // Already sent?
    if (ctx.lastAutomationOfType) {
      return { type: 'skip', reason: 'already_sent_day2' };
    }

    if (ctx.hasConnectedAccounts) {
      // Verified user: send full morning briefing
      const message = await generateMorningBriefing(user);
      if (message) {
        return {
          type: 'onboarding_morning',
          message,
          metadata: { trigger: 'onboarding_day2', verified: true, calendar_day: calendarDays },
        };
      }
    }

    // Not verified or briefing failed: warm greeting
    const message = generateOnboardingGreeting(user);
    return {
      type: 'onboarding_morning',
      message,
      metadata: { trigger: 'onboarding_day2', verified: false, calendar_day: calendarDays },
    };
  },
};

const onboardingFeatureRule: AutomationRule = {
  type: 'onboarding_feature',
  name: 'Day 3 Feature Discovery',
  description: 'Contextual reminders tip on Day 3 (only if user responded on Day 2)',
  maxPerDay: 1,
  minIntervalHours: 20,
  requiresConnectedAccounts: false,

  async evaluate(user, ctx) {
    const tz = user.timezone || 'Australia/Sydney';
    const calendarDays = getCalendarDaysSince(user.firstSeen, tz);

    if (calendarDays !== 2) {
      return { type: 'skip', reason: calendarDays < 2 ? 'not_day_3_yet' : 'past_day_3' };
    }

    // Target 8:15am local
    if (ctx.userLocalHour < 8 || ctx.userLocalHour >= 9) {
      return { type: 'skip', reason: 'outside_8am_window' };
    }

    // Already sent?
    if (ctx.lastAutomationOfType) {
      return { type: 'skip', reason: 'already_sent_day3' };
    }

    // Check if Day 2 morning was sent and user responded
    const supabase = getAdminClient();
    const { data: day2Run } = await supabase
      .from('automation_runs')
      .select('sent_at, replied_at')
      .eq('handle', user.handle)
      .eq('automation_type', 'onboarding_morning')
      .order('sent_at', { ascending: false })
      .limit(1);

    if (!day2Run?.length) {
      return { type: 'skip', reason: 'day2_not_sent' };
    }

    // Did user send any message after the Day 2 automation?
    const day2SentEpoch = new Date((day2Run[0] as Record<string, unknown>).sent_at as string).getTime() / 1000;
    if (user.lastSeen <= day2SentEpoch) {
      return { type: 'skip', reason: 'no_response_to_day2' };
    }

    // Generate contextual feature discovery about reminders
    const message = await generateOnboardingFeatureDiscovery(user);
    if (!message) {
      return { type: 'skip', reason: 'generation_failed' };
    }

    return {
      type: 'onboarding_feature',
      message,
      metadata: { trigger: 'onboarding_day3', feature: 'reminders', calendar_day: calendarDays },
    };
  },
};

// ============================================================================
// Rule implementations
// ============================================================================

const morningBriefingRule: AutomationRule = {
  type: 'morning_briefing',
  name: 'Morning Briefing',
  description: 'Daily morning summary of calendar, emails, and key info',
  maxPerDay: 1,
  minIntervalHours: 20,
  requiresConnectedAccounts: true,

  async evaluate(user, ctx) {
    // Only send between 7-9am local time
    const preferredHour = (ctx.preferences?.scheduleOverride as Record<string, number> | undefined)?.hour ?? 7;
    if (ctx.userLocalHour < preferredHour || ctx.userLocalHour >= preferredHour + 2) {
      return { type: 'skip', reason: 'outside_morning_window' };
    }

    // Must have connected accounts
    if (!ctx.hasConnectedAccounts) {
      return { type: 'skip', reason: 'no_connected_accounts' };
    }

    // Already sent today?
    if (ctx.lastAutomationOfType) {
      const lastSent = new Date(ctx.lastAutomationOfType);
      const hoursSince = (Date.now() - lastSent.getTime()) / 3600000;
      if (hoursSince < 20) {
        return { type: 'skip', reason: 'already_sent_today' };
      }
    }

    // Must have been active at least once (not brand new)
    if (user.onboardCount < 2) {
      return { type: 'skip', reason: 'too_new' };
    }

    // Generate the briefing
    const message = await generateMorningBriefing(user);
    if (!message) {
      return { type: 'skip', reason: 'generation_returned_empty' };
    }

    return {
      type: 'morning_briefing',
      message,
      metadata: { trigger: 'scheduled', localHour: ctx.userLocalHour },
    };
  },
};

const calendarHeadsUpRule: AutomationRule = {
  type: 'calendar_heads_up',
  name: 'Calendar Heads-Up',
  description: 'Sends a heads-up 30-60 min before calendar events',
  maxPerDay: 1,
  minIntervalHours: 1,
  requiresConnectedAccounts: true,

  async evaluate(user, ctx) {
    if (!ctx.hasConnectedAccounts || !user.authUserId) {
      return { type: 'skip', reason: 'no_connected_accounts' };
    }

    // Only during waking hours
    if (ctx.userLocalHour < 7 || ctx.userLocalHour >= 21) {
      return { type: 'skip', reason: 'outside_waking_hours' };
    }

    // Must have sent at least 3 messages (not totally new)
    if (user.onboardCount < 3) {
      return { type: 'skip', reason: 'too_new' };
    }

    const tz = user.timezone || 'Australia/Sydney';
    const leadMinutes = (ctx.preferences?.scheduleOverride as Record<string, number> | undefined)?.lead_minutes ?? 45;

    try {
      const result = await liveCalendarLookup(user.authUserId, 'next 2 hours', tz, undefined, undefined, 5);
      if (!result.events || result.events.length === 0) {
        return { type: 'skip', reason: 'no_upcoming_events' };
      }

      // Find events starting in 30-75 minutes
      const now = Date.now();
      const candidateEvents = result.events.filter((e: Record<string, unknown>) => {
        if (e.all_day) return false;
        const startTime = new Date(e.start as string).getTime();
        const minutesUntil = (startTime - now) / 60000;
        return minutesUntil >= 25 && minutesUntil <= 75;
      });

      if (candidateEvents.length === 0) {
        return { type: 'skip', reason: 'no_events_in_window' };
      }

      const event = candidateEvents[0] as Record<string, unknown>;
      const message = await generateCalendarHeadsUp(user, event);
      if (!message) {
        return { type: 'skip', reason: 'generation_returned_empty' };
      }

      return {
        type: 'calendar_heads_up',
        message,
        metadata: {
          trigger: 'upcoming_event',
          event_title: event.title,
          event_start: event.start,
          event_location: event.location || null,
          lead_minutes: leadMinutes,
        },
      };
    } catch (err) {
      console.error(`[automations] Calendar lookup failed for ${user.handle}:`, (err as Error).message);
      return { type: 'skip', reason: 'calendar_lookup_failed' };
    }
  },
};

const featureDiscoveryRule: AutomationRule = {
  type: 'feature_discovery',
  name: 'Feature Discovery Tips',
  description: 'Progressive feature discovery on Day 3, 7, 14',
  maxPerDay: 1,
  minIntervalHours: 48,
  requiresConnectedAccounts: false,

  async evaluate(user, ctx) {
    // Only during reasonable hours
    if (ctx.userLocalHour < 9 || ctx.userLocalHour >= 19) {
      return { type: 'skip', reason: 'outside_tip_hours' };
    }

    const daysSinceJoin = ctx.daysSinceFirstSeen;
    const usedCapabilities = user.capabilityCategoriesUsed || [];

    // Determine which tip to send based on days since join
    let tipDay: number | null = null;
    let tipType: string | null = null;

    // Day 3 is handled by onboarding_feature rule
    if (daysSinceJoin >= 7 && daysSinceJoin < 9) tipDay = 7;
    else if (daysSinceJoin >= 14 && daysSinceJoin < 16) tipDay = 14;

    if (!tipDay) {
      return { type: 'skip', reason: 'not_tip_day' };
    }

    // Check if we already sent this specific tip day
    const supabase = getAdminClient();
    const { data: existingRun } = await supabase
      .from('automation_runs')
      .select('id')
      .eq('handle', user.handle)
      .eq('automation_type', 'feature_discovery')
      .contains('metadata', { tip_day: tipDay })
      .limit(1);

    if (existingRun && existingRun.length > 0) {
      return { type: 'skip', reason: `tip_day_${tipDay}_already_sent` };
    }

    // Pick a feature they haven't used yet
    const allFeatures = ['reminders', 'email', 'calendar', 'drafting', 'web_search', 'image_generation', 'travel_time', 'places'];
    const unusedFeatures = allFeatures.filter(f => !usedCapabilities.includes(f));

    if (unusedFeatures.length === 0) {
      return { type: 'skip', reason: 'all_features_discovered' };
    }

    tipType = unusedFeatures[0];
    const message = generateFeatureDiscoveryTip(user, tipType, tipDay);

    return {
      type: 'feature_discovery',
      message,
      metadata: { tip_day: tipDay, feature: tipType, unused_features: unusedFeatures },
    };
  },
};

const inactivityReengagementRule: AutomationRule = {
  type: 'inactivity_reengagement',
  name: 'Inactivity Re-engagement',
  description: 'Graduated re-engagement for inactive users (Day 3, 5, 7)',
  maxPerDay: 1,
  minIntervalHours: 36,
  requiresConnectedAccounts: false,

  async evaluate(user, ctx) {
    // Only during reasonable hours
    if (ctx.userLocalHour < 9 || ctx.userLocalHour >= 19) {
      return { type: 'skip', reason: 'outside_reengagement_hours' };
    }

    const daysSilent = ctx.hoursSinceLastSeen / 24;

    // Must have actually used the product before (not a cold user)
    if (user.onboardCount < 2) {
      return { type: 'skip', reason: 'never_engaged' };
    }

    // Determine which tier of re-engagement
    let tier: 'soft' | 'value' | 'direct' | null = null;

    if (daysSilent >= 3 && daysSilent < 4) tier = 'soft';
    else if (daysSilent >= 5 && daysSilent < 6) tier = 'value';
    else if (daysSilent >= 7 && daysSilent < 8) tier = 'direct';

    if (!tier) {
      return { type: 'skip', reason: 'not_inactivity_day' };
    }

    // Check if we already sent this tier
    const supabase = getAdminClient();
    const { data: existingRun } = await supabase
      .from('automation_runs')
      .select('id')
      .eq('handle', user.handle)
      .eq('automation_type', 'inactivity_reengagement')
      .contains('metadata', { tier })
      .limit(1);

    if (existingRun && existingRun.length > 0) {
      return { type: 'skip', reason: `inactivity_${tier}_already_sent` };
    }

    const message = await generateInactivityMessage(user, tier);

    return {
      type: 'inactivity_reengagement',
      message,
      metadata: {
        tier,
        days_silent: Math.round(daysSilent * 10) / 10,
        last_seen_epoch: user.lastSeen,
      },
    };
  },
};

const followUpLoopRule: AutomationRule = {
  type: 'follow_up_loop',
  name: 'Follow-Up Loop Closer',
  description: 'Follows up on open loops from conversations',
  maxPerDay: 1,
  minIntervalHours: 24,
  requiresConnectedAccounts: false,

  async evaluate(user, ctx) {
    // Only during reasonable hours
    if (ctx.userLocalHour < 10 || ctx.userLocalHour >= 18) {
      return { type: 'skip', reason: 'outside_follow_up_hours' };
    }

    // Must have real conversation history
    if (user.onboardCount < 5) {
      return { type: 'skip', reason: 'not_enough_history' };
    }

    // Only if 24-72h since last seen (they've been away but not too long)
    if (ctx.hoursSinceLastSeen < 24 || ctx.hoursSinceLastSeen > 72) {
      return { type: 'skip', reason: 'timing_not_right' };
    }

    // Check conversation summaries for open loops
    const chatId = `DM#${user.botNumber}#${user.handle}`;
    const summaries = await getConversationSummaries(chatId, 5);

    const openLoops = summaries
      .filter(s => s.openLoops && s.openLoops.length > 0)
      .flatMap(s => s.openLoops);

    if (openLoops.length === 0) {
      return { type: 'skip', reason: 'no_open_loops' };
    }

    const message = await generateFollowUpMessage(user, openLoops);
    if (!message) {
      return { type: 'skip', reason: 'generation_returned_empty' };
    }

    return {
      type: 'follow_up_loop',
      message,
      metadata: { open_loops: openLoops.slice(0, 5) },
    };
  },
};

// ============================================================================
// The registry — ordered by priority
// ============================================================================

export const AUTOMATION_RULES: AutomationRule[] = [
  // Onboarding (Day 2-3 only — filtered by evaluator)
  onboardingMorningRule,       // Day 2: morning greeting/briefing
  onboardingFeatureRule,       // Day 3: contextual reminders tip
  // Regular (Day 4+ only — filtered by evaluator)
  calendarHeadsUpRule,         // Highest priority — time-sensitive
  morningBriefingRule,         // Daily anchor
  followUpLoopRule,            // Contextual value
  inactivityReengagementRule,  // Re-engagement
  featureDiscoveryRule,        // Education
];

// ============================================================================
// Message generators
// ============================================================================

async function generateMorningBriefing(user: AutomationUser): Promise<string | null> {
  if (!user.authUserId) return null;

  const tz = user.timezone || 'Australia/Sydney';
  const name = user.name ? user.name.split(' ')[0] : '';

  // Fetch calendar and email in parallel
  const [calResult, emailResult] = await Promise.allSettled([
    liveCalendarLookup(user.authUserId, 'today', tz, undefined, undefined, 10),
    gmailSearchTool(user.authUserId, { query: 'is:unread newer_than:1d', max_results: 5, time_zone: tz }),
  ]);

  let calendarBlock = '';
  let emailBlock = '';

  if (calResult.status === 'fulfilled' && calResult.value.events?.length > 0) {
    calendarBlock = calResult.value.events.map((e: Record<string, unknown>) => {
      const time = e.all_day ? 'all day' : e.start;
      const loc = e.location ? ` @ ${e.location}` : '';
      return `- ${e.title} (${time}${loc})`;
    }).join('\n');
  }

  if (emailResult.status === 'fulfilled') {
    const emailData = emailResult.value as { results?: Array<{ from: string; subject: string }> };
    if (emailData.results?.length) {
      emailBlock = emailData.results.map(e => `- ${e.from}: ${e.subject}`).join('\n');
    }
  }

  if (!calendarBlock && !emailBlock) return null;

  try {
    const dayOfWeek = new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz });
    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are Nest, a warm and thoughtful personal assistant texting someone their morning briefing via iMessage. You write like a kind, emotionally intelligent friend — not a corporate bot or overly casual slang. Use proper capitalisation and punctuation.

ABSOLUTELY FORBIDDEN: em dash character (use a hyphen instead), the word "mate", markdown formatting (no bold, bullets, headers).

The user's name: ${name || 'unknown'}
Day: ${dayOfWeek}

Today's calendar:
${calendarBlock || 'No events today'}

Unread emails:
${emailBlock || 'No unread emails'}

RULES:
- 2-4 lines max. This is a text, not a newsletter.
- Start with a warm, varied morning greeting using their name. Examples: "Good morning ${name || 'there'}! Hope you slept well.", "Happy ${dayOfWeek} ${name || 'there'}!", "Morning ${name || 'there'}, hope you're feeling good today." — but create your own, don't copy these.
- Summarise the calendar conversationally — mention specific events, times, and people by first name where possible
- If it's a busy day, acknowledge that warmly ("Looks like a full day ahead!")
- Mention notable emails only if genuinely interesting (from family, personal, urgent)
- Use --- to separate into max 2 bubbles
- Australian spelling.`,
      input: 'Generate the morning briefing.',
      max_output_tokens: 300,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text?.trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch (err) {
    console.error('[automations] Morning briefing generation failed:', (err as Error).message);
    return null;
  }
}

async function generateCalendarHeadsUp(user: AutomationUser, event: Record<string, unknown>): Promise<string | null> {
  const name = user.name ? user.name.split(' ')[0] : '';
  const title = event.title as string;
  const start = event.start as string;
  const location = event.location as string | undefined;

  const startDate = new Date(start);
  const minutesUntil = Math.round((startDate.getTime() - Date.now()) / 60000);

  let locationLine = '';
  if (location) {
    locationLine = `Location: ${location}`;
  }

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, a warm and thoughtful personal assistant sending a calendar heads-up via iMessage. Write like a kind, emotionally intelligent friend. Use proper capitalisation and punctuation.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}
Event: ${title}
Starts in: ${minutesUntil} minutes
${locationLine}
Attendees: ${(event.attendees as string[] || []).join(', ') || 'none listed'}

RULES:
- 1-2 lines max.
- Start with a gentle, friendly heads-up. Vary your opening each time.
- Mention the event name, roughly how long until it starts, and location if known.
- If there's a location, warmly offer to check travel time or directions.
- Reference attendees by first name if possible.
- Australian spelling.

EXAMPLES (don't copy exactly, create your own):
- "Just a heads up Tom - your dentist appointment is in about 45 minutes at 123 Smith St. Want me to check how long it'll take to get there?"
- "Hey Tom, you've got team standup coming up in half an hour. Hope it goes smoothly!"`,
      input: 'Generate the calendar heads-up message.',
      max_output_tokens: 100,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text?.trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch (err) {
    console.error('[automations] Calendar heads-up generation failed:', (err as Error).message);
    // Fallback
    const namePart = name ? `${name}, ` : '';
    return `Heads up ${namePart}${title} in ${minutesUntil} min${location ? ` at ${location}` : ''}`;
  }
}

function generateFeatureDiscoveryTip(user: AutomationUser, feature: string, tipDay: number): string {
  const name = user.name ? user.name.split(' ')[0] : '';
  const greeting = name ? `Hey ${name}` : 'Hey there';

  const tips: Record<string, string> = {
    reminders: `${greeting}, by the way - you can ask me to set reminders for anything. Just text something like "Remind me to call the doctor tomorrow at 10am" and I'll make sure you don't forget. Works for recurring things too!`,
    email: `${greeting}, did you know I can check your emails for you? Just ask something like "Any important emails today?" or "Did Sarah email me back?" and I'll have a look for you.`,
    calendar: `${greeting}, I can keep an eye on your calendar too. Try asking "What's on today?" or "Am I free on Thursday afternoon?" and I'll check right away.`,
    drafting: `${greeting}, if you ever need help writing something, I'm happy to help. Whether it's a text to someone, an email reply, or something tricky you're not sure how to word - just send it my way.`,
    web_search: `${greeting}, I can look things up for you too. Recipes, opening hours, how to do something - just ask and I'll find the answer for you.`,
    image_generation: `${greeting}, here's a fun one - I can create images for you! Just describe what you'd like, something like "Draw me a sunset over the ocean" and I'll make it.`,
    travel_time: `${greeting}, if you ever need to know how long it'll take to get somewhere, just ask. Something like "How long to drive to the airport?" and I'll check the live traffic for you.`,
    places: `${greeting}, I can help find places too - restaurants, shops, doctors, anything really. Just ask "Good Italian restaurants near me" or "Closest pharmacy" and I'll look it up.`,
  };

  return tips[feature] || `${greeting}, just a reminder that I'm here whenever you need a hand with anything. Always just a text away!`;
}

async function generateInactivityMessage(user: AutomationUser, tier: 'soft' | 'value' | 'direct'): Promise<string> {
  const name = user.name ? user.name.split(' ')[0] : '';

  if (tier === 'soft') {
    const options = [
      name ? `Hey ${name}, hope you're doing well! Haven't heard from you in a few days and just wanted to check in.` : `Hey there, hope you're doing well! Haven't heard from you in a few days and just wanted to check in.`,
      name ? `Hi ${name}, hope your week is going well. I'm here whenever you need a hand with anything!` : `Hi there, hope your week is going well. I'm here whenever you need a hand with anything!`,
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  if (tier === 'value') {
    if (user.authUserId) {
      try {
        const tz = user.timezone || 'Australia/Sydney';
        const calResult = await liveCalendarLookup(user.authUserId, 'this week', tz, undefined, undefined, 5);
        if (calResult.events?.length > 0) {
          const eventCount = calResult.events.length;
          const firstEvent = calResult.events[0] as Record<string, unknown>;
          return name
            ? `Hey ${name}, hope you're having a good week! I noticed you've got ${eventCount} thing${eventCount !== 1 ? 's' : ''} coming up - ${firstEvent.title} is first. Would you like me to give you a rundown?`
            : `Hey there, hope you're having a good week! You've got ${eventCount} thing${eventCount !== 1 ? 's' : ''} coming up on your calendar. Would you like me to give you a rundown?`;
        }
      } catch {
        // Fall through to generic
      }
    }
    return name
      ? `Hey ${name}, if you've got a messy list, a message you need to write, or anything on your mind - I'm happy to help sort it out for you.`
      : `Hey there, if you've got a messy list, a message you need to write, or anything on your mind - I'm happy to help sort it out for you.`;
  }

  // tier === 'direct'
  return name
    ? `Hey ${name}, just wanted you to know I'm here whenever you need me. No rush at all - just text me anything and I'll help.`
    : `Hey there, just wanted you to know I'm here whenever you need me. No rush at all - just text me anything and I'll help.`;
}

async function generateFollowUpMessage(user: AutomationUser, openLoops: string[]): Promise<string | null> {
  const name = user.name ? user.name.split(' ')[0] : '';

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, a warm and thoughtful personal assistant following up on something the user mentioned previously. Write like a kind friend who genuinely remembered. Use proper capitalisation and punctuation.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}

Open items from their conversations:
${openLoops.map(l => `- ${l}`).join('\n')}

RULES:
- Pick the MOST actionable or timely open loop. Not all of them.
- 1-2 lines max.
- Show genuine care and thoughtfulness, not just running a checklist.
- Reference the specific thing naturally, like a friend who was thinking of them.
- Gently offer to help with the next step if appropriate.
- Australian spelling.

EXAMPLES (don't copy exactly, create your own):
- "Hey Tom, I was thinking about that dentist appointment you mentioned - would you like me to set a reminder before Thursday?"
- "Hi Tom, did you end up hearing back from the mechanic? Happy to help if you need anything."
- "Hey Tom, hope the presentation went well! Let me know if you need a hand with any follow-ups."`,
      input: 'Generate the follow-up message.',
      max_output_tokens: 150,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text?.trim();
    if (!text || text === 'SKIP' || text.length < 10) return null;
    return text;
  } catch (err) {
    console.error('[automations] Follow-up generation failed:', (err as Error).message);
    return null;
  }
}

// ============================================================================
// Onboarding message generators
// ============================================================================

function generateOnboardingGreeting(user: AutomationUser): string {
  const name = user.name ? user.name.split(' ')[0] : '';
  const greeting = name ? `Good morning ${name}` : 'Good morning';

  const messages = [
    `${greeting}, I hope you had a lovely sleep. I'm here whenever you need a hand with anything today.\n---\nWould you like me to send you a little morning check-in like this every day? Just let me know!`,
    `${greeting}, hope you're feeling good this morning. Just wanted to let you know I'm here if you need anything at all today.\n---\nBy the way, I can send you a quick morning hello like this every day if you'd like. Just say the word!`,
    `${greeting}, I hope your morning is off to a nice start. I'm always just a text away if there's anything I can help with today.\n---\nWould you like me to drop you a little note like this each morning? Happy to if it's helpful!`,
  ];

  return messages[Math.floor(Math.random() * messages.length)];
}

async function generateOnboardingFeatureDiscovery(user: AutomationUser): Promise<string | null> {
  const name = user.name ? user.name.split(' ')[0] : '';
  const supabase = getAdminClient();

  let contextBlock = '';
  try {
    const chatId = `DM#${user.botNumber}#${user.handle}`;
    const [memResult, sumResult] = await Promise.all([
      supabase.rpc('get_active_memory_items', { p_handle: user.handle, p_limit: 20 }),
      supabase.from('conversation_summaries')
        .select('summary, topics, open_loops')
        .eq('chat_id', chatId)
        .order('last_message_at', { ascending: false })
        .limit(5),
    ]);

    if (memResult.data?.length) {
      contextBlock += 'What you know about them:\n' +
        (memResult.data as Array<{ value_text: string; memory_type: string; category: string }>)
          .map(m => `- [${m.memory_type}/${m.category}] ${m.value_text}`)
          .join('\n');
    }

    if (sumResult.data?.length) {
      const topics = (sumResult.data as Array<{ topics: string[] | null }>)
        .flatMap(s => s.topics || []);
      if (topics.length > 0) {
        contextBlock += '\nTopics they have discussed: ' + [...new Set(topics)].join(', ');
      }
    }
  } catch (err) {
    console.error('[automations] Context fetch failed:', (err as Error).message);
  }

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, a warm and thoughtful personal assistant texting someone via iMessage. You write like a kind, emotionally intelligent friend. Use proper capitalisation and punctuation.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting (no bold, bullets, headers).

User's name: ${name || 'unknown'}

${contextBlock || 'Not much known about them yet.'}

YOUR TASK: Send a short, warm feature discovery message about REMINDERS. Make it contextual to what you know about them.

RULES:
- Start with a warm greeting using their name if you have it
- Frame it like a friend sharing a genuinely useful tip, not a product tutorial
- Personalise it: if you know they like footy, suggest reminding them about a match. If they mentioned a doctor appointment, suggest a reminder for that. Use whatever you know about their life.
- If you don't know much, use relatable everyday examples (picking up kids, taking medication, calling someone back, etc.)
- Give ONE specific example they could text right now, phrased naturally
- 2-3 lines max
- End with something encouraging but not a question
- Tone: "Oh by the way, did you know..." not "Feature update: you can now..."
- Australian spelling`,
      input: 'Generate the contextual reminders feature discovery message.',
      max_output_tokens: 200,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text?.trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch (err) {
    console.error('[automations] Onboarding feature discovery failed:', (err as Error).message);
    const greeting = name ? `Hey ${name}` : 'Hey there';
    return `${greeting}, by the way - you can ask me to set reminders for anything. Just text something like "Remind me to call the doctor tomorrow at 10am" and I'll make sure you don't forget. Works for recurring things too!`;
  }
}

// ============================================================================
// Core evaluator — runs all rules for a user, returns first match
// ============================================================================

export async function evaluateAutomations(user: AutomationUser): Promise<AutomationResult> {
  const supabase = getAdminClient();
  const nowEpoch = Math.floor(Date.now() / 1000);

  // Resolve user's timezone early (needed for calendar day computation)
  const tz = user.timezone || 'Australia/Sydney';

  // Spam guard: if last proactive was ignored and within 72h
  if (user.lastProactiveIgnored) {
    const hoursSinceLastProactive = user.lastProactiveSentAt
      ? (Date.now() - new Date(user.lastProactiveSentAt).getTime()) / 3600000
      : Infinity;
    if (hoursSinceLastProactive < 72) {
      return { type: 'hold', reason: 'proactive_ignored_within_72h' };
    }
  }

  // Determine onboarding period using calendar days in user's timezone
  const calendarDaysSinceJoin = getCalendarDaysSince(user.firstSeen, tz);

  // Day 0 (sign-up day): no automations at all
  if (calendarDaysSinceJoin < 1) {
    return { type: 'skip', reason: 'day_0_signup_day' };
  }

  // Onboarding period: Day 2 (calendarDay 1) and Day 3 (calendarDay 2)
  // Day 4+ (calendarDay 3+) = regular automations
  const isOnboardingPeriod = calendarDaysSinceJoin <= 2;

  // Global daily cap: max 1 automation per day (enforced always)
  const { data: todayCountData } = await supabase.rpc('automations_sent_today', { p_handle: user.handle });
  const todayCount = (todayCountData as number) ?? 0;
  if (todayCount >= 1) {
    return { type: 'hold', reason: 'daily_cap_reached' };
  }
  const now = new Date();
  let userLocalHour: number;
  let userLocalDay: number;
  try {
    const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
    userLocalHour = parseInt(fmt.format(now));
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short' });
    const dayStr = dayFmt.format(now);
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    userLocalDay = dayMap[dayStr] ?? now.getDay();
  } catch {
    userLocalHour = now.getUTCHours() + 10; // Fallback to AEST
    userLocalDay = now.getDay();
  }

  // Quiet hours: never message between 9pm and 7am
  if (userLocalHour >= 21 || userLocalHour < 7) {
    return { type: 'skip', reason: 'quiet_hours' };
  }

  // Check connected accounts
  let hasConnectedAccounts = false;
  if (user.authUserId) {
    const accounts = await getConnectedAccounts(user.authUserId);
    hasConnectedAccounts = accounts.length > 0;
  }

  // Load user preferences
  const { data: prefsData } = await supabase.rpc('get_automation_preferences', { p_handle: user.handle });
  const prefsMap = new Map<string, { enabled: boolean; scheduleOverride?: Record<string, unknown> }>();
  if (prefsData && Array.isArray(prefsData)) {
    for (const p of prefsData as Array<{ automation_type: string; enabled: boolean; schedule_override: Record<string, unknown> | null }>) {
      prefsMap.set(p.automation_type, { enabled: p.enabled, scheduleOverride: p.schedule_override ?? undefined });
    }
  }

  const hoursSinceLastSeen = (nowEpoch - user.lastSeen) / 3600;
  const daysSinceFirstSeen = (nowEpoch - user.firstSeen) / 86400;

  // Evaluate each rule in priority order
  for (const rule of AUTOMATION_RULES) {
    // During onboarding (calendarDay 1-2 = Day 2-3): only onboarding rules
    // After onboarding (calendarDay 3+ = Day 4+): only regular rules
    const isOnboardingRule = rule.type.startsWith('onboarding_');
    if (isOnboardingPeriod && !isOnboardingRule) continue;
    if (!isOnboardingPeriod && isOnboardingRule) continue;

    // Check user preference
    const pref = prefsMap.get(rule.type);
    if (pref && !pref.enabled) continue;

    // Skip if requires connected accounts and user doesn't have them
    if (rule.requiresConnectedAccounts && !hasConnectedAccounts) continue;

    // Check per-type rate limit
    const { data: lastOfType } = await supabase.rpc('last_automation_of_type', {
      p_handle: user.handle,
      p_automation_type: rule.type,
    });

    if (lastOfType) {
      const hoursSinceLast = (Date.now() - new Date(lastOfType as string).getTime()) / 3600000;
      if (hoursSinceLast < rule.minIntervalHours) continue;
    }

    // Check per-type daily cap
    const { data: typeCountData } = await supabase.rpc('automation_count_in_window', {
      p_handle: user.handle,
      p_automation_type: rule.type,
      p_hours: 24,
    });
    if ((typeCountData as number) >= rule.maxPerDay) continue;

    const ctx: EvalContext = {
      nowEpoch,
      userLocalHour,
      userLocalDay,
      hoursSinceLastSeen,
      daysSinceFirstSeen,
      lastAutomationOfType: lastOfType as string | null,
      automationsToday: todayCount,
      preferences: pref ?? null,
      hasConnectedAccounts,
    };

    try {
      const result = await rule.evaluate(user, ctx);
      if (result.type !== 'skip') {
        return result;
      }
    } catch (err) {
      console.error(`[automations] Rule ${rule.type} failed for ${user.handle}:`, (err as Error).message);
    }
  }

  return { type: 'skip', reason: 'no_applicable_rule' };
}

// ============================================================================
// Record an automation run
// ============================================================================

export async function recordAutomationRun(
  handle: string,
  chatId: string,
  automationType: string,
  content: string,
  metadata: Record<string, unknown> = {},
  manualTrigger = false,
  triggeredBy = 'system',
): Promise<number | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('record_automation_run', {
    p_handle: handle,
    p_chat_id: chatId,
    p_automation_type: automationType,
    p_content: content,
    p_metadata: JSON.stringify(metadata),
    p_manual_trigger: manualTrigger,
    p_triggered_by: triggeredBy,
  });

  if (error) {
    console.error('[automations] Error recording run:', error.message);
    return null;
  }

  return data as number;
}

// ============================================================================
// Fetch eligible users
// ============================================================================

export async function getAutomationEligibleUsers(limit = 50): Promise<AutomationUser[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_automation_eligible_users', { p_limit: limit });

  if (error) {
    console.error('[automations] Error getting eligible users:', error.message);
    return [];
  }

  if (!data || !Array.isArray(data)) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    handle: row.handle as string,
    name: row.name as string | null,
    onboardState: row.onboard_state as string,
    entryState: row.entry_state as string | null,
    firstValueWedge: row.first_value_wedge as string | null,
    firstValueDeliveredAt: row.first_value_delivered_at as string | null,
    followThroughDeliveredAt: row.follow_through_delivered_at as string | null,
    secondEngagementAt: row.second_engagement_at as string | null,
    memoryMomentDeliveredAt: row.memory_moment_delivered_at as string | null,
    activatedAt: row.activated_at as string | null,
    atRiskAt: row.at_risk_at as string | null,
    lastProactiveSentAt: row.last_proactive_sent_at as string | null,
    lastProactiveIgnored: row.last_proactive_ignored as boolean,
    proactiveIgnoreCount: row.proactive_ignore_count as number,
    activationScore: row.activation_score as number,
    capabilityCategoriesUsed: (row.capability_categories_used as string[]) ?? [],
    botNumber: row.bot_number as string | null,
    firstSeen: row.first_seen as number,
    lastSeen: row.last_seen as number,
    onboardCount: row.onboard_count as number,
    timezone: row.timezone as string | null,
    authUserId: row.auth_user_id as string | null,
    status: row.status as string,
    deepProfileSnapshot: row.deep_profile_snapshot as Record<string, unknown> | null,
  }));
}
