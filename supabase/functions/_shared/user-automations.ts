/**
 * user-automations.ts — Generators + executor for user-configured automations
 *
 * These are the automations users toggle on the website Automations page:
 *   morning_briefing, news_briefing, email_summary, follow_up_nudge, daily_wrap, email_monitor,
 *   meeting_intel, weekly_digest, relationship_radar, bill_reminders, custom
 *
 * bill_reminders is webhook-only (notification_watch_triggers); it does not run on the automation-engine schedule.
 *
 * The automation-engine calls getDueUserAutomations() then executeUserAutomation()
 * for each due entry.
 */

import { getOpenAIClient, getResponseText, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import {
  getActiveMemoryItems,
  getConversationSummaries,
} from './state.ts';
import { getAdminClient } from './supabase.ts';
import { displayNameForAlerts, resolveNameForAlerts } from './email-webhook-helpers.ts';
import { liveCalendarLookup, type FormattedCalendarEvent } from './calendar-helpers.ts';
import { gmailSearchTool } from './gmail-helpers.ts';
import { generateInboxSummary } from './inbox-summary.ts';
import {
  extractInterests,
  gatherMorningBriefContext,
  loadMorningBriefUser,
  resolveBriefingLocationForNews,
  type MorningBriefGathered,
} from './morning-brief-audio.ts';
import { newsSearchTool } from './tools/news-search.ts';

const client = getOpenAIClient();

// ============================================================================
// Types
// ============================================================================

export interface DueUserAutomation {
  automationId: string;
  userId: string;
  automationType: string;
  config: {
    time?: string;
    timezone?: string;
    day?: string;
    prompt?: string;
    frequency?: string;
  };
  label: string | null;
  nextRunAt: string;
  // from user_profiles join
  handle: string;
  name: string | null;
  /** coalesce(display_name, name) from user_profiles */
  greetingName: string | null;
  botNumber: string;
  timezone: string | null;
  authUserId: string;
  status: string;
  onboardCount: number;
  activationScore: number;
  lastSeen: number;
  firstSeen: number;
  deepProfileSnapshot: Record<string, unknown> | null;
}

// ============================================================================
// Fetch due automations
// ============================================================================

export async function getDueUserAutomations(limit = 50): Promise<DueUserAutomation[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_due_user_automations', { p_limit: limit });

  if (error) {
    console.error('[user-automations] Error getting due automations:', error.message);
    return [];
  }

  if (!data || !Array.isArray(data)) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    automationId: row.automation_id as string,
    userId: row.user_id as string,
    automationType: row.automation_type as string,
    config: (row.config as DueUserAutomation['config']) ?? {},
    label: row.label as string | null,
    nextRunAt: row.next_run_at as string,
    handle: row.handle as string,
    name: row.name as string | null,
    greetingName: (row.greeting_name as string | null) ?? null,
    botNumber: row.bot_number as string,
    timezone: row.timezone as string | null,
    authUserId: row.auth_user_id as string,
    status: row.status as string,
    onboardCount: (row.onboard_count as number) ?? 0,
    activationScore: (row.activation_score as number) ?? 0,
    lastSeen: row.last_seen as number,
    firstSeen: row.first_seen as number,
    deepProfileSnapshot: row.deep_profile_snapshot as Record<string, unknown> | null,
  }));
}

// ============================================================================
// Advance next_run_at after execution
// ============================================================================

export async function advanceUserAutomation(automationId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('advance_user_automation', { p_automation_id: automationId });
  if (error) {
    console.error('[user-automations] Error advancing automation:', error.message);
  }
}

// ============================================================================
// Generate message for a user automation type
// ============================================================================

async function resolveAutomationGreetingFirstName(auto: DueUserAutomation): Promise<string> {
  const coalesced = (auto.greetingName ?? auto.name ?? '').trim();
  if (coalesced) {
    const first = coalesced.split(/\s+/)[0] || coalesced;
    return displayNameForAlerts(first);
  }
  return resolveNameForAlerts(getAdminClient(), auto.authUserId, null);
}

