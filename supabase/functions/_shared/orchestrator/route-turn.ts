/**
 * @deprecated — Legacy router. Preserved behind OPTION_A_ROUTING feature flag.
 * New routing lives in route-turn-v2.ts (Option A: 2-agent classifier-based architecture).
 * Do not add new features here. Will be removed after production confidence is established.
 */
import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT, classifyConfirmation } from '../ai/models.ts';
import type { TurnInput, RouteDecision, AgentName, ToolNamespace, UserStyle } from './types.ts';
import type { RouterContext } from './build-context.ts';

// ═══════════════════════════════════════════════════════════════
// Agent namespace policies — what each agent is allowed to use
// ═══════════════════════════════════════════════════════════════

const AGENT_NAMESPACES: Record<AgentName, ToolNamespace[]> = {
  casual: ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'media.generate', 'web.search'],
  productivity: ['memory.read', 'memory.write', 'email.read', 'email.write', 'calendar.read', 'calendar.write', 'contacts.read', 'granola.read', 'messaging.react', 'messaging.effect', 'web.search'],
  research: ['memory.read', 'web.search', 'knowledge.search', 'contacts.read', 'messaging.react'],
  recall: ['memory.read', 'knowledge.search', 'granola.read', 'messaging.react'],
  operator: ['memory.read', 'memory.write', 'email.read', 'email.write', 'calendar.read', 'calendar.write', 'contacts.read', 'granola.read', 'web.search', 'knowledge.search', 'messaging.react', 'messaging.effect', 'media.generate'],
  onboard: ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'web.search', 'knowledge.search'],
  meeting_prep: ['calendar.read', 'email.read', 'email.write', 'contacts.read', 'granola.read', 'knowledge.search', 'memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'web.search'],
};

const PRODUCTIVITY_READ_ONLY_NAMESPACES: ToolNamespace[] = [
  'memory.read', 'email.read', 'calendar.read', 'contacts.read', 'messaging.react', 'web.search',
];

// ═══════════════════════════════════════════════════════════════
// Layer 0: Instant casual check — runs BEFORE router context fetch
// ═══════════════════════════════════════════════════════════════

// Words that are NEVER confirmations — safe to instant-route without context.
// Excludes: yes, yep, yup, yeah, ok, okay, k, kk, sure, sounds good, no, nah, nope, send, go, do it, perfect, great
// Those ambiguous words go through tryFastPath which checks for pending actions first.
const SAFE_CASUAL_INSTANT = /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|lol|haha|hahaha|lmao|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|\?|!)$/i;
const OBVIOUS_AFFIRMATIVE = /^(yes|yep|yeah|yea|sure|ok|send|send it|go ahead|do it|confirm|lgtm|looks good|perfect|great|book it|go for it|ship it|fire away|let's go)$/i;

// Full set including ambiguous words — used inside tryFastPath AFTER pending action check.
const CASUAL_INSTANT = /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|ok|okay|k|kk|sure|yep|yup|nah|nope|nice|cool|great|awesome|lol|haha|hahaha|lmao|bye|cya|see ya|later|ttyl|yes|no|yeah|na|nah|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|all good|no worries|sounds good|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|\?|!)$/i;

