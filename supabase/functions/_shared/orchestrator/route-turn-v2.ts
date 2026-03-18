import { classifyConfirmation } from "../ai/models.ts";
import { classifyTurn } from "./classify-turn.ts";
import {
  getBaseToolsForDomain,
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
      if (!isConfirm) {
        console.log(`[route-v2] Layer 0A: "${msg.substring(0, 60)}" is not a confirmation — falling through to normal routing`);
        return null;
      }
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
        confirmationState: "confirmed" as const,
        primaryDomain: domain,
        memoryDepth: "none" as MemoryDepth,
        forcedToolChoice: "required",
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
  "knowledge.search",
  "memory.read",
];

const SAFE_CASUAL_EXPANDED =
  /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|perfect|amazing|wow|damn|omg|wtf|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;
const DAYPART_GREETING =
  /^(good\s+)?(morning|afternoon|evening|night)[!.?]*$|^(gm|gn)[!.?]*$/i;

// ── Disqualifier buckets ──────────────────────────────────────
// If ANY bucket matches, the message goes to Lane 3 (classifier).

const PERSONAL_SYSTEM_NOUNS =
  /\b(inbox|calendar|schedule|emails?|gmail|outlook|contacts?|messages?|account|granola|meetings?)\b/i;

const WORKFLOW_VERBS =
  /\b(send|draft|book|remind|schedule|cancel|delete|create|update|forward|compose|set up|arrange|prepare|prep|respond|reply)\b/i;