export async function generateUserAutomationMessage(
  auto: DueUserAutomation,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  const tz = auto.config.timezone || auto.timezone || 'Australia/Sydney';
  const name = await resolveAutomationGreetingFirstName(auto);

  switch (auto.automationType) {
    case 'morning_briefing':
      return generateMorningBriefing(auto, tz, name);
    case 'news_briefing':
      return generateNewsBriefing(auto, tz, name);
    case 'email_summary':
      return generateEmailSummary(auto, tz, name);
    case 'follow_up_nudge':
      return generateFollowUpNudge(auto, tz, name);
    case 'daily_wrap':
      return generateDailyWrap(auto, tz, name);
    case 'email_monitor':
      return generateEmailMonitor(auto, tz, name);
    case 'bill_reminders':
      return null;
    case 'meeting_intel':
      return generateMeetingIntel(auto, tz, name);
    case 'weekly_digest':
      return generateWeeklyDigest(auto, tz, name);
    case 'relationship_radar':
      return generateRelationshipRadar(auto, tz, name);
    case 'custom':
      return generateCustomAutomation(auto, tz, name);
    default:
      console.warn(`[user-automations] Unknown automation type: ${auto.automationType}`);
      return null;
  }
}

// ============================================================================
// Individual generators
// ============================================================================

// ── Morning Briefing (comprehensive — reuses the audio brief's full pipeline) ──

async function generateMorningBriefing(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    const user = await loadMorningBriefUser(auto.handle);
    if (!user) {
      console.warn(`[user-automations] Morning briefing: could not load user ${auto.handle}`);
      return null;
    }

    let firstName = name;
    if (!firstName && user.name) firstName = displayNameForAlerts(user.name.split(' ')[0] ?? user.name);
    if (!firstName) {
      try {
        const mems = await getActiveMemoryItems(auto.handle, 10);
        const nameMem = mems.find(m => m.category === 'name' && m.status === 'active');
        if (nameMem?.valueText) firstName = displayNameForAlerts(nameMem.valueText.split(' ')[0] ?? nameMem.valueText);
      } catch { /* non-fatal */ }
    }

    const gathered: MorningBriefGathered = await gatherMorningBriefContext(user);

    const dayLabel = new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz });
    const displayName = firstName || '';

    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are Nest, sending a morning briefing via iMessage.

FORBIDDEN: em dashes, markdown, bullet points, asterisks, "---", the word "mate". NEVER invent or assume information not provided below. Only mention what is explicitly in the data.

Name for greeting: ${displayName || '(not on file — greet warmly without a placeholder like "there")'}
Day: ${dayLabel}

PROFILE:
${gathered.deep_profile_snippet || '(none)'}

CALENDAR:
${gathered.calendar_snippet || 'Clear day'}

EMAIL:
${gathered.email_snippet || 'Nothing notable'}

WEATHER:
${gathered.weather_snippet || '(unavailable)'}

MEMORIES:
${gathered.memories_snippet || '(none)'}

OPEN LOOPS:
${gathered.summaries_snippet || '(none)'}

NEWS:
${gathered.news_snippet || '(none)'}

FORMAT — exactly 3 short paragraphs, separated by blank lines:

Paragraph 1: Warm greeting${displayName ? ` using their name ("${displayName}")` : ' (no name on file — do not say "there" or invent one)'}. Mention the weather naturally — just the temp and one-word conditions, keep it brief.

Paragraph 2: The day ahead. Lead with the first meeting (name + time). If other meetings or 1-2 genuinely important emails exist, mention them concisely. If nothing on the calendar, say it's a clear day.

Paragraph 3: One extra thing worth knowing — a relevant news headline, an open loop, or a sports result they'd care about. If nothing genuinely useful, skip this paragraph entirely.

