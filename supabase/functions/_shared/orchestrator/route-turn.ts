import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import type { TurnInput, RouteDecision, AgentName, ToolNamespace, UserStyle } from './types.ts';
import type { RouterContext } from './build-context.ts';

// ═══════════════════════════════════════════════════════════════
// Agent namespace policies — what each agent is allowed to use
// ═══════════════════════════════════════════════════════════════

const AGENT_NAMESPACES: Record<AgentName, ToolNamespace[]> = {
  casual: ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'media.generate', 'web.search'],
  productivity: ['memory.read', 'memory.write', 'email.read', 'email.write', 'calendar.read', 'calendar.write', 'contacts.read', 'messaging.react', 'messaging.effect', 'web.search'],
  research: ['memory.read', 'web.search', 'knowledge.search', 'contacts.read', 'messaging.react'],
  recall: ['memory.read', 'knowledge.search', 'messaging.react'],
  operator: ['memory.read', 'memory.write', 'email.read', 'email.write', 'calendar.read', 'calendar.write', 'contacts.read', 'web.search', 'knowledge.search', 'messaging.react', 'messaging.effect', 'media.generate'],
  onboard: ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'web.search', 'knowledge.search'],
  meeting_prep: ['calendar.read', 'email.read', 'contacts.read', 'knowledge.search', 'memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'web.search'],
};

// ═══════════════════════════════════════════════════════════════
// Layer 1: Deterministic fast-path rules
// ═══════════════════════════════════════════════════════════════

