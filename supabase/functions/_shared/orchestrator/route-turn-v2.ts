import { classifyConfirmation } from '../ai/models.ts';
import { classifyTurn } from './classify-turn.ts';
import { resolveTools, resolveToolChoice, hasDeepProfile } from './capability-tools.ts';
import type { TurnInput, RouteDecision, AgentName, ToolNamespace, MemoryDepth } from './types.ts';
import type { RouterContext } from './build-context.ts';

const DEEP_PROFILE_ESCAPE = /\b(what do you know about me|tell me (about|everything about) (myself|me)|what have you (learned|figured out) about me|tell me something (interesting|surprising|cool) about me|surprise me with what you know|give me a (summary|rundown|profile) of (everything you know|what you know)|how well do you (know|understand) me|what('s| is) my profile|paint a picture of me|describe me based on what you know)\b/i;

// ═══════════════════════════════════════════════════════════════
// Layer 0A: Pending action resolution (deterministic, no LLM)
// ═══════════════════════════════════════════════════════════════

const OBVIOUS_AFFIRMATIVE = /^(yes|yep|yeah|yea|sure|ok|okay|send|send it|go ahead|do it|confirm|lgtm|looks good|perfect|great|book it|go for it|ship it|fire away|let's go|sure thing|absolutely|definitely|of course|please do)$/i;
const OBVIOUS_NEGATIVE = /^(no|nah|nope|cancel|never ?mind|don't|stop|hold on|wait|not yet|scratch that)$/i;

function tryPendingActionResolution(
  input: TurnInput,
  context: RouterContext,
): RouteDecision | null {
  const hasPendingEmailSend = context.pendingEmailSends.length > 0;
  const wm = context.workingMemory;
  const hasPendingAction = hasPendingEmailSend || wm.pendingActions.some(a =>
    ['calendar_update', 'calendar_delete', 'calendar_create'].includes(a.type)
  );

  if (!hasPendingAction) return null;

  const msg = input.userMessage.trim();
  if (msg.length >= 120) return null;

  const recentAssistantOfferedAction = context.recentTurns.slice(-2).some(t =>
    t.role === 'assistant' && (
      /\b(draft|drafted|shall i send|want me to send|should i send|would you like me to send|do you want me to send|send this to|send this brief|send it to|send that to|forward this|forward it)\b/i.test(t.content)
      || /\[email_draft\]/.test(t.content)
    )
  );

  if (!hasPendingAction && !recentAssistantOfferedAction) return null;

  const lower = msg.toLowerCase();

  if (OBVIOUS_AFFIRMATIVE.test(lower)) {
    const domain = hasPendingEmailSend ? 'email' : 'calendar';
    const namespaces: ToolNamespace[] = hasPendingEmailSend
      ? ['email.read', 'email.write', 'contacts.read', 'memory.read', 'messaging.react']
      : ['calendar.read', 'calendar.write', 'contacts.read', 'memory.read', 'messaging.react'];

    return {
      mode: 'single_agent',
      agent: 'smart',
      allowedNamespaces: namespaces,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.95,
      fastPathUsed: true,
      routerLatencyMs: 0,
      confirmationState: 'confirmed',
      primaryDomain: domain,
      memoryDepth: 'none',
      forcedToolChoice: 'required',
      routeLayer: '0A',
    };
  }

  if (OBVIOUS_NEGATIVE.test(lower)) {
    const domain = hasPendingEmailSend ? 'email' : 'calendar';
    const namespaces: ToolNamespace[] = hasPendingEmailSend
      ? ['email.read', 'email.write', 'messaging.react']
      : ['calendar.read', 'calendar.write', 'messaging.react'];

    return {
      mode: 'single_agent',
      agent: 'smart',
      allowedNamespaces: namespaces,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 0.90,
      fastPathUsed: true,
      routerLatencyMs: 0,
      confirmationState: 'not_confirmation',
      primaryDomain: domain,
      memoryDepth: 'none',
      routeLayer: '0A',
    };
  }

  if (hasPendingEmailSend && msg.length < 120) {
    const lastAssistantMsg = context.recentTurns.slice(-2).reverse().find(t => t.role === 'assistant')?.content ?? '';
    return classifyConfirmation(msg, lastAssistantMsg).then(isConfirm => {
      const domain = 'email' as const;
      const namespaces: ToolNamespace[] = ['email.read', 'email.write', 'contacts.read', 'memory.read', 'messaging.react'];
      return {
        mode: 'single_agent' as const,
        agent: 'smart' as AgentName,
        allowedNamespaces: namespaces,
        needsMemoryRead: false,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: 'normal' as const,
        confidence: 0.85,
        fastPathUsed: true,
        routerLatencyMs: 0,
        confirmationState: isConfirm ? 'confirmed' as const : 'not_confirmation' as const,
        primaryDomain: domain,
        memoryDepth: 'none' as MemoryDepth,
        forcedToolChoice: isConfirm ? 'required' : undefined,
        routeLayer: '0A' as const,
      };
    }) as unknown as RouteDecision;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Layer 0B: Deterministic lightweight continuation (no LLM)
// ═══════════════════════════════════════════════════════════════

const CHAT_NAMESPACES: ToolNamespace[] = ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'media.generate', 'web.search'];

const SAFE_CASUAL_EXPANDED = /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;


function tryDeterministicContinuation(
  input: TurnInput,
  context: RouterContext,
): RouteDecision | null {
  if (input.isOnboarding) {
    return {
      mode: 'onboard',
      agent: 'onboard',
      allowedNamespaces: ['memory.read', 'memory.write', 'messaging.react', 'messaging.effect', 'web.search', 'knowledge.search'],
      needsMemoryRead: false,
      needsMemoryWriteCandidate: true,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
      routeLayer: '0B',
    };
  }

  const msg = input.userMessage.trim();

  // Only fast-path the most obviously casual messages: pure greetings,
  // reactions, and single-word acknowledgements with NO conversational
  // context that suggests a pending task. Everything else goes to the
  // LLM classifier which can read the full conversation context.
  const recentModes = context.recentTurns.slice(-4);
  const lastAssistantContent = recentModes.filter(t => t.role === 'assistant').slice(-1)[0]?.content ?? '';

  // If the assistant ended with a question mark, it's likely asking
  // something — let the classifier decide what to do with the user's reply.
  const assistantEndedWithQuestion = /\?\s*(\[[\w_]+\])?\s*$/.test(lastAssistantContent);

  if (assistantEndedWithQuestion) {
    return null;
  }

  // Only intercept pure greetings/reactions that are a complete match
  // (e.g. "hey", "thanks", "lol") AND the message is very short.
  // This saves ~2-3s of classifier latency for trivial messages.
  if (SAFE_CASUAL_EXPANDED.test(msg) && msg.length <= 12) {
    return {
      mode: 'single_agent',
      agent: 'chat',
      allowedNamespaces: CHAT_NAMESPACES,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'brief',
      confidence: 0.99,
      fastPathUsed: true,
      routerLatencyMs: 0,
      primaryDomain: 'general',
      memoryDepth: 'none',
      routeLayer: '0B',
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Layer 0C: LLM Classifier (everything else)
// ═══════════════════════════════════════════════════════════════

async function classifierRoute(input: TurnInput, context: RouterContext): Promise<RouteDecision> {
  const start = Date.now();
  const result = await classifyTurn(input, context);
  const latency = Date.now() - start;

  if (result.mode === 'chat') {
    return {
      mode: 'single_agent',
      agent: 'chat',
      allowedNamespaces: CHAT_NAMESPACES,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: result.style,
      confidence: result.confidence,
      fastPathUsed: false,
      routerLatencyMs: latency,
      classifierResult: result,
      primaryDomain: result.primaryDomain,
      secondaryDomains: result.secondaryDomains,
      memoryDepth: result.memoryDepth,
      routeLayer: '0C',
    };
  }

  const isDeepProfile = hasDeepProfile(result);
  const namespaces = resolveTools(result);
  const toolChoice = resolveToolChoice(result);

  if (isDeepProfile) {
    console.log(`[route-v2] deep_profile detected — upgrading to gpt-5.4 HIGH reasoning, memoryDepth to full`);
  }

  return {
    mode: 'single_agent',
    agent: 'smart',
    allowedNamespaces: namespaces,
    needsMemoryRead: result.memoryDepth !== 'none' || isDeepProfile,
    needsMemoryWriteCandidate: result.requiredCapabilities.includes('memory.write'),
    needsWebFreshness: result.requiredCapabilities.includes('web.search'),
    userStyle: result.style,
    confidence: result.confidence,
    fastPathUsed: false,
    routerLatencyMs: latency,
    classifierResult: result,
    primaryDomain: result.primaryDomain,
    secondaryDomains: result.secondaryDomains,
    memoryDepth: isDeepProfile ? 'full' : result.memoryDepth,
    forcedToolChoice: toolChoice ?? (isDeepProfile ? 'required' : undefined),
    routeLayer: '0C',
    reasoningEffortOverride: isDeepProfile ? 'high' : undefined,
    modelOverride: isDeepProfile ? 'gpt-5.4' : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main v2 router — tries each layer in order
// ═══════════════════════════════════════════════════════════════

export async function routeTurnV2(input: TurnInput, context: RouterContext): Promise<RouteDecision> {
  const layer0A = tryPendingActionResolution(input, context);
  if (layer0A) {
    if (layer0A instanceof Promise) {
      const resolved = await layer0A;
      console.log(`[route-v2] Layer 0A (pending action, async): agent=${resolved.agent}, confirmation=${resolved.confirmationState}`);
      return resolved;
    }
    console.log(`[route-v2] Layer 0A (pending action): agent=${layer0A.agent}, confirmation=${layer0A.confirmationState}`);
    return layer0A;
  }

  const layer0B = tryDeterministicContinuation(input, context);
  if (layer0B) {
    console.log(`[route-v2] Layer 0B (deterministic): agent=${layer0B.agent}`);
    return layer0B;
  }

  const layer0C = await classifierRoute(input, context);
  console.log(`[route-v2] Layer 0C (classifier): agent=${layer0C.agent}, domain=${layer0C.primaryDomain}, latency=${layer0C.routerLatencyMs}ms`);
  return layer0C;
}