CRITICAL RULES:
- ONLY state facts from the data above. If something is not in the data, do not mention it.
- Max 4-5 sentences total. Be concise and articulate — every word should earn its place.
- This is a text message, not an essay. Short, warm, sharp.
- Australian spelling.`,
      input: 'Write the morning briefing.',
      max_output_tokens: 500,
      store: false,
      reasoning: { effort: REASONING_EFFORT.agent },
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) {
      return {
        message: displayName
          ? `Good morning ${displayName}, hope you slept well! Your calendar and inbox are quiet today — enjoy the breathing room.`
          : `Good morning, hope you slept well! Your calendar and inbox are quiet today — enjoy the breathing room.`,
        metadata: { trigger: 'user_scheduled', type: 'morning_briefing', fallback: true },
      };
    }

    return {
      message: text,
      metadata: {
        trigger: 'user_scheduled',
        type: 'morning_briefing',
        resolved_name: displayName,
        has_weather: !!gathered.weather_snippet,
        has_news: !!gathered.news_snippet,
        has_rag: !!gathered.rag_snippet,
      },
    };
  } catch (err) {
    console.error('[user-automations] Morning briefing failed:', (err as Error).message);
    return null;
  }
}

// ── News Briefing (multi-source grounded search + warm intro — website News Briefing toggle) ──

async function generateNewsBriefing(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    const user = await loadMorningBriefUser(auto.handle);
    if (!user) {
      console.warn(`[user-automations] News briefing: could not load user ${auto.handle}`);
      return null;
    }

    let firstName = name;
    if (!firstName && user.name) firstName = displayNameForAlerts(user.name.split(' ')[0] ?? user.name);
    if (!firstName) {
      try {
        const mems = await getActiveMemoryItems(auto.handle, 10);
        const nameMem = mems.find(m => m.category === 'name' && m.status === 'active');
        if (nameMem?.valueText) firstName = displayNameForAlerts(nameMem.valueText.split(' ')[0] ?? nameMem.valueText);
      } catch { /* non-fatal */ }
    }

    const displayName = firstName || '';
    const { location, country } = resolveBriefingLocationForNews(user);
    const interestList = extractInterests(user.deep_profile_snapshot);
    const topics =
      interestList.length > 0 ? interestList.slice(0, 4).join(', ') : undefined;

    const raw = await newsSearchTool.handler(
      {
        ...(location ? { location } : {}),
        ...(topics ? { topics } : {}),
        country,
      },
      {
        chatId: '',
        senderHandle: auto.handle,
        authUserId: auto.authUserId,
        timezone: tz,
        pendingEmailSend: null,
        pendingEmailSends: [],
      },
    );

    const newsBlock = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!newsBlock || newsBlock.length < 40) {
      return {
        message: displayName
          ? `Hey ${displayName}, I couldn't pull a fresh news snapshot just then - want me to try again in a bit?`
          : `Hey, I couldn't pull a fresh news snapshot just then - want me to try again in a bit?`,
        metadata: { trigger: 'user_scheduled', type: 'news_briefing', fallback: true },
      };
    }

    const dayContext = new Date().toLocaleString('en-AU', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });

    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are Nest, sending a scheduled news briefing via iMessage.

The user turned on "News Briefing" on the website. Your job is to feel like a smart friend texting them — not a newsreader or a wire service.

RAW NEWS MATERIAL (from live search — may include section headers):
${newsBlock}

USER CONTEXT:
- Name for greeting (from their Nest profile — first word): ${displayName || '(none on file — open warmly without a fake name or the word "there")'}.
- Their rough area for context: ${location ?? 'not specified'} (${country}).
- Day for them: ${dayContext}

OPENING LINE (CRITICAL):
- Start with ONE short, warm line that varies in tone — never the same template every time.
- When you have a name: use their name naturally, e.g. "Hey Tom, here's a quick look…" or "Morning Sarah -". Never say "Hey there".
- When you do not have a name: warm opener with no placeholder name, e.g. "Hey, quick news catch-up for you -".
- Do NOT sound robotic or like a push notification. Light personality is good.

BODY:
- 2-4 short paragraphs OR use --- between 2 bubbles max (iMessage style).
- Lead with what matters most for someone in ${country}${location ? ` (${location})` : ''}.
- Cover several distinct stories from the material — mix local angle when relevant with national/world.
- For each story: bold the headline idea with **like this**, then 1-2 sentences. No bullet lists with asterisk lines — prose or bold labels only.
- If the raw material is thin on one area, say less rather than padding.

FORBIDDEN: em dashes (use hyphen), the word "mate", markdown tables, numbered lists, "---" as a section divider except between bubbles.

