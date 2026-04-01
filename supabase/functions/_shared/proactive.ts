import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import {
  type ProactiveEligibleUser,
  transitionOnboardState,
  emitOnboardingEvent,
  recordProactiveMessage,
  getActiveMemoryItems,
  getConversationSummaries,
  getConnectedAccounts,
} from './state.ts';
import { USER_PROFILES_TABLE } from './env.ts';
import { getAdminClient } from './supabase.ts';
import { liveCalendarLookup } from './calendar-helpers.ts';
import { gmailSearchTool } from './gmail-helpers.ts';

const client = getOpenAIClient();

// ============================================================================
// Proactive action types
//
// NOTE: Recovery nudge has been removed. Re-engagement is now handled by
// the automation-engine (graduated Day 3/5/7 inactivity_reengagement).
// ============================================================================

export type ProactiveAction =
  | { type: 'hold'; reason: string }
  | { type: 'wait' }
  | { type: 'memory_moment'; message: string }
  | { type: 'mark_at_risk' }
  | { type: 'mark_activated' };

// ============================================================================
// Core orchestrator — evaluates what proactive action to take for a user
// ============================================================================

export async function evaluateProactiveAction(user: ProactiveEligibleUser): Promise<ProactiveAction> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const userAgeHours = (nowEpoch - user.firstSeen) / 3600;
  const hoursSinceLastSeen = (nowEpoch - user.lastSeen) / 3600;
  const hoursSinceLastProactive = user.lastProactiveSentAt
    ? (Date.now() - new Date(user.lastProactiveSentAt).getTime()) / 3600000
    : Infinity;

  // Spam hold: if last proactive was ignored and within 72 hours
  if (user.lastProactiveIgnored && hoursSinceLastProactive < 72) {
    return { type: 'hold', reason: 'proactive_ignored_within_72h' };
  }

  // If user has been active for 48+ hours and activation score >= 2, mark activated
  if (userAgeHours >= 48 && user.activationScore >= 2) {
    return { type: 'mark_activated' };
  }

  // If user has been active for 48+ hours and activation score < 2, mark at risk
  if (userAgeHours >= 48 && user.activationScore < 2) {
    return { type: 'mark_at_risk' };
  }

  // Memory moment: if value delivered + second engagement + high-confidence memories exist
  if (
    user.firstValueDeliveredAt &&
    user.secondEngagementAt &&
    !user.memoryMomentDeliveredAt &&
    hoursSinceLastSeen >= 12
  ) {
    const memoryMessage = await evaluateMemoryMoment(user);
    if (memoryMessage) {
      return { type: 'memory_moment', message: memoryMessage };
    }
  }

  return { type: 'wait' };
}

// ============================================================================
// Memory moment — deep, one-off proactive message
//
// This fires exactly once per user. It gathers the richest possible context:
//   1. All active memories about the user
//   2. Full conversation summary history (what they've talked about)
//   3. If accounts are connected: upcoming calendar events + recent emails
//   4. If no accounts: relies solely on conversation + memory context
//
// A reasoning model then synthesises all of this to produce a single,
// genuinely useful message — something that reduces cognitive load,
// shows follow-through, or surfaces a timely connection the user
// wouldn't have thought to ask about.
// ============================================================================

async function resolveAuthUserId(handle: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(USER_PROFILES_TABLE)
    .select('auth_user_id')
    .eq('handle', handle)
    .maybeSingle();

  if (error || !data) return null;
  return (data.auth_user_id as string) ?? null;
}

interface MemoryMomentContext {
  memories: string;
  conversationHistory: string;
  calendarEvents: string | null;
  recentEmails: string | null;
  hasConnectedAccounts: boolean;
}

async function gatherMemoryMomentContext(user: ProactiveEligibleUser): Promise<MemoryMomentContext | null> {
  const chatId = `DM#${user.botNumber}#${user.handle}`;

  const [memories, summaries] = await Promise.all([
    getActiveMemoryItems(user.handle, 30),
    getConversationSummaries(chatId, 20),
  ]);

  if (memories.length === 0 && summaries.length === 0) return null;

  const memoriesText = memories.length > 0
    ? memories.map((m) =>
        `- [${m.memoryType}/${m.category}] ${m.valueText} (confidence: ${Math.round(m.confidence * 100)}%, last seen: ${m.lastSeenAt})`
      ).join('\n')
    : 'No stored memories yet.';

  const conversationText = summaries.length > 0
    ? summaries.map((s) => {
        const topics = s.topics.length > 0 ? ` | Topics: ${s.topics.join(', ')}` : '';
        const loops = s.openLoops.length > 0 ? ` | Open loops: ${s.openLoops.join(', ')}` : '';
        return `- [${s.firstMessageAt} → ${s.lastMessageAt}] ${s.summary}${topics}${loops}`;
      }).join('\n')
    : 'No conversation summaries available.';

  let calendarEvents: string | null = null;
  let recentEmails: string | null = null;
  let hasConnectedAccounts = false;

  const authUserId = await resolveAuthUserId(user.handle);

  if (authUserId) {
    const accounts = await getConnectedAccounts(authUserId);
    hasConnectedAccounts = accounts.length > 0;

    if (hasConnectedAccounts) {
      const tz = user.timezone || 'Australia/Sydney';

      const [calResult, emailResult] = await Promise.allSettled([
        liveCalendarLookup(authUserId, 'next 3 days', tz, undefined, undefined, 15),
        gmailSearchTool(authUserId, { query: 'newer_than:3d', max_results: 10, time_zone: tz }),
      ]);

      if (calResult.status === 'fulfilled' && calResult.value.events.length > 0) {
        calendarEvents = calResult.value.events.map((e) => {
          const time = e.all_day ? 'all day' : e.start;
          const attendees = e.attendees.length > 0 ? ` (with: ${e.attendees.join(', ')})` : '';
          const location = e.location ? ` @ ${e.location}` : '';
          return `- ${e.title} — ${time}${location}${attendees}`;
        }).join('\n');
      }

      if (emailResult.status === 'fulfilled') {
        const emailData = emailResult.value as { results?: Array<{ from: string; subject: string; date: string; snippet: string }> };
        if (emailData.results && emailData.results.length > 0) {
          recentEmails = emailData.results.map((e) =>
            `- From: ${e.from} | Subject: ${e.subject} | ${e.date}\n  ${e.snippet}`
          ).join('\n');
        }
      }
    }
  }

  return { memories: memoriesText, conversationHistory: conversationText, calendarEvents, recentEmails, hasConnectedAccounts };
}