export function tryInstantCasual(input: TurnInput): RouteDecision | null {
  if (input.isOnboarding) return null;
  const msg = input.userMessage.toLowerCase().trim();
  if (SAFE_CASUAL_INSTANT.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'casual',
      allowedNamespaces: AGENT_NAMESPACES.casual,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'brief',
      confidence: 0.99,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Layer 1: Deterministic fast-path rules
// ═══════════════════════════════════════════════════════════════

async function tryFastPath(input: TurnInput, context: RouterContext): Promise<RouteDecision | null> {
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

  // ── Pending action confirmations (MUST run before casual instant) ──
  // Short messages like "yep", "send", "go" look casual but may be confirming a pending action.
  const hasPendingEmailSend = context.pendingEmailSends.length > 0;
  const hasPendingAction = hasPendingEmailSend || wm.pendingActions.some(a => ['calendar_update', 'calendar_delete', 'calendar_create'].includes(a.type));
  const recentAssistantOfferedAction = context.recentTurns.slice(-2).some(t =>
    t.role === 'assistant' && (
      /\b(draft|drafted|shall i send|want me to send|should i send|would you like me to send|do you want me to send|send this to|send this brief|send it to|send that to|forward this|forward it)\b/i.test(t.content)
      || /\[email_draft\]/.test(t.content)
    )
  );
  if ((hasPendingAction || recentAssistantOfferedAction) && msg.length < 120) {
    const lastAssistantMsg = context.recentTurns.slice(-2).reverse().find(t => t.role === 'assistant')?.content ?? '';
    const isConfirm = OBVIOUS_AFFIRMATIVE.test(msg) || await classifyConfirmation(msg, lastAssistantMsg);
    if (isConfirm) {
      return {
        mode: 'single_agent',
        agent: 'productivity',
        allowedNamespaces: AGENT_NAMESPACES.productivity,
        needsMemoryRead: false,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: 'normal',
        confidence: 0.95,
        fastPathUsed: true,
        routerLatencyMs: 0,
        modelTierOverride: 'fast',
        confirmationState: 'confirmed',
      };
    }

    if (hasPendingEmailSend) {
      return {
        mode: 'single_agent',
        agent: 'productivity',
        allowedNamespaces: AGENT_NAMESPACES.productivity,
        needsMemoryRead: true,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: 'normal',
        confidence: 0.85,
        fastPathUsed: true,
        routerLatencyMs: 0,
        confirmationState: 'not_confirmation',
      };
    }
  }

  // ── Follow-up after tool-using turn ──
  // When the last assistant message used a tool (tagged [tool_name]) and ended
  // with a follow-up question, short affirmatives like "Yep" should route back
  // to the same domain agent — not to casual, which would hallucinate.
  const TOOL_TAG_RE = /\[(granola_read|calendar_read|calendar_write|email_read|email_draft|email_send|web_search|knowledge_search|contacts_read)\]/;
  const FOLLOW_UP_QUESTION_RE = /\?\s*(\[.*\])?\s*$/;
  if ((CASUAL_INSTANT.test(msg) || msg.length <= 3) && msg.length < 60) {
    const lastAssistant = context.recentTurns.slice(-2).reverse().find(t => t.role === 'assistant');
    if (lastAssistant) {
      const toolMatch = lastAssistant.content.match(TOOL_TAG_RE);
      const askedFollowUp = FOLLOW_UP_QUESTION_RE.test(lastAssistant.content);
      if (toolMatch && askedFollowUp) {
        const toolUsed = toolMatch[1];
        const agentForTool: AgentName =
          /^(granola_read)$/.test(toolUsed) ? 'meeting_prep' :
          /^(calendar_read|calendar_write|email_read|email_draft|email_send|contacts_read)$/.test(toolUsed) ? 'productivity' :
          /^(web_search)$/.test(toolUsed) ? 'research' :
          /^(knowledge_search)$/.test(toolUsed) ? 'recall' :
          'casual';
        if (agentForTool !== 'casual') {
          console.log(`[route-turn] follow-up after [${toolUsed}] → ${agentForTool} (msg: "${msg}")`);
          return {
            mode: 'single_agent',
            agent: agentForTool,
            allowedNamespaces: AGENT_NAMESPACES[agentForTool],
            needsMemoryRead: true,
            needsMemoryWriteCandidate: false,
            needsWebFreshness: agentForTool === 'research',
            userStyle: 'normal',
            confidence: 0.9,
            fastPathUsed: true,
            routerLatencyMs: 0,
          };
        }
      }
    }
  }

  // ── Broader follow-up: meeting/Granola context continuation ──
  // If the recent conversation used granola_read (within last 3 turns) and the
  // new message references a meeting, call, or asks about content from a meeting,
  // route back to meeting_prep regardless of message length.
  // This catches messages like "what about the 7pm meeting?" or "and the standup?"
  // that aren't short enough for the above check.
  const MEETING_WORD_RE = /\b(meeting|call|sync|standup|catch ?up|review|1[:\-]1|one.on.one|brief|notes?)\b/i;
  const MEETING_FOLLOW_UP_PHRASE_RE = /\b(what about|how about|and the|and what about|anything from|any notes|what was that)\b/i;
  if (MEETING_WORD_RE.test(msg) || (MEETING_FOLLOW_UP_PHRASE_RE.test(msg) && /\b(\d{1,2}\s*(pm|am)|tonight|today|this morning|earlier|last|that)\b/i.test(msg))) {
    const recentAssistants = context.recentTurns.slice(-4).filter(t => t.role === 'assistant');
    const recentUsedGranola = recentAssistants.some(t => /\[granola_read\]/.test(t.content));
    if (recentUsedGranola) {
      console.log(`[route-turn] meeting context follow-up after granola_read → meeting_prep (msg: "${msg}")`);
      return {
        mode: 'single_agent',
        agent: 'meeting_prep',
        allowedNamespaces: AGENT_NAMESPACES.meeting_prep,
        needsMemoryRead: true,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: 'normal',
        confidence: 0.92,
        fastPathUsed: true,
        routerLatencyMs: 0,
      };
    }
  }

  // ── Acknowledgements / ultra-short casual (skip LLM entirely) ──
  if (CASUAL_INSTANT.test(msg) || msg.length <= 3) {
    return {
      mode: 'single_agent',
      agent: 'casual',
      allowedNamespaces: AGENT_NAMESPACES.casual,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'brief',
      confidence: 0.99,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // ── Meeting prep (must be BEFORE calendar/productivity) ──
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

  // ── "Prep me for all my meetings" (meeting_prep even without explicit "meeting" keyword nearby) ──
  if (/\b(prep me|brief me|prepare me)\b/i.test(msg) && /\b(today|tomorrow|this week|next)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'meeting_prep',
      allowedNamespaces: AGENT_NAMESPACES.meeting_prep,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // ── Email (must be BEFORE research — "check my latest emails" has "latest") ──
  const isEmailQuery = /\b(email|emails|inbox|draft|send\s+(an?\s+)?email|outlook|gmail|unread)\b/i.test(msg);
  const hasRecipientAddress = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/.test(msg);
  const hasSendToIntent = hasRecipientAddress && /\b(send|draft|email|forward|mail)\b/i.test(msg);
  if (isEmailQuery || hasSendToIntent) {
    const isEmailWrite = /\b(draft|send|write\s+(an?\s+)?email|reply|respond|forward|compose)\b/i.test(msg) || hasSendToIntent;
    const needsResearch = /\b(summar|research|look up|find out|latest|news|search)\b/i.test(msg);
    if (needsResearch) {
      return {
        mode: 'single_agent',
        agent: 'operator',
        allowedNamespaces: AGENT_NAMESPACES.operator,
        needsMemoryRead: true,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: true,
        userStyle: 'normal',
        confidence: 0.9,
        fastPathUsed: true,
        routerLatencyMs: 0,
      };
    }
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: isEmailWrite ? AGENT_NAMESPACES.productivity : PRODUCTIVITY_READ_ONLY_NAMESPACES,
      needsMemoryRead: isEmailWrite,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
      ...(!isEmailWrite ? { modelTierOverride: 'fast' as const } : {}),
    };
  }

  // ── Calendar (must be BEFORE research — "what's on my calendar" has "what's") ──
  const isCalendarQuery = /\b(calendar|schedule|diary|my meetings|my events|what('s| is| do i have) on|when am i free|free time|book a meeting|schedule a|reschedule|cancel\b.*\b(meeting|event|appointment)|cancel (my |the )?(meeting|event|appointment)|move my|what's next|upcoming meetings|what meetings|any meetings|meetings? (today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday))\b/i.test(msg);
  if (isCalendarQuery) {
    const isCalendarWrite = /\b(book|schedule|create|set up|reschedule|cancel|delete|remove|move|update|change|add)\b/i.test(msg);
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: isCalendarWrite ? AGENT_NAMESPACES.productivity : PRODUCTIVITY_READ_ONLY_NAMESPACES,
      needsMemoryRead: isCalendarWrite,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
      ...(!isCalendarWrite ? { modelTierOverride: 'fast' as const } : {}),
    };
  }

  // ── Connect Granola (must be BEFORE general granola route) ──
  if (/\b(connect|link|set ?up|add|enable|auth|sign ?in)\b/i.test(msg) && /\bgranola\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'casual',
      allowedNamespaces: AGENT_NAMESPACES.casual,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.95,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // ── Granola / meeting notes ──
  if (/\b(granola|meeting\s*notes?|meeting\s*transcript|what (was|were|did \w+( and i)?|did we) (discuss(ed)?|chat(ted)? about|talk(ed)? about|spo?ke about|go(ne)? over|cover(ed)?|say|said|decide[d]?|agree[d]?( on)?)|action\s*items?\s*(from|after|came out of)|decisions?\s*(from|in|were made in)\s*(the|my|our|last|recent)|notes?\s*(from|about)\s*((the|my|our|last|recent)\s*)+(meeting|call|sync|standup))\b/i.test(msg) ||
      (/\b(chat(ted)?|talk(ed)?|discuss(ed)?|spoke|went over|cover(ed)?)\b/i.test(msg) && /\b(in|about|during|from)\b/i.test(msg) && /\b(1[:\-]1|one.on.one|meeting|call|sync|standup|catch ?up|review)\b/i.test(msg)) ||
      (/\b(main\s*points?|key\s*(points?|takeaways?)|highlights?|summary|recap)\b/i.test(msg) && /\b(meeting|call|sync|standup|catch ?up|review|1[:\-]1|one.on.one)\b/i.test(msg))) {
    return {
      mode: 'single_agent',
      agent: 'meeting_prep',
      allowedNamespaces: AGENT_NAMESPACES.meeting_prep,
      needsMemoryRead: true,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
    };
  }

  // ── Contacts (always read-only — fast tier) ──
  if (/\b(contacts?|phone\s*number|address\s*book|find\s+(contact|number|email))\b/i.test(msg) ||
      /\b\w+'?s?\s+(email|phone|number|contact\s*(info|details|card)?)\b/i.test(msg)) {
    return {
      mode: 'single_agent',
      agent: 'productivity',
      allowedNamespaces: PRODUCTIVITY_READ_ONLY_NAMESPACES,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.9,
      fastPathUsed: true,
      routerLatencyMs: 0,
      modelTierOverride: 'fast' as const,
    };
  }

  // ── Recall — personal memory retrieval (must be BEFORE research) ──
  const isPersonalRecall =
    /\b(what do you (know|remember)|recall|my memories?|do you know my)\b/i.test(msg) ||
    /\b(what (are|is) my)\s+(food|travel|music|movie|film|book|coffee|car|work|job|interest|preference|plan|hobby|favourite|favorite)/i.test(msg) ||
    /\b(what did (i|we) (discuss|talk|say|mention)|do you remember)\b/i.test(msg) ||
    /\b(things? to do with|what('s| is) (up|happening) with)\b.*\b(tap|azupay|blacklane|nest)\b/i.test(msg) ||
    /\bwhat did i\b/i.test(msg);
  if (isPersonalRecall) {
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

  // ── Research / web lookup (LAST among specific agents) ──
  const isLookupCommand = /\b(look it up|google|search for|search that|use (the )?(internet|web)|look online|check online|search online|web search|go online)\b/i.test(msg);
  const isResearchPhrase = /\b(search|look\s+\w*\s*up|find out|who is|who are|who was|when did|when was|when is|how does|how do|how did|how much|how many|how far|where is|where are|where did|why does|why did|why is|why are|tell me about|explain|is it true|current|update on|news about|what happened|what's happening|give me.{0,20}(history|overview|summary|rundown|breakdown|facts))\b/i.test(msg);
  const isWorldKnowledge = /\b(latest|news|weather|stock|market|price|president|minister|country|war|conflict|election|sport|score|result|compare|vs|versus|history of|history on)\b/i.test(msg);
  const hasPersonalContext = /\b(my|i|we|our)\b/i.test(msg) || /\b(email|calendar|meeting|remember|memory|told you|said|discuss|talked|mentioned|preference|favourite|favorite)\b/i.test(msg);
  if (isLookupCommand || isResearchPhrase || isWorldKnowledge) {
    return {
      mode: 'single_agent',
      agent: 'research',
      allowedNamespaces: AGENT_NAMESPACES.research,
      needsMemoryRead: hasPersonalContext,
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
// Layer 2: LLM-based structured router (OpenAI Responses API)
// ═══════════════════════════════════════════════════════════════

const ROUTER_INSTRUCTIONS = `You are a routing classifier for Nest, a personal assistant. Given the user's message and recent conversation context, decide which agent should handle it.

Agents:
- casual: General chat, emotional support, banter, personal questions, life advice, creative writing. Also handles account connection requests (e.g. "connect my granola", "link my account") and their follow-ups. Only use for purely personal/emotional messages with NO real-world topic (news, events, facts, places, people in the news, etc.), OR for account connection flows.
- productivity: Email, calendar, scheduling, task management, reminders, drafting messages
- research: Factual questions, current events, news, looking things up, "why" questions about the world, comparisons, analysis, anything requiring real-time or web knowledge. If the user asks about ANYTHING that requires knowledge beyond personal context (e.g. geopolitics, science, sports, weather, prices, people, places, history), route to research. If the user says "look it up", "search", "google it", or similar, ALWAYS route to research.
- recall: Questions about what Nest knows/remembers about the user, memory retrieval
- operator: Complex multi-step tasks requiring multiple tools, cross-domain requests
- meeting_prep: Preparing for a specific meeting — understanding why it matters, what changed, what others likely want, what to say, what to decide, and what to watch out for. Also handles questions about meeting notes, transcripts, action items from meetings, Granola meeting data, AND any question about what was discussed/chatted about/talked about/covered in a meeting, call, 1:1, sync, or standup. If the user asks "what did [person] and I chat/talk/discuss about in our [meeting/1:1/call]", route to meeting_prep, NOT recall.

IMPORTANT: When in doubt between casual and research, prefer research.
IMPORTANT: If the user is asking about a meeting, call, 1:1, or what was discussed/covered in any meeting, ALWAYS route to meeting_prep. NEVER route meeting content questions to research or recall. This includes follow-up questions like "what about the 7pm meeting?" or "and the standup?" when the recent conversation was about meeting notes.

Respond with valid JSON only:
{"agent":"casual"|"productivity"|"research"|"recall"|"operator"|"meeting_prep","confidence":0.0-1.0,"needs_memory_read":boolean,"needs_memory_write_candidate":boolean,"needs_web_freshness":boolean,"user_style":"brief"|"normal"|"deep"}`;

function buildRouterInput(input: TurnInput, context: RouterContext): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

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
    messages.push({ role: 'user', content: contextParts.join('\n\n') });
    messages.push({ role: 'assistant', content: 'Understood. I will consider this context when routing.' });
  }

  messages.push({ role: 'user', content: `Route this message: "${input.userMessage.substring(0, 300)}"` });

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
  const client = getOpenAIClient();

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: ROUTER_INSTRUCTIONS,
      input: buildRouterInput(input, context),
      max_output_tokens: 1024,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
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
    const latency = Date.now() - start;
    console.warn('[route-turn] LLM router failed, falling back to casual:', (err as Error).message);
    return {
      mode: 'single_agent',
      agent: 'casual',
      allowedNamespaces: [...AGENT_NAMESPACES.casual],
      needsMemoryRead: true,
      needsMemoryWriteCandidate: true,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.3,
      fastPathUsed: false,
      routerLatencyMs: latency,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Layer 3: Fallback — use LLM suggestion with web search always on
// ═══════════════════════════════════════════════════════════════

function fallbackRoute(llmDecision: RouteDecision): RouteDecision {
  const baseNamespaces = AGENT_NAMESPACES[llmDecision.agent] || AGENT_NAMESPACES.casual;
  const nsSet = new Set(baseNamespaces);
  nsSet.add('web.search');
  return {
    ...llmDecision,
    allowedNamespaces: [...nsSet] as ToolNamespace[],
    confidence: llmDecision.confidence,
    fastPathUsed: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main router — tries each layer in order
// ═══════════════════════════════════════════════════════════════

export async function routeTurn(input: TurnInput, context: RouterContext): Promise<RouteDecision> {
  const fastPath = await tryFastPath(input, context);
  if (fastPath) return fastPath;

  const llmDecision = await llmRoute(input, context);
  if (llmDecision.confidence >= 0.6) return llmDecision;

  console.log(`[route-turn] low confidence (${llmDecision.confidence}), using LLM suggestion '${llmDecision.agent}' with web.search guaranteed`);
  return fallbackRoute(llmDecision);
}