Australian spelling. Max ~350 words — stay scannable on a phone.`,
      input: 'Write the news briefing message.',
      max_output_tokens: 900,
      store: false,
      reasoning: { effort: REASONING_EFFORT.agent },
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 30) {
      return {
        message: displayName
          ? `Hey ${displayName}, here's a quick look at what's making headlines - the full digest didn't come through cleanly, but I can try again if you like.`
          : `Hey, here's a quick look at what's making headlines - the full digest didn't come through cleanly, but I can try again if you like.`,
        metadata: { trigger: 'user_scheduled', type: 'news_briefing', fallback: true, partial: true },
      };
    }

    return {
      message: text,
      metadata: {
        trigger: 'user_scheduled',
        type: 'news_briefing',
        had_location: !!location,
        country,
        had_topic_interests: !!topics,
      },
    };
  } catch (err) {
    console.error('[user-automations] News briefing failed:', (err as Error).message);
    return null;
  }
}

async function generateEmailSummary(
  auto: DueUserAutomation, tz: string, _name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  return generateInboxSummary({
    authUserId: auto.authUserId,
    handle: auto.handle,
    name: auto.name,
    botNumber: auto.botNumber,
    nextRunAt: auto.nextRunAt,
    config: auto.config,
    deepProfileSnapshot: auto.deepProfileSnapshot,
  }, tz);
}

async function generateFollowUpNudge(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    // Search for emails the user sent that haven't been replied to
    const sentResult = await gmailSearchTool(auto.authUserId, {
      query: 'in:sent newer_than:3d',
      max_results: 10,
      time_zone: tz,
    });

    const sentEmails = (sentResult as { results?: Array<{ to?: string; subject: string; date?: string }> }).results;
    if (!sentEmails?.length) return null;

    // Check for replies
    const unreplied: Array<{ to?: string; subject: string }> = [];
    for (const sent of sentEmails.slice(0, 5)) {
      const subject = sent.subject.replace(/^(Re|Fwd):\s*/i, '');
      const replyResult = await gmailSearchTool(auto.authUserId, {
        query: `subject:"${subject}" newer_than:3d -in:sent`,
        max_results: 1,
        time_zone: tz,
      });
      const replies = (replyResult as { results?: unknown[] }).results;
      if (!replies?.length) {
        unreplied.push(sent);
      }
    }

    if (unreplied.length === 0) return null;

    const threadBlock = unreplied.map(e => `- To: ${e.to || 'unknown'} — Subject: ${e.subject}`).join('\n');

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, a warm and thoughtful personal assistant nudging someone about unanswered threads via iMessage.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}
Emails they sent that haven't been replied to:
${threadBlock}

RULES:
- 1-3 lines max.
- Be gentle and helpful, not naggy.
- Pick the 1-2 most important-looking threads to mention.
- Offer to help draft a follow-up if needed.
- Australian spelling.`,
      input: 'Generate the follow-up nudge.',
      max_output_tokens: 200,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

      const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'user_scheduled', unreplied_count: unreplied.length } };
  } catch (err) {
    console.error('[user-automations] Follow-up nudge failed:', (err as Error).message);
    return null;
  }
}

async function generateDailyWrap(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    // Fetch today's events and recent emails
    const [calResult, emailResult] = await Promise.allSettled([
      liveCalendarLookup(auto.authUserId, 'today', tz, undefined, undefined, 10),
      gmailSearchTool(auto.authUserId, { query: 'newer_than:1d', max_results: 5, time_zone: tz }),
    ]);

    let calendarBlock = '';
    let emailBlock = '';

    if (calResult.status === 'fulfilled' && calResult.value.events?.length > 0) {
      calendarBlock = calResult.value.events.map((e: FormattedCalendarEvent) => {
        const time = e.all_day ? 'all day' : e.start;
        return `- ${e.title} (${time})`;
      }).join('\n');
    }

    if (emailResult.status === 'fulfilled') {
      const emailData = emailResult.value as { results?: Array<{ from: string; subject: string }> };
      if (emailData.results?.length) {
        emailBlock = emailData.results.map(e => `- ${e.from}: ${e.subject}`).join('\n');
      }
    }

    // Also check tomorrow's calendar for a heads-up
    let tomorrowBlock = '';
    try {
      const tomorrowResult = await liveCalendarLookup(auto.authUserId, 'tomorrow', tz, undefined, undefined, 5);
      if (tomorrowResult.events?.length > 0) {
        tomorrowBlock = tomorrowResult.events.map((e: FormattedCalendarEvent) => {
          const time = e.all_day ? 'all day' : e.start;
          return `- ${e.title} (${time})`;
        }).join('\n');
      }
    } catch { /* non-fatal */ }

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, a warm and thoughtful personal assistant sending an end-of-day wrap-up via iMessage.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}
Day of week: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz })}

Today's events:
${calendarBlock || 'Nothing on the calendar today'}

Recent emails:
${emailBlock || 'No notable emails'}

Tomorrow's events:
${tomorrowBlock || 'Nothing scheduled yet'}

RULES:
- 2-4 lines max.
- Warm evening tone - reflect on the day briefly.
- If there were events, mention how the day looked.
- Preview tomorrow if there's anything coming up.
- Use --- to separate into max 2 bubbles.
- Australian spelling.`,
      input: 'Generate the daily wrap-up.',
      max_output_tokens: 300,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'user_scheduled', type: 'daily_wrap' } };
  } catch (err) {
    console.error('[user-automations] Daily wrap failed:', (err as Error).message);
    return null;
  }
}

