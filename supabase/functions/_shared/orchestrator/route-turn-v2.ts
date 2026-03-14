import { classifyConfirmation } from "../ai/models.ts";
import { classifyTurn } from "./classify-turn.ts";
import {
  hasDeepProfile,
  resolveToolChoice,
  resolveTools,
} from "./capability-tools.ts";
import type {
  AgentName,
  MemoryDepth,
  RouteDecision,
  ToolNamespace,
  TurnInput,
} from "./types.ts";
import type { RouterContext } from "./build-context.ts";

const DEEP_PROFILE_ESCAPE =
  /\b(what do you know about me|tell me (about|everything about) (myself|me)|what have you (learned|figured out) about me|tell me something (interesting|surprising|cool) about me|surprise me with what you know|give me a (summary|rundown|profile) of (everything you know|what you know)|how well do you (know|understand) me|what('s| is) my profile|paint a picture of me|describe me based on what you know)\b/i;

// ═══════════════════════════════════════════════════════════════
// Layer 0A: Pending action resolution (deterministic, no LLM)
// ═══════════════════════════════════════════════════════════════

const OBVIOUS_AFFIRMATIVE =
  /^(yes|yep|yeah|yea|sure|ok|okay|send|send it|go ahead|do it|confirm|lgtm|looks good|perfect|great|book it|go for it|ship it|fire away|let's go|sure thing|absolutely|definitely|of course|please do)$/i;
const OBVIOUS_NEGATIVE =
  /^(no|nah|nope|cancel|never ?mind|don't|stop|hold on|wait|not yet|scratch that)$/i;

function tryPendingActionResolution(
  input: TurnInput,
  context: RouterContext,
): RouteDecision | null {
  const hasPendingEmailSend = context.pendingEmailSends.length > 0;
  const wm = context.workingMemory;
  const hasPendingAction = hasPendingEmailSend ||
    wm.pendingActions.some((a) =>
      ["calendar_update", "calendar_delete", "calendar_create"].includes(a.type)
    );

  if (!hasPendingAction) return null;

  const msg = input.userMessage.trim();
  if (msg.length >= 120) return null;

  const recentAssistantOfferedAction = context.recentTurns.slice(-2).some((t) =>
    t.role === "assistant" && (
      /\b(draft|drafted|shall i send|want me to send|should i send|would you like me to send|do you want me to send|send this to|send this brief|send it to|send that to|forward this|forward it)\b/i
        .test(t.content) ||
      /\[email_draft\]/.test(t.content)
    )
  );

  if (!hasPendingAction && !recentAssistantOfferedAction) return null;

  const lower = msg.toLowerCase();

  if (OBVIOUS_AFFIRMATIVE.test(lower)) {
    const domain = hasPendingEmailSend ? "email" : "calendar";
    const namespaces: ToolNamespace[] = hasPendingEmailSend
      ? [
        "email.read",
        "email.write",
        "contacts.read",
        "memory.read",
        "messaging.react",
      ]
      : [
        "calendar.read",
        "calendar.write",
        "contacts.read",
        "memory.read",
        "messaging.react",
      ];

    return {
      mode: "single_agent",
      agent: "smart",
      allowedNamespaces: namespaces,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: "normal",
      confidence: 0.95,
      fastPathUsed: true,
      routerLatencyMs: 0,
      confirmationState: "confirmed",
      primaryDomain: domain,
      memoryDepth: "none",
      forcedToolChoice: "required",
      routeLayer: "0A",
    };
  }

  if (OBVIOUS_NEGATIVE.test(lower)) {
    const domain = hasPendingEmailSend ? "email" : "calendar";
    const namespaces: ToolNamespace[] = hasPendingEmailSend
      ? ["email.read", "email.write", "messaging.react"]
      : ["calendar.read", "calendar.write", "messaging.react"];

    return {
      mode: "single_agent",
      agent: "smart",
      allowedNamespaces: namespaces,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: "normal",
      confidence: 0.90,
      fastPathUsed: true,
      routerLatencyMs: 0,
      confirmationState: "not_confirmation",
      primaryDomain: domain,
      memoryDepth: "none",
      routeLayer: "0A",
    };
  }

  if (hasPendingEmailSend && msg.length < 120) {
    const lastAssistantMsg = context.recentTurns.slice(-2).reverse().find((t) =>
      t.role === "assistant"
    )?.content ?? "";
    return classifyConfirmation(msg, lastAssistantMsg).then((isConfirm) => {
      const domain = "email" as const;
      const namespaces: ToolNamespace[] = [
        "email.read",
        "email.write",
        "contacts.read",
        "memory.read",
        "messaging.react",
      ];
      return {
        mode: "single_agent" as const,
        agent: "smart" as AgentName,
        allowedNamespaces: namespaces,
        needsMemoryRead: false,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: "normal" as const,
        confidence: 0.85,
        fastPathUsed: true,
        routerLatencyMs: 0,
        confirmationState: isConfirm
          ? "confirmed" as const
          : "not_confirmation" as const,
        primaryDomain: domain,
        memoryDepth: "none" as MemoryDepth,
        forcedToolChoice: isConfirm ? "required" : undefined,
        routeLayer: "0A" as const,
      };
    }) as unknown as RouteDecision;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Layer 0B: 3-Lane Deterministic Pre-Router (no LLM)
//
// Lane 1 — Instant Casual: greetings, reactions, acknowledgements
// Lane 2 — Fast Knowledge: static informational / creative questions
// Lane 3 — Classifier: personal, current, local, actionable, ambiguous
//
// The classifier is the exception path, not the default path.
// ═══════════════════════════════════════════════════════════════

const CHAT_NAMESPACES: ToolNamespace[] = [
  "memory.read",
  "memory.write",
  "messaging.react",
  "messaging.effect",
  "media.generate",
  "web.search",
];

const LANE2_NAMESPACES: ToolNamespace[] = [
  "messaging.react",
  "messaging.effect",
];

const SAFE_CASUAL_EXPANDED =
  /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|perfect|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;
const DAYPART_GREETING =
  /^(good\s+)?(morning|afternoon|evening|night)[!.?]*$|^(gm|gn)[!.?]*$/i;

// ── Disqualifier buckets ──────────────────────────────────────
// If ANY bucket matches, the message goes to Lane 3 (classifier).

const PERSONAL_SYSTEM_NOUNS =
  /\b(inbox|calendar|schedule|emails?|gmail|outlook|contacts?|messages?|account|granola)\b/i;

const WORKFLOW_VERBS =
  /\b(send|draft|book|remind|schedule|cancel|delete|create|update|forward|compose|set up|arrange)\b/i;

const TEMPORAL_SIGNALS =
  /\b(today|tomorrow|tonight|yesterday|this week|next week|this weekend|right now|currently|latest|current|open now)\b/i;

const EXPLICIT_TIME =
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

const LOCAL_OR_TRAVEL =
  /\b(near me|nearest|directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|open now|walk to|drive to|cycle to|train from .{1,40} to|flight from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to)\b/i;

const HIDDEN_PERSONAL =
  /\b(what'?s on tomorrow|what'?s on today|any emails|any unread|did [A-Z][a-z]+ reply|did [A-Z][a-z]+ respond|free after|busy at|available at|what'?s in my)\b/i;

type DisqualifierBucket =
  | 'personal_system_nouns'
  | 'workflow_verbs'
  | 'temporal_signals'
  | 'explicit_time'
  | 'local_or_travel'
  | 'hidden_personal';

function matchedDisqualifier(message: string): DisqualifierBucket | null {
  if (PERSONAL_SYSTEM_NOUNS.test(message)) return 'personal_system_nouns';
  if (WORKFLOW_VERBS.test(message)) return 'workflow_verbs';
  if (TEMPORAL_SIGNALS.test(message)) return 'temporal_signals';
  if (EXPLICIT_TIME.test(message)) return 'explicit_time';
  if (LOCAL_OR_TRAVEL.test(message)) return 'local_or_travel';
  if (HIDDEN_PERSONAL.test(message)) return 'hidden_personal';
  return null;
}

// ── Pending state detection ───────────────────────────────────

function hasPendingState(context: RouterContext): boolean {
  const wm = context.workingMemory;
  return (
    context.pendingEmailSends.length > 0 ||
    (wm.pendingActions?.length ?? 0) > 0 ||
    (wm.unresolvedReferences?.length ?? 0) > 0 ||
    wm.awaitingConfirmation === true ||
    wm.awaitingChoice === true ||
    wm.awaitingMissingParameter === true
  );
}

function lastAssistantUsedTools(context: RouterContext): boolean {
  const lastAssistant = context.recentTurns
    .filter((t) => t.role === "assistant")
    .slice(-1)[0]?.content ?? "";
  return /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search)\]/.test(lastAssistant);
}

// ── Safe casual detection ─────────────────────────────────────

function isSafeCasual(message: string): boolean {
  if (message.length > 16) return false;
  return SAFE_CASUAL_EXPANDED.test(message) || DAYPART_GREETING.test(message);
}

// ── Main 3-lane pre-router ────────────────────────────────────

function tryDeterministicContinuation(
  input: TurnInput,
  context: RouterContext,
): RouteDecision | null {
  // Onboarding always gets its own agent
  if (input.isOnboarding) {
    return {
      mode: "onboard",
      agent: "onboard",
      allowedNamespaces: [
        "memory.read",
        "memory.write",
        "messaging.react",
        "messaging.effect",
        "web.search",
        "knowledge.search",
      ],
      needsMemoryRead: false,
      needsMemoryWriteCandidate: true,
      needsWebFreshness: false,
      userStyle: "normal",
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
      routeLayer: "0B-casual",
      routeReason: "onboarding",
      hadPendingState: false,
      matchedDisqualifierBucket: null,
    };
  }

  const msg = input.userMessage.trim().replace(/\s+/g, ' ');

  // Step 0: Pending state check
  const pending = hasPendingState(context);
  const toolsInLastTurn = lastAssistantUsedTools(context);

  if (pending || toolsInLastTurn) {
    return null; // → Lane 3 (classifier)
  }

  // Step 1: Disqualifier detection
  const disqualifier = matchedDisqualifier(msg);
  if (disqualifier) {
    return null; // → Lane 3 (classifier)
  }

  // Step 2: Lane 1 vs Lane 2

  // Lane 1: Instant Casual
  if (isSafeCasual(msg)) {
    const isDaypart = DAYPART_GREETING.test(msg);
    return {
      mode: "single_agent",
      agent: "chat",
      allowedNamespaces: isDaypart ? CHAT_NAMESPACES : CHAT_NAMESPACES,
      needsMemoryRead: isDaypart,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: "brief",
      confidence: 0.99,
      fastPathUsed: true,
      routerLatencyMs: 0,
      primaryDomain: "general",
      memoryDepth: isDaypart ? "light" : "none",
      routeLayer: "0B-casual",
      routeReason: isDaypart ? "daypart_greeting" : "safe_casual",
      hadPendingState: false,
      matchedDisqualifierBucket: null,
    };
  }

  // Lane 2: Fast Static Knowledge (default for everything not disqualified)
  return {
    mode: "single_agent",
    agent: "chat",
    allowedNamespaces: LANE2_NAMESPACES,
    needsMemoryRead: false,
    needsMemoryWriteCandidate: false,
    needsWebFreshness: false,
    userStyle: "normal",
    confidence: 0.90,
    fastPathUsed: true,
    routerLatencyMs: 0,
    primaryDomain: "general",
    memoryDepth: "none",
    routeLayer: "0B-knowledge",
    routeReason: "static_knowledge_default",
    hadPendingState: false,
    matchedDisqualifierBucket: null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Layer 0C: LLM Classifier (everything else)
// ═══════════════════════════════════════════════════════════════

async function classifierRoute(
  input: TurnInput,
  context: RouterContext,
): Promise<RouteDecision> {
  const start = Date.now();
  const result = await classifyTurn(input, context);
  const latency = Date.now() - start;

  if (result.mode === "chat") {
    return {
      mode: "single_agent",
      agent: "chat",
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
      routeLayer: "0C",
    };
  }

  const isDeepProfile = hasDeepProfile(result);
  const namespaces = resolveTools(result);
  const toolChoice = resolveToolChoice(result);

  if (isDeepProfile) {
    console.log(
      `[route-v2] deep_profile detected — upgrading to gpt-5.4 HIGH reasoning, memoryDepth to full`,
    );
  }

  return {
    mode: "single_agent",
    agent: "smart",
    allowedNamespaces: namespaces,
    needsMemoryRead: result.memoryDepth !== "none" || isDeepProfile,
    needsMemoryWriteCandidate: result.requiredCapabilities.includes(
      "memory.write",
    ),
    needsWebFreshness: result.requiredCapabilities.includes("web.search"),
    userStyle: result.style,
    confidence: result.confidence,
    fastPathUsed: false,
    routerLatencyMs: latency,
    classifierResult: result,
    primaryDomain: result.primaryDomain,
    secondaryDomains: result.secondaryDomains,
    memoryDepth: isDeepProfile ? "full" : result.memoryDepth,
    forcedToolChoice: toolChoice ?? (isDeepProfile ? "required" : undefined),
    routeLayer: "0C",
    reasoningEffortOverride: isDeepProfile ? "high" : undefined,
    modelOverride: isDeepProfile ? "gpt-5.4" : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main v2 router — tries each layer in order
// ═══════════════════════════════════════════════════════════════

export async function routeTurnV2(
  input: TurnInput,
  context: RouterContext,
): Promise<RouteDecision> {
  const layer0A = tryPendingActionResolution(input, context);
  if (layer0A) {
    if (layer0A instanceof Promise) {
      const resolved = await layer0A;
      console.log(
        `[route-v2] Layer 0A (pending action, async): agent=${resolved.agent}, confirmation=${resolved.confirmationState}`,
      );
      return resolved;
    }
    console.log(
      `[route-v2] Layer 0A (pending action): agent=${layer0A.agent}, confirmation=${layer0A.confirmationState}`,
    );
    return layer0A;
  }

  // Pre-compute pending state and disqualifier for telemetry
  const msg = input.userMessage.trim().replace(/\s+/g, ' ');
  const pending = hasPendingState(context);
  const toolsInLastTurn = lastAssistantUsedTools(context);
  const disqualifier = matchedDisqualifier(msg);

  const layer0B = tryDeterministicContinuation(input, context);
  if (layer0B) {
    console.log(`[route-v2] Layer ${layer0B.routeLayer} (deterministic): agent=${layer0B.agent}, reason=${layer0B.routeReason}`);
    return layer0B;
  }

  // Layer 0B returned null → classifier needed
  const classifierReason = pending
    ? 'pending_state'
    : toolsInLastTurn
    ? 'tools_in_last_turn'
    : disqualifier
    ? `disqualifier:${disqualifier}`
    : 'unknown';

  const layer0C = await classifierRoute(input, context);
  layer0C.hadPendingState = pending;
  layer0C.matchedDisqualifierBucket = disqualifier;
  layer0C.routeReason = classifierReason;

  console.log(
    `[route-v2] Layer 0C (classifier): agent=${layer0C.agent}, domain=${layer0C.primaryDomain}, reason=${classifierReason}, latency=${layer0C.routerLatencyMs}ms`,
  );
  return layer0C;
}
