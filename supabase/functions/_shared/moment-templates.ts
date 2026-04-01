import { getAdminClient } from './supabase.ts';
import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import type { Moment, MomentCandidate } from './moments.ts';
import { getUserLocalTime } from './moments.ts';
import { getConnectedAccounts, getActiveMemoryItems, getConversationSummaries } from './state.ts';
import { liveCalendarLookup } from './calendar-helpers.ts';
import { gmailSearchTool } from './gmail-helpers.ts';

// ============================================================================
// Nest voice system prompt — shared across all moment-generated messages
// ============================================================================

const NEST_VOICE_PROMPT = `You are Nest, a warm and thoughtful personal assistant that people text via iMessage. You write like a kind, emotionally intelligent friend — not a corporate bot, not overly casual slang. Use proper capitalisation and punctuation (but not formal). No markdown, no em dashes, no bullet points, no asterisks. Australian spelling. Never mention AI, bots, or technology. Use --- to split into multiple text bubbles if needed (max 2 bubbles). Keep it SHORT — this is a text message, not an email.

Tone guide:
- Warm, genuine, caring — like a trusted friend who actually pays attention
- Use greetings that feel human and varied
- Show you care about them as a person, not just their schedule
- Never robotic, never overly peppy, never salesy
- Vary your openings every time — never repeat the same greeting pattern
- It's okay to be brief, but always be kind`;

// ============================================================================
// Variable resolution context
// ============================================================================

interface TemplateContext {
  user: Record<string, string>;
  time: Record<string, string>;
  context: Record<string, string>;
  event: Record<string, string>;
}

// ============================================================================
// Resolve all template variables for a user
// ============================================================================

export async function resolveVariables(
  moment: Moment,
  candidate: MomentCandidate,
): Promise<TemplateContext> {
  const tz = candidate.timezone || 'Australia/Sydney';
  const { localHour } = getUserLocalTime(tz);
  const nowEpoch = Math.floor(Date.now() / 1000);
  const daysSinceSignup = Math.round((nowEpoch - candidate.first_seen) / 86400);

  const firstName = candidate.name ? candidate.name.split(' ')[0] : '';

  // Time-based greeting
  let greeting: string;
  if (localHour < 12) greeting = 'Good morning';
  else if (localHour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';

  const dayOfWeek = new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz });

  const timeVars: Record<string, string> = {
    day_of_week: dayOfWeek,
    local_hour: String(localHour),
    greeting,
    date: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }),
  };

  const userVars: Record<string, string> = {
    name: candidate.name || 'there',
    first_name: firstName || 'there',
    handle: candidate.handle,
    timezone: tz,
    days_since_signup: String(daysSinceSignup),
    onboard_count: String(candidate.onboard_count),
    activation_score: String(candidate.activation_score),
  };

  // Context variables — resolve lazily based on what the moment needs
  const contextVars: Record<string, string> = {};
  const neededVars = detectNeededVariables(moment.prompt_template || '');

  if (neededVars.has('context.calendar_today') && candidate.auth_user_id) {
    try {
      const result = await liveCalendarLookup(candidate.auth_user_id, 'today', tz, undefined, undefined, 10);
      if (result.events?.length > 0) {
        contextVars.calendar_today = (result.events as Array<Record<string, unknown>>)
          .map((e) => {
            const time = e.all_day ? 'all day' : e.start;
            const loc = e.location ? ` @ ${e.location}` : '';
            return `- ${e.title} (${time}${loc})`;
          })
          .join('\n');
      } else {
        contextVars.calendar_today = 'No events today';
      }
    } catch {
      contextVars.calendar_today = 'Calendar unavailable';
    }
  }

  if (neededVars.has('context.unread_emails') && candidate.auth_user_id) {
    try {
      const emailResult = await gmailSearchTool(candidate.auth_user_id, {
        query: 'is:unread newer_than:1d',
        max_results: 5,
        time_zone: tz,
      });
      const emailData = emailResult as { results?: Array<{ from: string; subject: string }> };
      if (emailData.results?.length) {
        contextVars.unread_emails = emailData.results
          .map((e) => `- ${e.from}: ${e.subject}`)
          .join('\n');
      } else {
        contextVars.unread_emails = 'No unread emails';
      }
    } catch {
      contextVars.unread_emails = 'Email unavailable';
    }
  }

  if (neededVars.has('context.memories')) {
    try {
      const memories = await getActiveMemoryItems(candidate.handle, 20);
      if (memories.length > 0) {
        contextVars.memories = memories
          .map((m: Record<string, unknown>) => `- [${m.memory_type}/${m.category}] ${m.value_text}`)
          .join('\n');
      } else {
        contextVars.memories = 'No memories stored yet';
      }
    } catch {
      contextVars.memories = 'Memories unavailable';
    }
  }

  if (neededVars.has('context.open_loops') && candidate.bot_number) {
    try {
      const chatId = `DM#${candidate.bot_number}#${candidate.handle}`;
      const summaries = await getConversationSummaries(chatId, 5);
      const loops = summaries
        .filter((s: Record<string, unknown>) => s.openLoops && (s.openLoops as string[]).length > 0)
        .flatMap((s: Record<string, unknown>) => s.openLoops as string[]);
      contextVars.open_loops = loops.length > 0
        ? loops.map((l) => `- ${l}`).join('\n')
        : 'No open loops';
    } catch {
      contextVars.open_loops = 'Open loops unavailable';
    }
  }

  if (neededVars.has('context.connected_accounts') && candidate.auth_user_id) {
    try {
      const accounts = await getConnectedAccounts(candidate.auth_user_id);
      contextVars.connected_accounts = accounts.length > 0
        ? `${accounts.length} account(s) connected`
        : 'No accounts connected';
    } catch {
      contextVars.connected_accounts = 'Unknown';
    }
  }

  const eventVars: Record<string, string> = {};

  return { user: userVars, time: timeVars, context: contextVars, event: eventVars };
}