async function generateEmailMonitor(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    // Look for urgent/important emails in the last hour
    const emailResult = await gmailSearchTool(auto.authUserId, {
      query: 'is:unread is:important newer_than:1h',
      max_results: 5,
      time_zone: tz,
    });

    const emails = (emailResult as { results?: Array<{ from: string; subject: string; snippet?: string }> }).results;
    if (!emails?.length) return null; // Nothing urgent — skip silently

    // Also check for sender-based watch filters if configured
    const watchFilters = (auto.config as Record<string, unknown>).watch_filters as { senders?: string[]; keywords?: string[] } | undefined;
    let filteredEmails = emails;

    if (watchFilters?.senders?.length || watchFilters?.keywords?.length) {
      filteredEmails = emails.filter(e => {
        if (watchFilters.senders?.some(s => e.from.toLowerCase().includes(s.toLowerCase()))) return true;
        if (watchFilters.keywords?.some(k =>
          e.subject.toLowerCase().includes(k.toLowerCase()) ||
          (e.snippet || '').toLowerCase().includes(k.toLowerCase())
        )) return true;
        // If no filters match, still include if Gmail marked it important
        return !watchFilters.senders?.length && !watchFilters.keywords?.length;
      });
    }

    if (filteredEmails.length === 0) return null;

    const emailBlock = filteredEmails.map(e => `- ${e.from}: ${e.subject}`).join('\n');

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, sending an urgent email alert via iMessage. Be concise and helpful.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}
Urgent unread emails:
${emailBlock}

RULES:
- 1-2 lines max. This is an alert, not a summary.
- Mention the sender and subject of the most important email.
- Offer to read the full email or help draft a reply.
- Australian spelling.`,
      input: 'Generate the urgent email alert.',
      max_output_tokens: 150,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'email_monitor', urgent_count: filteredEmails.length } };
  } catch (err) {
    console.error('[user-automations] Email monitor failed:', (err as Error).message);
    return null;
  }
}

async function generateMeetingIntel(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    const calResult = await liveCalendarLookup(auto.authUserId, 'tomorrow', tz, undefined, undefined, 10);

    if (!calResult.events?.length) {
      return {
        message: name
          ? `Hey ${name}, no meetings on the calendar for tomorrow. Looks like a clear day ahead!`
          : `Hey there, no meetings on the calendar for tomorrow. Looks like a clear day ahead!`,
        metadata: { trigger: 'user_scheduled', event_count: 0 },
      };
    }

    const events = calResult.events as FormattedCalendarEvent[];
    const meetingBlock = events.map((e: FormattedCalendarEvent) => {
      const time = e.all_day ? 'all day' : e.start;
      const loc = e.location ? ` @ ${e.location}` : '';
      const attendees = (e.attendees as string[] || []).join(', ');
      return `- ${e.title} (${time}${loc})${attendees ? ` — with ${attendees}` : ''}`;
    }).join('\n');

    // Try to get memory context about attendees
    let contextBlock = '';
    try {
      const supabase = getAdminClient();
      const memResult = await supabase.rpc('get_active_memory_items', { p_handle: auto.handle, p_limit: 15 });
      if (memResult.data?.length) {
        const mems = (memResult.data as Array<{ value_text: string; category: string }>)
          .map(m => `- [${m.category}] ${m.value_text}`)
          .join('\n');
        contextBlock = `\nWhat you know about this person:\n${mems}`;
      }
    } catch { /* non-fatal */ }

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, sending an evening meeting prep brief via iMessage. Help them feel prepared for tomorrow.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}

Tomorrow's meetings:
${meetingBlock}
${contextBlock}

RULES:
- 2-4 lines max.
- Mention key meetings with times and who they're meeting.
- If you have context about attendees from memory, weave in a helpful detail.
- Warm, encouraging tone - help them feel prepared, not stressed.
- Use --- to separate into max 2 bubbles.
- Australian spelling.`,
      input: 'Generate the meeting intel brief.',
      max_output_tokens: 300,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'user_scheduled', event_count: events.length } };
  } catch (err) {
    console.error('[user-automations] Meeting intel failed:', (err as Error).message);
    return null;
  }
}