async function evaluateMemoryMoment(user: ProactiveEligibleUser): Promise<string | null> {
  const ctx = await gatherMemoryMomentContext(user);
  if (!ctx) return null;

  const name = user.name ? ` ${user.name}` : '';
  const now = new Date().toLocaleString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: user.timezone || 'Australia/Sydney',
  });

  let contextBlock = `## What you know about${name || ' this person'}\n${ctx.memories}\n\n## Conversation history\n${ctx.conversationHistory}`;

  if (ctx.calendarEvents) {
    contextBlock += `\n\n## Their upcoming calendar (next 3 days)\n${ctx.calendarEvents}`;
  }
  if (ctx.recentEmails) {
    contextBlock += `\n\n## Their recent emails (last 3 days)\n${ctx.recentEmails}`;
  }

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: `You are an intelligence layer for Nest, a personal assistant that people text. Your job is to analyse everything known about a user and produce ONE proactive message that is genuinely, specifically useful to them right now. Write with warmth, proper capitalisation, and like a thoughtful friend — not a notification system.

Current time: ${now}

${contextBlock}

## Your task

Analyse all of the above deeply. Look for:
1. **Open loops** — things they said they'd do but haven't followed up on
2. **Upcoming commitments** — calendar events they might need to prepare for, or conflicts they haven't noticed
3. **Timely connections** — an email that relates to something they mentioned in conversation, a meeting that connects to a task they committed to
4. **Forgotten follow-ups** — things they asked Nest to help with that have a natural next step
5. **Cognitive load reduction** — anything where a short nudge saves them from having to remember

${ctx.hasConnectedAccounts ? 'You have access to their calendar and emails. Cross-reference these with their conversation history and memories to find genuinely useful connections they might not see themselves.' : 'No calendar or email accounts are connected. Work purely from conversation history and memories. Focus on open loops, commitments, and follow-ups from what they have told you.'}

## Rules

- Output ONLY the message text. Nothing else.
- Keep it to 1-2 short sentences. This is a text message, not an email.
- Use proper capitalisation and punctuation. Be warm and kind.
- Be specific. Reference actual things — names, dates, tasks, events. Never be vague.
- The tone is a thoughtful, caring friend who noticed something useful — not a notification system.
- Australian spelling.
- Never mention AI, bots, technology, or that you "analysed" anything. You just remembered / noticed.
- Never show off memory for its own sake. Every reference must serve the user.
- If you genuinely cannot find anything useful and specific to say, respond with exactly: SKIP
- Do NOT be generic. "Hope your week's going well" = instant fail. "Hey Tom, I was thinking about that dentist appointment — would you like me to set a reminder before Thursday?" = good.

## Anti-patterns (never do these)
- "I remember you mentioned..." (showing off)
- "Just checking in!" (generic)
- "How did X go?" without a useful follow-up attached (empty curiosity)
- Referencing sensitive topics (health, relationships) unless there's a clear practical action
- Surfacing calendar/email info without connecting it to something they actually care about`,
      input: 'Analyse the full context and generate the memory moment message, or SKIP if nothing is genuinely useful.',
      max_output_tokens: 2048,
      store: false,
      reasoning: { effort: 'high' as const },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text?.trim();
    if (!text || text === 'SKIP' || text.length < 10) return null;
    return text;
  } catch (err) {
    console.error('[proactive] Memory moment generation failed:', (err as Error).message);
    return null;
  }
}

// ============================================================================
// Execute a proactive action (called by the orchestrator edge function)
// ============================================================================

export async function executeProactiveAction(
  user: ProactiveEligibleUser,
  action: ProactiveAction,
): Promise<{ sent: boolean; message?: string }> {
  switch (action.type) {
    case 'hold':
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'proactive_hold_due_to_spam_rule',
        currentState: user.onboardState,
        payload: { reason: action.reason },
      });
      return { sent: false };

    case 'wait':
      return { sent: false };

    case 'mark_activated':
      await transitionOnboardState({
        handle: user.handle,
        newState: 'activated',
        activated: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'activated_composite',
        currentState: 'activated',
        payload: { activationScore: user.activationScore },
      });
      return { sent: false };

    case 'mark_at_risk':
      await transitionOnboardState({
        handle: user.handle,
        newState: 'at_risk',
        atRisk: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'at_risk_48h',
        currentState: 'at_risk',
        payload: { activationScore: user.activationScore },
      });
      return { sent: false };

    case 'memory_moment':
      await recordProactiveMessage(user.handle, `DM#${user.botNumber}#${user.handle}`, 'memory_moment', action.message);
      await transitionOnboardState({
        handle: user.handle,
        newState: 'memory_moment_delivered',
        memoryMomentDelivered: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'memory_moment_sent',
        currentState: 'memory_moment_delivered',
      });
      return { sent: true, message: action.message };
  }
}