function tryFastPath(input: TurnInput, context: RouterContext): RouteDecision | null {
  if (input.isOnboarding) {
    return {
      mode: 'onboard',
      agent: 'onboard',
      allowedNamespaces: AGENT_NAMESPACES.onboard,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: true,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  const msg = input.userMessage.toLowerCase().trim();
  const wm = context.workingMemory;

  // Working memory: pending action (email draft, calendar update/delete) + affirmative response -> productivity
  if (wm.pendingActions.some(a => ['email_draft', 'draft', 'calendar_update', 'calendar_delete', 'calendar_create'].includes(a.type)) &&
      /\b(yes|yep|yeah|sure|send it|go ahead|do it|looks good|perfect|lgtm|book it|confirm)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: AGENT_NAMESPACES.productivity,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.95,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Contact intent — fast-path to productivity
  if (/\b(contacts?|phone\s*number|address\s*book|find\s+(contact|number|email))\b/i.test(msg) ||
      /\b\w+'?s?\s+(email|phone|number|contact\s*(info|details|card)?)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: AGENT_NAMESPACES.productivity,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Email intent — fast-path to productivity
  if (/\b(email|inbox|draft|send\s+(an?\s+)?email|outlook|gmail)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: AGENT_NAMESPACES.productivity,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Meeting prep intent — fast-path to meeting_prep (must be checked BEFORE general calendar)
  if (/\b(prep(are)?( me)?( for)?|brief me|get (me )?ready for|what do i need to know (for|about)|meeting prep|help me prepare|what should i say( first)?|how should i handle|how do i sound prepared|give me the (20|30)[-\s]?second|quick brief|full brief)\b/i.test(msg) && /\b(meeting|call|standup|sync|catch ?up|review|1[:\-]1|one.on.one|appointment|session|interview|chat with|arriving)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'meeting_prep',
      allowedNamespaces: AGENT_NAMESPACES.meeting_prep,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.95,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Calendar intent — fast-path to productivity
  if (/\b(calendar|schedule|diary|my meetings|my events|what('s| is| do i have) on|when am i free|free time|book a meeting|schedule a|reschedule|cancel\b.*\b(meeting|event|appointment)|cancel (my |the )?(meeting|event|appointment)|move my|what's next|upcoming meetings)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: AGENT_NAMESPACES.productivity,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Explicit recall intent
  if (/\b(what do you (know|remember)|recall|my memories?|do you know my)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'recall',
      allowedNamespaces: AGENT_NAMESPACES.recall,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.85,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // Research intent — broad catch for factual/lookup questions
  const isResearchPhrase = /\b(search|look\s+\w*\s*up|find out|what is|what are|what was|who is|who are|who was|when did|when was|when is|how does|how do|how did|how much|how many|how far|where is|where are|where did|why does|why did|why is|why are|latest news|tell me about|explain|is it true)\b/i.test(msg);
  const isLookupCommand = /\b(look it up|google|search for|search that)\b/i.test(msg);
  if (isResearchPhrase || isLookupCommand) {
    return {
      mode: 'single_agent',
      agent: 'research',
      allowedNamespaces: AGENT_NAMESPACES.research,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: true,
      userStyle: 'normal',
      confidence: 0.75,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Layer 2: LLM-based structured router
// ═══════════════════════════════════════════════════════════════

const ROUTER_SYSTEM = `You are a routing classifier for Nest, a personal assistant. Given the user's message and recent conversation context, decide which agent should handle it.

Agents:
- casual: General chat, emotional support, banter, personal questions, life advice, creative writing. Only use for purely personal/emotional messages with NO real-world topic (news, events, facts, places, people in the news, etc.).
- productivity: Email, calendar, scheduling, task management, reminders, drafting messages
- research: Factual questions, current events, news, looking things up, "why" questions about the world, comparisons, analysis, anything requiring real-time or web knowledge. If the user asks about ANYTHING that requires knowledge beyond personal context (e.g. geopolitics, science, sports, weather, prices, people, places, history), route to research. If the user says "look it up", "search", "google it", or similar, ALWAYS route to research.
- recall: Questions about what Nest knows/remembers about the user, memory retrieval
- operator: Complex multi-step tasks requiring multiple tools, cross-domain requests
- meeting_prep: Preparing for a specific meeting — understanding why it matters, what changed, what others likely want, what to say, what to decide, and what to watch out for

IMPORTANT: When in doubt between casual and research, prefer research. Nest can always search the web, so factual questions should never be declined. Even if the message is conversational in tone (e.g. "its interesting that X is happening isn't it", "crazy what's going on in Y", "did you hear about Z"), if it references real-world events, news, or facts, route to research — not casual.

Respond with valid JSON only:
{
  "agent": "casual" | "productivity" | "research" | "recall" | "operator" | "meeting_prep",
  "confidence": 0.0-1.0,
  "needs_memory_read": boolean,
  "needs_memory_write_candidate": boolean,
  "needs_web_freshness": boolean,
  "user_style": "brief" | "normal" | "deep"
}`;

function buildRouterMessages(input: TurnInput, context: RouterContext): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  const contextParts: string[] = [];

  if (context.recentTurns.length > 0) {
    const turnSummary = context.recentTurns
      .slice(-3)
      .map((t) => `${t.role}: ${t.content.substring(0, 100)}`)
      .join('\n');
    contextParts.push(`Recent conversation:\n${turnSummary}`);
  }

  const wm = context.workingMemory;
  if (wm.activeTopics.length > 0) {
    contextParts.push(`Active topics: ${wm.activeTopics.join(', ')}`);
  }
  if (wm.pendingActions.length > 0) {
    contextParts.push(`Pending actions: ${wm.pendingActions.map(a => a.description).join(', ')}`);
  }

  if (contextParts.length > 0) {
    messages.push({
      role: 'user',
      content: contextParts.join('\n\n'),
    });
    messages.push({
      role: 'assistant',
      content: 'Understood. I will consider this context when routing.',
    });
  }

  messages.push({
    role: 'user',
    content: `Route this message: "${input.userMessage.substring(0, 300)}"`,
  });

  return messages;
}

interface RouterResponse {
  agent: AgentName;
  confidence: number;
  needs_memory_read: boolean;
  needs_memory_write_candidate: boolean;
  needs_web_freshness: boolean;
  user_style: UserStyle;
}

async function llmRoute(input: TurnInput, context: RouterContext): Promise<RouteDecision> {
  const start = Date.now();
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: ROUTER_SYSTEM,
      messages: buildRouterMessages(input, context),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed: RouterResponse = JSON.parse(text);
    const agent = parsed.agent as AgentName;
    const latency = Date.now() - start;

    return {
      mode: 'single_agent',
      agent,
      allowedNamespaces: AGENT_NAMESPACES[agent] || AGENT_NAMESPACES.casual,
      needsMemoryRead: parsed.needs_memory_read ?? true,
      needsMemoryWriteCandidate: parsed.needs_memory_write_candidate ?? false,
      needsWebFreshness: parsed.needs_web_freshness ?? false,
      userStyle: parsed.user_style ?? 'normal',
      confidence: parsed.confidence ?? 0.7,
      fastPathUsed: false,
      routerLatencyMs: latency,
    };
  } catch (err) {
    console.warn('[route-turn] LLM router failed, falling back to casual:', (err as Error).message);
    return fallbackRoute(Date.now() - start);
  }
}

// ═══════════════════════════════════════════════════════════════
// Layer 3: Fallback — casual agent with broad permissions
// ═══════════════════════════════════════════════════════════════

function fallbackRoute(latencyMs: number): RouteDecision {
  return {
    mode: 'single_agent',
    agent: 'casual',
    allowedNamespaces: AGENT_NAMESPACES.casual,
    needsMemoryRead: true,
    needsMemoryWriteCandidate: true,
    needsWebFreshness: false,
    userStyle: 'normal',
    confidence: 0.5,
    fastPathUsed: false,
    routerLatencyMs: latencyMs,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main router — tries each layer in order
// ═══════════════════════════════════════════════════════════════

export async function routeTurn(input: TurnInput, context: RouterContext): Promise<RouteDecision> {
  // Layer 1: Deterministic fast-path
  const fastPath = tryFastPath(input, context);
  if (fastPath) return fastPath;

  // Layer 2: LLM-based structured router
  const llmDecision = await llmRoute(input, context);
  if (llmDecision.confidence >= 0.6) return llmDecision;

  // Layer 3: Fallback
  return fallbackRoute(llmDecision.routerLatencyMs);
}