async function generateWeeklyDigest(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    // Fetch this week's calendar events and email stats
    const [calResult, emailResult] = await Promise.allSettled([
      liveCalendarLookup(auto.authUserId, 'this week', tz, undefined, undefined, 20),
      gmailSearchTool(auto.authUserId, { query: 'newer_than:7d', max_results: 15, time_zone: tz }),
    ]);

    let eventCount = 0;
    let eventHighlights = '';
    if (calResult.status === 'fulfilled' && calResult.value.events?.length) {
      eventCount = calResult.value.events.length;
      eventHighlights = calResult.value.events.slice(0, 5).map((e: FormattedCalendarEvent) =>
        `- ${e.title}`
      ).join('\n');
    }

    let emailCount = 0;
    let emailHighlights = '';
    if (emailResult.status === 'fulfilled') {
      const emailData = emailResult.value as { results?: Array<{ from: string; subject: string }> };
      emailCount = emailData.results?.length ?? 0;
      if (emailData.results?.length) {
        emailHighlights = emailData.results.slice(0, 5).map(e => `- ${e.from}: ${e.subject}`).join('\n');
      }
    }

    // Get conversation activity
    const chatId = `DM#${auto.botNumber}#${auto.handle}`;
    const summaries = await getConversationSummaries(chatId, 7);
    const topics = summaries.flatMap(s => s.topics || []);
    const uniqueTopics = [...new Set(topics)].slice(0, 5);

    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are Nest, sending a weekly review via iMessage. Warm, reflective tone.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}

This week's stats:
- ${eventCount} calendar events
- ~${emailCount}+ emails

Event highlights:
${eventHighlights || 'Quiet week on the calendar'}

Email highlights:
${emailHighlights || 'No major emails'}

Topics discussed with Nest this week:
${uniqueTopics.length > 0 ? uniqueTopics.join(', ') : 'Not much chat this week'}

RULES:
- 3-5 lines max.
- Warm, reflective recap of their week.
- Mention key events and conversations.
- End with something encouraging about the week ahead.
- Use --- to separate into max 2 bubbles.
- Australian spelling.`,
      input: 'Generate the weekly digest.',
      max_output_tokens: 400,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'user_scheduled', event_count: eventCount, email_count: emailCount } };
  } catch (err) {
    console.error('[user-automations] Weekly digest failed:', (err as Error).message);
    return null;
  }
}

async function generateRelationshipRadar(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  try {
    const supabase = getAdminClient();

    // Get memories about people
    const memResult = await supabase.rpc('get_active_memory_items', { p_handle: auto.handle, p_limit: 30 });
    const memories = (memResult.data as Array<{ value_text: string; category: string; memory_type: string; updated_at: string }>) || [];

    // Filter for people-related memories
    const peopleMemories = memories.filter(m =>
      m.category === 'people' || m.category === 'relationships' || m.memory_type === 'person'
    );

    if (peopleMemories.length === 0) {
      // Fall back to email contacts they haven't emailed recently
      try {
        const recentResult = await gmailSearchTool(auto.authUserId, {
          query: 'in:sent older_than:7d newer_than:30d',
          max_results: 10,
          time_zone: tz,
        });
        const recentSent = (recentResult as { results?: Array<{ to?: string }> }).results;
        if (!recentSent?.length) return null;

        const contacts = [...new Set(recentSent.map(e => e.to).filter(Boolean))].slice(0, 5);
        if (contacts.length === 0) return null;

        const greeting = name ? `Hey ${name}` : 'Hey there';
        return {
          message: `${greeting}, it's been a little while since you've been in touch with some people. Might be worth a quick check-in with ${contacts.slice(0, 2).join(' or ')} if you get a chance this week.`,
          metadata: { trigger: 'user_scheduled', contacts_suggested: contacts.slice(0, 2) },
        };
      } catch {
        return null;
      }
    }

    const peopleBlock = peopleMemories.slice(0, 10).map(m => `- ${m.value_text}`).join('\n');

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: `You are Nest, sending a gentle relationship check-in via iMessage. You're like a thoughtful friend who helps them stay connected with the people who matter.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}