// ============================================================================
// Render a prompt template with resolved variables
// ============================================================================

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, namespace, key) => {
    const ns = ctx[namespace as keyof TemplateContext];
    if (ns && key in ns) {
      return ns[key];
    }
    return `{{${namespace}.${key}}}`;
  });
}

// ============================================================================
// Generate message via LLM using rendered prompt
// ============================================================================

export async function generateMomentMessage(
  moment: Moment,
  candidate: MomentCandidate,
  ctx: TemplateContext,
): Promise<{ message: string; promptUsed: string } | null> {
  const template = moment.prompt_template;
  if (!template) return null;

  const renderedPrompt = renderTemplate(template, ctx);
  const systemContext = moment.prompt_system_context || NEST_VOICE_PROMPT;
  const fullSystemPrompt = `${systemContext}\n\nUser's name: ${ctx.user.first_name}\nDay: ${ctx.time.day_of_week}\nLocal time: ${ctx.time.local_hour}:00`;

  try {
    const client = getOpenAIClient();
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: fullSystemPrompt,
      input: renderedPrompt,
      max_output_tokens: 400,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = (response as unknown as { output_text?: string }).output_text?.trim();
    if (!text || text.length < 10) return null;

    return { message: text, promptUsed: renderedPrompt };
  } catch (err) {
    console.error(`[moment-templates] LLM generation failed for ${moment.name}:`, (err as Error).message);
    return null;
  }
}

// ============================================================================
// Execute a moment's action for a candidate
// ============================================================================

export async function executeMomentAction(
  moment: Moment,
  candidate: MomentCandidate,
): Promise<{ message: string; promptUsed: string; metadata: Record<string, unknown> } | null> {
  const ctx = await resolveVariables(moment, candidate);

  if (moment.action_type === 'send_message' && moment.prompt_template) {
    const result = await generateMomentMessage(moment, candidate, ctx);
    if (!result) {
      // Try fallback message
      const fallback = moment.action_config.fallback_message as string | undefined;
      if (fallback) {
        const rendered = renderTemplate(fallback, ctx);
        return { message: rendered, promptUsed: 'fallback', metadata: { fallback: true } };
      }
      return null;
    }
    return {
      message: result.message,
      promptUsed: result.promptUsed,
      metadata: { action_type: 'send_message' },
    };
  }

  if (moment.action_type === 'send_message' && !moment.prompt_template) {
    // Static message from action_config
    const staticMsg = moment.action_config.message as string | undefined;
    if (staticMsg) {
      const rendered = renderTemplate(staticMsg, ctx);
      return { message: rendered, promptUsed: 'static', metadata: { static: true } };
    }
    return null;
  }

  if (moment.action_type === 'run_agentic_task') {
    const result = await generateMomentMessage(moment, candidate, ctx);
    if (!result) return null;
    return {
      message: result.message,
      promptUsed: result.promptUsed,
      metadata: { action_type: 'run_agentic_task' },
    };
  }

  // For trigger_morning_brief and create_reminder, we generate a message
  // that will be handled by the engine's action router
  if (moment.prompt_template) {
    const result = await generateMomentMessage(moment, candidate, ctx);
    if (!result) return null;
    return {
      message: result.message,
      promptUsed: result.promptUsed,
      metadata: { action_type: moment.action_type },
    };
  }

  return null;
}

// ============================================================================
// Preview: render a moment for a sample user (without sending)
// ============================================================================

export async function previewMoment(
  moment: Moment,
  candidate: MomentCandidate,
): Promise<{ renderedPrompt: string; generatedMessage: string | null; variables: TemplateContext }> {
  const ctx = await resolveVariables(moment, candidate);
  const renderedPrompt = moment.prompt_template ? renderTemplate(moment.prompt_template, ctx) : '';

  let generatedMessage: string | null = null;
  if (moment.prompt_template) {
    const result = await generateMomentMessage(moment, candidate, ctx);
    generatedMessage = result?.message ?? null;
  }

  return { renderedPrompt, generatedMessage, variables: ctx };
}

// ============================================================================
// Internal helpers
// ============================================================================

function detectNeededVariables(template: string): Set<string> {
  const matches = template.matchAll(/\{\{(\w+\.\w+)\}\}/g);
  const needed = new Set<string>();
  for (const match of matches) {
    needed.add(match[1]);
  }
  return needed;
}