const TEMPORAL_SIGNALS =
  /\b(today|tomorrow|tonight|yesterday|last night|last weekend|on the weekend|this week|next week|next month|this weekend|right now|currently|latest|current|open now|later today|later tonight|this morning|this afternoon|this evening|this arvo|at the moment|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// "from X to today", "until today", "through today" etc. are historical range
// phrases in knowledge questions, not scheduling intent.
const TEMPORAL_RANGE_OVERRIDE = /\b(from .{1,50} to today|until today|through today|to the present|to today)\b/i;

const EXPLICIT_TIME =
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

const LOCAL_OR_TRAVEL =
  /\b(near me|near \w{2,}|nearest|directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|open now|walk to|drive to|cycle to|going to .{1,40}(street|st|road|rd|ave|avenue|blvd|boulevard|drive|dr|place|pl|lane|ln|way|crescent|cr|parade|pde|club|hotel|station|uni|university|hospital|airport|park|gardens?|square|mall|centre|center|tower|house)|heading to .{1,40}(street|st|road|rd|club|hotel|station|airport|park)|train from .{1,40} to|flight from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to)/i;

// Street / address pattern — catches messages that contain explicit street names
// or suburb-level location references (e.g. "Collins Street", "East Melbourne").
// Used as a secondary travel signal when combined with directional words.
const ADDRESS_PATTERN =
  /\b\d{0,5}\s?\w+\s(street|st|road|rd|ave|avenue|blvd|boulevard|drive|dr|place|pl|lane|ln|way|crescent|cr|parade|pde|highway|hwy|circuit|ct)\b/i;
const DIRECTIONAL_TRAVEL =
  /\b(to|from|going|heading|getting|walking|driving|cycling|commute)\b/i;

const EVENT_TIME_QUERY =
  /\b(what time|when does|when is|when'?s|what time'?s|what day is|who'?s playing|who won|what'?s the score|what'?s on at|kick'?s? off|bounce|first ball|starts? at|line-?up|team sheet|fixture)\b/i;

const WEATHER_PRICE_LIVE =
  /\b(weather|forecast|rain(ing)?|temperature|degrees|humid|cold .{0,10}outside|hot .{0,10}outside|warm .{0,10}outside|freezing|sunny|cloudy|storm|snow(ing)?|stock|shares?|share price|price of|how much does .{1,30} cost|how much is .{1,20} worth|bitcoin|crypto|btc|eth|asx|nasdaq|dow jones|exchange rate|interest rate)\b/i;

const NEWS_CURRENT =
  /\b(news about|any news|what happened with|what'?s going on with|what'?s happening|latest on|update on|updates? about|breaking)\b/i;

const LOOKUP_VERBS =
  /\b(look up|find|search for|check on|check if|check the|check internet|use internet|use the internet|use web|search the web|search online|google|number for|address of|phone number|contact info|reviews? of|reviews? for|rating for|rated)\b/i;

const LOCATION_INTENT =
  /\b(best .{1,30} in [A-Z][a-z]|good .{1,30} in [A-Z][a-z]|top .{1,30} in [A-Z][a-z]|where can I .{1,30} in [A-Z][a-z]|where to .{1,30} in [A-Z][a-z]|places to .{1,30} in [A-Z][a-z])/i;

const HIDDEN_PERSONAL =
  /\b(what'?s on tomorrow|what'?s on today|any emails|any unread|did [A-Z][a-z]+ reply|did [A-Z][a-z]+ respond|free after|busy at|available at|what'?s in my|check my|show me my|my inbox|my calendar|my schedule|my contacts|my emails|meeting notes|what was discussed|what did we discuss|notes from .{1,20} meeting|how many emails|how many meetings)\b/i;

const PERSONAL_RECALL =
  /\b(how many .{0,30} did (i|we)\b|what did (i|we) \w|when did (i|we) |where did (i|we) |who did (i|we) |did i (ever |tell |mention)|do you (remember|recall)\b|what do you know about me|tell me (about|everything about) (myself|me)|what have you (learned|figured out) about me|tell me something (interesting|surprising|cool) about me|surprise me with what you know|how well do you (know|understand) me|describe me based on what you know|paint a picture of me)/i;

const MEETING_PREP_VERBS =
  /\b(prep(are)?( me)?( for)?|brief me|get (me )?ready for|what do i need to know (for|about)|meeting prep|help me prepare|what should i say( first)?|how should i handle|how do i sound prepared|give me the (20|30)[-\s]?second|quick brief|full brief)\b/i;
const MEETING_PREP_NOUNS =
  /\b(meeting|call|standup|sync|catch ?up|review|1[:\-]1|one.on.one|appointment|session|interview|wbr)\b/i;

type DisqualifierBucket =
  | 'personal_system_nouns'
  | 'workflow_verbs'
  | 'temporal_signals'
  | 'explicit_time'
  | 'local_or_travel'
  | 'event_time_query'
  | 'weather_price_live'
  | 'news_current'
  | 'lookup_verbs'
  | 'location_intent'
  | 'hidden_personal'
  | 'personal_recall'
  | 'meeting_prep_intent'
  | 'sports_live_data';

const SPORTS_LIVE_DATA =
  /\b(ladder|standings|results?|fixtures?|draw|tipping|tips|score|scores|scored|who won|who lost|who beat|who plays|who'?s playing|trade period|traded|trades?|draft|free agenc|delist|delisted|suspended|injured|injury list|team changes|ins and outs|selected|dropped|omitted|named|interchange)\b/i;

function matchedDisqualifier(message: string): DisqualifierBucket | null {
  if (MEETING_PREP_VERBS.test(message) && MEETING_PREP_NOUNS.test(message)) return 'meeting_prep_intent';
  if (PERSONAL_SYSTEM_NOUNS.test(message)) return 'personal_system_nouns';
  if (WORKFLOW_VERBS.test(message)) return 'workflow_verbs';
  if (TEMPORAL_SIGNALS.test(message) && !TEMPORAL_RANGE_OVERRIDE.test(message)) return 'temporal_signals';
  if (EXPLICIT_TIME.test(message)) return 'explicit_time';
  if (LOCAL_OR_TRAVEL.test(message)) return 'local_or_travel';
  if (ADDRESS_PATTERN.test(message) && DIRECTIONAL_TRAVEL.test(message)) return 'local_or_travel';
  if (EVENT_TIME_QUERY.test(message)) return 'event_time_query';
  if (WEATHER_PRICE_LIVE.test(message)) return 'weather_price_live';
  if (NEWS_CURRENT.test(message)) return 'news_current';
  if (LOOKUP_VERBS.test(message)) return 'lookup_verbs';
  if (LOCATION_INTENT.test(message)) return 'location_intent';
  if (HIDDEN_PERSONAL.test(message)) return 'hidden_personal';
  if (PERSONAL_RECALL.test(message)) return 'personal_recall';
  if ((AFL_FOOTY_PATTERN.test(message) || AFL_TEAM_PATTERN.test(message)) && SPORTS_LIVE_DATA.test(message)) return 'sports_live_data';
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

function lastAssistantUsedTools(context: RouterContext, userMessage: string): boolean {
  const TOOL_TAG = /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search|plan_steps|manage_reminder)\]/;
  const assistants = context.recentTurns
    .filter((t) => t.role === "assistant");

  // Always check the very last assistant turn
  const last = assistants.slice(-1)[0]?.content ?? "";
  if (TOOL_TAG.test(last)) return true;

  // For short messages (likely follow-ups like "Who's playing?", "Nice",
  // "What about their hours?"), extend the lookback to 3 turns so a quick
  // casual exchange doesn't clear tool context. Longer messages are almost
  // certainly a new topic and shouldn't be penalised by old tool usage.
  if (userMessage.length <= 30) {
    return assistants.slice(-3).some((t) => TOOL_TAG.test(t.content));
  }

  return false;
}

/**
 * Like lastAssistantUsedTools but only matches write/draft/commit tools.
 * Read-only tools (web_search, email_read, semantic_search, etc.) do NOT
 * count — casual follow-ups after pure research should route to chat, not
 * get bumped to smart by the safety net.
 */
function lastAssistantUsedWriteTools(context: RouterContext, userMessage: string): boolean {
  const WRITE_TOOL_TAG = /\[(email_draft|email_send|calendar_write|plan_steps|manage_reminder)\]/;
  const assistants = context.recentTurns
    .filter((t) => t.role === "assistant");

  const last = assistants.slice(-1)[0]?.content ?? "";
  if (WRITE_TOOL_TAG.test(last)) return true;

  if (userMessage.length <= 30) {
    return assistants.slice(-3).some((t) => WRITE_TOOL_TAG.test(t.content));
  }

  return false;
}

// ── Research fast-lane detection ──────────────────────────────
// After a disqualifier fires, check whether the message is unambiguously
// a web-search lookup (sports fixture, weather, news, prices, general
// factual).  These don't need the LLM classifier or heavy reasoning —
// they're simple lookups that should resolve in 3-5s, not 20+s.

const SPORTS_PATTERN =
  /\b(playing|play|game|match|fixture|verse|vs\.?|bounce|kick off|lineup|line-?up|team sheet|season|round\s+\d|score|scored|won|lost|beat|defeated|premiership|grand final|semi|final|derby|ladder|standings|draw|afl|nrl|nba|nfl|epl|a-?league|big ?bash|bbl)\b/i;

const AFL_FOOTY_PATTERN =
  /\b(afl|footy|footie|aussie rules|australian football|sherrin|brownlow|coleman|norm smith|crichton|rising star|mark of the year|goal of the year|afl draft|trade period|afl trade|pre-?season|jlt|marsh series|gather round|magic round|dreamtime|anzac day (game|match|eve)|indigenous round|pride (game|round|match)|sir doug nicholls|showdown|q-?clash|western derby|elimination final|qualifying final|preliminary final|bye round|bye week|wafl|sanfl|vfl|aflw)\b/i;

const AFL_TEAM_PATTERN =
  /\b(adelaide crows|crows|brisbane lions|lions|carlton|blues|collingwood|magpies|pies|essendon|bombers|dons|fremantle|dockers|freo|geelong|cats|gold coast suns|suns|gws giants|giants|gws|hawthorn|hawks|melbourne demons|demons|dees|north melbourne|kangaroos|roos|port adelaide|power|port|richmond|tigers|tiges|st kilda|saints|sydney swans|swans|west coast eagles|eagles|western bulldogs|bulldogs|dogs|doggies)\b/i;

const FACTUAL_QW =
  /\b(where|when|what time|who won|who is|who are|how many|how much|how tall|how old|how long|how far|what is|what are|what was|what were|is there|are there)\b/i;

function isWebSearchLookup(msg: string, bucket: DisqualifierBucket): boolean {
  if (PERSONAL_SYSTEM_NOUNS.test(msg)) return false;
  if (HIDDEN_PERSONAL.test(msg)) return false;
  if (PERSONAL_RECALL.test(msg)) return false;

  // These buckets are inherently external lookups
  if (bucket === 'weather_price_live') return true;
  if (bucket === 'news_current') return true;
  if (bucket === 'location_intent') return true;
  if (bucket === 'lookup_verbs') return true;
  if (bucket === 'event_time_query') return true;
  if (bucket === 'sports_live_data') return true;

  // Temporal signals are ambiguous — "this weekend" could be calendar or
  // sports.  Only fast-lane when there's clear external-lookup evidence.
  if (bucket === 'temporal_signals') {
    if (SPORTS_PATTERN.test(msg)) return true;
    if (AFL_FOOTY_PATTERN.test(msg)) return true;
    if (AFL_TEAM_PATTERN.test(msg)) return true;
    if (WEATHER_PRICE_LIVE.test(msg)) return true;
    if (NEWS_CURRENT.test(msg)) return true;
    if (FACTUAL_QW.test(msg) && !WORKFLOW_VERBS.test(msg)) return true;
  }

  return false;
}

const RESEARCH_LITE_NAMESPACES: ToolNamespace[] = [
  "web.search",
  "knowledge.search",
  "contacts.read",
  "memory.read",
  "messaging.react",
  "travel.search",
];

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
  // Onboarding gets its own agent but needs tools (web.search, memory, etc.)
  // Use 0B-knowledge so namespace-resolved tools are passed through.
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
        "travel.search",
      ],
      needsMemoryRead: true,
      needsMemoryWriteCandidate: true,
      needsWebFreshness: false,
      userStyle: "normal",
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
      primaryDomain: "general",
      memoryDepth: "light",
      routeLayer: "0B-knowledge",
      routeReason: "onboarding",
      hadPendingState: false,
      matchedDisqualifierBucket: null,
    };
  }

  // Normalise smart/curly quotes to straight quotes — iMessage sends these
  const msg = input.userMessage.trim().replace(/\s+/g, ' ').replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  // Step 0: Pending state check
  const pending = hasPendingState(context);
  const writeToolsInLastTurn = lastAssistantUsedWriteTools(context, msg);

  // Only pending state or WRITE tools in last turn block the deterministic path.
  // Read-only tools (web_search, email_read, calendar_read, semantic_search, etc.)
  // should NOT force the classifier — casual/knowledge follow-ups after research
  // can safely route deterministically for ~2s latency savings.
  if (pending || writeToolsInLastTurn) {
    return null; // → Lane 3 (classifier)
  }

  // Step 1: Disqualifier detection
  const disqualifier = matchedDisqualifier(msg);
  if (disqualifier) {
    // Step 1.5: Research fast lane — if the disqualifier fired but the
    // message is unambiguously a web-search lookup, skip the classifier
    // and route directly to smart with low reasoning + light prompt.
    if (isWebSearchLookup(msg, disqualifier)) {
      return {
        mode: "single_agent",
        agent: "smart",
        allowedNamespaces: RESEARCH_LITE_NAMESPACES,
        needsMemoryRead: false,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: true,
        userStyle: "normal",
        confidence: 0.95,
        fastPathUsed: true,
        routerLatencyMs: 0,
        primaryDomain: "research",
        memoryDepth: "none",
        routeLayer: "0B-research",
        routeReason: `research_fast_lane:${disqualifier}`,
        reasoningEffortOverride: "low",
        hadPendingState: false,
        matchedDisqualifierBucket: disqualifier,
      };
    }
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

  // Deep profile escape hatch — fuzzy match for "what do you know about me"
  // and variants. Must be checked before Lane 2 default so it reaches the
  // classifier where applyDeepProfileHeuristic fires.
  const DEEP_PROFILE_FUZZY =
    /\b(what\b.{0,5}\byou know about me|tell me (about|everything about) (myself|me)|what have you (learned|figured out) about me|tell me something .{0,15} about me|surprise me with what you know|how well do you (know|understand) me|describe me|paint a picture of me|what('s| is) my profile|what .{0,10} know about me|know about me)\b/i;
  if (DEEP_PROFILE_FUZZY.test(msg)) {
    console.log(`[route-v2] deep_profile fuzzy match — escaping to classifier (msg: "${msg.substring(0, 60)}")`);
    return null; // → Lane 3 (classifier)
  }

  // Lane 2: Knowledge-ready chat (default for everything not disqualified)
  // Includes semantic_search + memory so the model can look up personal
  // knowledge when needed, without requiring the full classifier.
  return {
    mode: "single_agent",
    agent: "chat",
    allowedNamespaces: LANE2_NAMESPACES,
    needsMemoryRead: true,
    needsMemoryWriteCandidate: false,
    needsWebFreshness: false,
    userStyle: "normal",
    confidence: 0.90,
    fastPathUsed: true,
    routerLatencyMs: 0,
    primaryDomain: "general",
    memoryDepth: "light",
    routeLayer: "0B-knowledge",
    routeReason: "knowledge_ready_default",
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
// Infer domain namespaces from recent tool tags in assistant turns
// ═══════════════════════════════════════════════════════════════

const TOOL_TAG_ALL =
  /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search|manage_reminder)\]/g;

const TOOL_TO_DOMAIN: Record<string, import("./types.ts").DomainTag> = {
  email_read: "email",
  email_draft: "email",
  email_send: "email",
  calendar_read: "calendar",
  calendar_write: "calendar",
  contacts_read: "contacts",
  travel_time: "research",
  places_search: "research",
  semantic_search: "recall",
  granola_read: "meeting_prep",
  web_search: "research",
  manage_reminder: "calendar",
};

function inferNamespacesFromRecentTools(context: RouterContext): ToolNamespace[] {
  const domains = new Set<import("./types.ts").DomainTag>();
  const assistants = context.recentTurns
    .filter((t) => t.role === "assistant")
    .slice(-3);
  for (const turn of assistants) {
    for (const match of turn.content.matchAll(TOOL_TAG_ALL)) {
      const domain = TOOL_TO_DOMAIN[match[1]];
      if (domain) domains.add(domain);
    }
  }

  if (domains.size === 0) return [];

  const nsSet = new Set<ToolNamespace>();
  for (const domain of domains) {
    for (const ns of getBaseToolsForDomain(domain)) nsSet.add(ns);
  }
  return [...nsSet];
}

// ═══════════════════════════════════════════════════════════════
// Main v2 router — tries each layer in order
// ═══════════════════════════════════════════════════════════════

export async function routeTurnV2(
  input: TurnInput,
  context: RouterContext,
): Promise<RouteDecision> {
  // ─── Group chat intercept — privacy firewall ───────────────
  // Group chats get a restricted route with NO access to personal data.
  if (input.isGroupChat) {
    const { GROUP_ALLOWED_NAMESPACES } = await import("../group.ts");
    console.log(`[route-v2] Group chat → chat agent with ${GROUP_ALLOWED_NAMESPACES.length} namespaces`);
    return {
      mode: "single_agent",
      agent: "chat",
      allowedNamespaces: GROUP_ALLOWED_NAMESPACES,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: true,
      userStyle: "brief",
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
      primaryDomain: "general",
      memoryDepth: "none",
      routeLayer: "0B-group",
      routeReason: "Group chat → privacy-restricted route with tools",
    };
  }

  const layer0A = tryPendingActionResolution(input, context);
  if (layer0A) {
    if (layer0A instanceof Promise) {
      const resolved = await layer0A;
      if (resolved) {
        console.log(
          `[route-v2] Layer 0A (pending action, async): agent=${resolved.agent}, confirmation=${resolved.confirmationState}`,
        );
        return resolved;
      }
      // classifyConfirmation returned false — fall through to Layer 0B/0C
    } else {
      console.log(
        `[route-v2] Layer 0A (pending action): agent=${layer0A.agent}, confirmation=${layer0A.confirmationState}`,
      );
      return layer0A;
    }
  }

  // Pre-compute pending state and disqualifier for telemetry
  const msg = input.userMessage.trim().replace(/\s+/g, ' ');
  const pending = hasPendingState(context);
  const toolsInLastTurn = lastAssistantUsedTools(context, msg);
  const writeToolsInLastTurn = lastAssistantUsedWriteTools(context, msg);
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

  // Safety net 1: classifier returned "chat" with low confidence after WRITE tools.
  // Only write/draft/commit tools (email_draft, email_send, calendar_write, plan_steps)
  // trigger this override. Read-only tools (web_search, email_read, semantic_search,
  // etc.) don't — casual follow-ups after research should route to chat normally.
  if (writeToolsInLastTurn && layer0C.agent === "chat" && layer0C.confidence < 0.7) {
    const inferredNs = inferNamespacesFromRecentTools(context);
    if (inferredNs.length > 0) {
      console.log(
        `[route-v2] safety net 1: overriding chat→smart (conf=${layer0C.confidence}, write_tools_in_last_turn=true, inferred_ns=[${inferredNs.join(",")}])`,
      );
      layer0C.agent = "smart";
      layer0C.allowedNamespaces = [...new Set([...inferredNs, ...CHAT_NAMESPACES])];
      layer0C.routeReason = `low_confidence_chat_upgraded:${classifierReason}`;
    }
  }

  // Safety net 2: classifier returned "chat" but the message contains explicit
  // write-intent verbs (draft, send, book, schedule, etc.). The classifier
  // occasionally misclassifies these — forcibly upgrade to smart with the
  // appropriate write namespaces so the agent can actually execute the action.
  if (layer0C.agent === "chat" && disqualifier === 'workflow_verbs') {
    const WRITE_VERB_NS: Record<string, string[]> = {
      'draft':    ['email.read', 'email.write', 'contacts.read'],
      'send':     ['email.read', 'email.write', 'contacts.read'],
      'compose':  ['email.read', 'email.write', 'contacts.read'],
      'forward':  ['email.read', 'email.write', 'contacts.read'],
      'reply':    ['email.read', 'email.write', 'contacts.read'],
      'respond':  ['email.read', 'email.write', 'contacts.read'],
      'book':     ['calendar.read', 'calendar.write', 'contacts.read'],
      'schedule': ['calendar.read', 'calendar.write', 'contacts.read'],
      'cancel':   ['calendar.read', 'calendar.write'],
      'remind':   ['reminders.manage', 'memory.read'],
      'create':   ['calendar.read', 'calendar.write', 'contacts.read'],
      'update':   ['calendar.read', 'calendar.write', 'email.read', 'email.write'],
      'delete':   ['calendar.read', 'calendar.write'],
      'set up':   ['calendar.read', 'calendar.write', 'contacts.read'],
      'arrange':  ['calendar.read', 'calendar.write', 'contacts.read'],
      'prepare':  ['email.read', 'email.write', 'contacts.read'],
      'prep':     ['email.read', 'email.write', 'contacts.read'],
    };
    const msgLower = msg.toLowerCase();
    const matchedVerb = Object.keys(WRITE_VERB_NS).find(v => new RegExp(`\\b${v}\\b`).test(msgLower));
    if (matchedVerb) {
      const ns = WRITE_VERB_NS[matchedVerb];
      console.log(
        `[route-v2] safety net 2: overriding chat→smart (workflow_verb="${matchedVerb}", classifier_conf=${layer0C.confidence})`,
      );
      layer0C.agent = "smart";
      layer0C.allowedNamespaces = [...new Set([...ns, ...CHAT_NAMESPACES])];
      layer0C.routeReason = `workflow_verb_override:${matchedVerb}`;
      layer0C.confidence = Math.max(layer0C.confidence, 0.85);
    }
  }

  console.log(
    `[route-v2] Layer 0C (classifier): agent=${layer0C.agent}, domain=${layer0C.primaryDomain}, reason=${layer0C.routeReason}, latency=${layer0C.routerLatencyMs}ms`,
  );
  return layer0C;
}