What you know about people in their life:
${peopleBlock}

RULES:
- 2-3 lines max.
- Pick 1-2 people who might appreciate a check-in.
- Be specific about why (birthday coming up, haven't spoken in a while, last mentioned them in X context).
- Warm, non-pushy tone.
- Australian spelling.`,
      input: 'Generate the relationship radar nudge.',
      max_output_tokens: 200,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'user_scheduled', people_in_memory: peopleMemories.length } };
  } catch (err) {
    console.error('[user-automations] Relationship radar failed:', (err as Error).message);
    return null;
  }
}

async function generateCustomAutomation(
  auto: DueUserAutomation, tz: string, name: string,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  const prompt = auto.config.prompt || auto.label;
  if (!prompt) {
    console.warn('[user-automations] Custom automation has no prompt or label');
    return null;
  }

  try {
    // Gather context
    let contextBlock = '';

    if (auto.authUserId) {
      const [calResult, emailResult, memResult] = await Promise.allSettled([
        liveCalendarLookup(auto.authUserId, 'today', tz, undefined, undefined, 5),
        gmailSearchTool(auto.authUserId, { query: 'is:unread newer_than:1d', max_results: 5, time_zone: tz }),
        getActiveMemoryItems(auto.handle, 10),
      ]);

      if (calResult.status === 'fulfilled' && calResult.value.events?.length) {
        contextBlock += '\nToday\'s calendar:\n' + calResult.value.events.map((e: FormattedCalendarEvent) =>
          `- ${e.title} (${e.all_day ? 'all day' : e.start})`
        ).join('\n');
      }

      if (emailResult.status === 'fulfilled') {
        const emailData = emailResult.value as { results?: Array<{ from: string; subject: string }> };
        if (emailData.results?.length) {
          contextBlock += '\nRecent emails:\n' + emailData.results.map(e => `- ${e.from}: ${e.subject}`).join('\n');
        }
      }

      if (memResult.status === 'fulfilled' && (memResult.value as unknown[])?.length) {
        const mems = memResult.value;
        contextBlock += '\nMemories:\n' + mems.map(m => `- ${m.valueText}`).join('\n');
      }
    }

    const dayOfWeek = new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz });

    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are Nest, a warm and thoughtful personal assistant texting someone via iMessage. Write like a kind, emotionally intelligent friend.

ABSOLUTELY FORBIDDEN: em dash character (use hyphen), the word "mate", markdown formatting.

User's name: ${name || 'unknown'}
Day: ${dayOfWeek}
${contextBlock}

The user has set up a custom recurring automation with this instruction:
"${prompt}"

RULES:
- Follow the user's instruction as closely as possible.
- 2-4 lines max unless the instruction clearly needs more.
- Be warm, personal, and helpful.
- Use context (calendar, emails, memories) to make the response relevant.
- Use --- to separate into max 2 bubbles if needed.
- Australian spelling.`,
      input: `Execute the custom automation: "${prompt}"`,
      max_output_tokens: 400,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = getResponseText(response).trim();
    if (!text || text.length < 10) return null;

    return { message: text, metadata: { trigger: 'custom_scheduled', prompt, label: auto.label } };
  } catch (err) {
    console.error('[user-automations] Custom automation failed:', (err as Error).message);
    return null;
  }
}
