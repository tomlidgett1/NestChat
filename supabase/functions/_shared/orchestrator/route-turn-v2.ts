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

  const recentAssistantOfferedAction = context.recentTurns.slice(-2).some((t) =>
    t.role === "assistant" && (
      /\b(draft|drafted|shall i send|want me to send|should i send|would you like me to send|do you want me to send|send this to|send this brief|send it to|send that to|forward this|forward it)\b/i
        .test(t.content) ||
      /\[email_draft\]/.test(t.content)
    )
  );

  if (!hasPendingAction && !recentAssistantOfferedAction) return null;

  const msg = input.userMessage.trim();
  if (msg.length >= 120) return null;

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
  "weather.search",
  "travel.search",
];

const CASUAL_ACK_NAMESPACES: ToolNamespace[] = [
  "memory.read",
  "memory.write",
  "messaging.react",
  "messaging.effect",
];

const LANE2_NAMESPACES: ToolNamespace[] = [
  "messaging.react",
  "messaging.effect",
  "knowledge.search",
  "memory.read",
  "memory.write",
  "web.search",
  "weather.search",
  "travel.search",
];

const SAFE_CASUAL_EXPANDED =
  /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|perfect|amazing|wow|damn|omg|wtf|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;
const DAYPART_GREETING =
  /^(good\s+)?(morning|afternoon|evening|night)[!.?]*$|^(gm|gn)[!.?]*$/i;

// ── Disqualifier buckets ──────────────────────────────────────
// If ANY bucket matches, the message goes to Lane 3 (classifier).

const PERSONAL_SYSTEM_NOUNS =
  /\b(inbox|calendar|schedule|emails?|gmail|outlook|contacts?|messages?|account|granola|meetings?)\b/i;

// Inbox / DocuSign-style questions — need classifier so email.read can be allowed.
const EMAIL_OR_DOC_SENDER_QUERY =
  /\b(who sent|sent by|from whom)\b[\s\S]{0,100}\b(contract|agreement|offer letter|employment|attachment|docu)\b|\b(my original|the original)\b[\s\S]{0,50}\b(contract|agreement|offer)\b/i;

const WORKFLOW_VERBS =
  /\b(send|draft|book|remind|schedule|cancel|delete|create|update|forward|compose|set up|arrange|prepare|prep|respond|reply|add|put|move|reschedule|remove|invite|notify|alert|watch for)\b/i;

const TEMPORAL_SIGNALS =
  /\b(today|tomorrow|tonight|yesterday|last night|last weekend|on the weekend|this week|next week|next month|this weekend|right now|currently|latest|current|open now|later today|later tonight|this morning|this afternoon|this evening|this arvo|at the moment|monday|tuesday|wednesday|thursday|friday|saturday|sunday|last \d+ (days?|weeks?|months?|hours?)|past \d+ (days?|weeks?|months?|hours?))\b/i;

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
  /\b(what'?s on tomorrow|what'?s on today|any emails|any unread|did [A-Z][a-z]+ reply|did [A-Z][a-z]+ respond|free after|busy at|available at|what'?s in my|check my|show me my|my inbox|my calendar|my schedule|my contacts|my emails|meeting notes|what was discussed|what did we discuss|notes from .{1,20} meeting|how many emails|how many meetings|what.{0,20}(i'?ve|have i|did i)\s*miss|rundown.{0,20}(missed|work|away)|catch.{0,5}(me |us )?up\b.{0,20}(work|email|inbox|missed)|been away.{0,20}(from )?(work|office|the office)|what.{0,10}missed.{0,15}(work|office|while)|(do|when do|when does|when are|when am)\s+(i|we)\s+fly\b|fly\s+(out\s+)?(to|from)\s+\w|(contract|agreement|offer letter)\s+(deliver\w*|sent|sign\w*|receiv\w*)\b.{0,20}\b(hr|human resources|people ops|legal)\b|what\s+(?:am\s+i|i'?m)\s+doing|(?:am\s+i|are\s+we)\s+doing\s+anything|what(?:'?s|\s+are)\s+my\s+plans|what\s+(?:have\s+)?(?:i|we)\s+got\s+on)\b/i;

const PERSONAL_RECALL =
  /\b(how many .{0,30} did (i|we)\b|what did (i|we) \w|when did (i|we) |where did (i|we) |who did (i|we) |did i (ever |tell |mention)|do you (remember|recall)\b|what do you know about me|tell me (about|everything about) (myself|me)|what have you (learned|figured out) about me|tell me something (interesting|surprising|cool) about me|surprise me with what you know|how well do you (know|understand) me|describe me based on what you know|paint a picture of me|what\s+(?:am\s+i|i'?m)\s+doing|what\s+(?:am\s+i|i'?m)\s+up\s+to|(?:am\s+i|i'?m)\s+doing\s+anything|what(?:'?s|\s+are)\s+my\s+plans|what\s+(?:have\s+)?(?:i|we)\s+got\s+(?:on|planned|coming)|do\s+i\s+have\s+(?:any(?:thing)?|stuff|plans)(?:\s+on)?|(?:tell|remind)\s+me\s+what\s+(?:i'?m|i\s+am)\s+doing)/i;

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
  | 'service_availability_intent'
  | 'hidden_personal'
  | 'personal_recall'
  | 'meeting_prep_intent'
  | 'sports_live_data';

const SPORTS_LIVE_DATA =
  /\b(ladder|standings|results?|fixtures?|draw|tipping|tips|score|scores|scored|who won|who lost|who beat|who plays|who'?s playing|trade period|traded|trades?|draft|free agenc|delist|delisted|suspended|injured|injury list|team changes|ins and outs|selected|dropped|omitted|named|interchange|this season|season so far|current season|championship standings|how.{0,15}(gone|going|doing|performing|played|been))\b/i;

const SPORT_LEAGUE_STANDALONE =
  /^(afl|nrl|nba|nfl|epl|a-?league|big ?bash|bbl|ufc|f1|formula ?1|mls|mlb|nhl|cricket|rugby|soccer|football|tennis|golf|boxing|mma|wpl|ipl|super ?rugby|ligue ?1|la ?liga|serie ?a|bundesliga|eredivisie|champions ?league|europa ?league)$/i;

function matchedDisqualifier(message: string): DisqualifierBucket | null {
  if (MEETING_PREP_VERBS.test(message) && MEETING_PREP_NOUNS.test(message)) return 'meeting_prep_intent';
  if (EMAIL_OR_DOC_SENDER_QUERY.test(message)) return 'personal_system_nouns';
  if (PERSONAL_SYSTEM_NOUNS.test(message)) return 'personal_system_nouns';
  if (WORKFLOW_VERBS.test(message)) return 'workflow_verbs';
  if (PERSONAL_RECALL.test(message)) return 'personal_recall';
  if (TEMPORAL_SIGNALS.test(message) && !TEMPORAL_RANGE_OVERRIDE.test(message)) return 'temporal_signals';
  if (EXPLICIT_TIME.test(message)) return 'explicit_time';
  if (LOCAL_OR_TRAVEL.test(message)) return 'local_or_travel';
  if (ADDRESS_PATTERN.test(message) && DIRECTIONAL_TRAVEL.test(message)) return 'local_or_travel';
  if (EVENT_TIME_QUERY.test(message)) return 'event_time_query';
  if (WEATHER_PRICE_LIVE.test(message)) return 'weather_price_live';
  if (NEWS_CURRENT.test(message)) return 'news_current';
  if (LOOKUP_VERBS.test(message)) return 'lookup_verbs';
  if (LOCATION_INTENT.test(message)) return 'location_intent';
  if (
    SERVICE_AVAILABILITY_INTENT.test(message) &&
    !INBOX_OR_CONTRACT_CONTEXT.test(message)
  ) {
    return 'service_availability_intent';
  }
  if (HIDDEN_PERSONAL.test(message)) return 'hidden_personal';
  if ((SPORTS_PATTERN.test(message) || AFL_FOOTY_PATTERN.test(message) || AFL_TEAM_PATTERN.test(message)) && SPORTS_LIVE_DATA.test(message)) return 'sports_live_data';
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

function lastAssistantUsedTools(context: RouterContext, _userMessage: string): boolean {
  const TOOL_TAG = /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search|news_search|weather_lookup|plan_steps|manage_reminder|manage_notification_watch)\]/;
  const assistants = context.recentTurns
    .filter((t) => t.role === "assistant");

  return assistants.slice(-3).some((t) => TOOL_TAG.test(t.content));
}

/**
 * Like lastAssistantUsedTools but only matches write/draft/commit tools.
 * Read-only tools (web_search, email_read, semantic_search, etc.) do NOT
 * count — casual follow-ups after pure research should route to chat, not
 * get bumped to smart by the safety net.
 */
function lastAssistantUsedWriteTools(context: RouterContext, _userMessage: string): boolean {
  const WRITE_TOOL_TAG = /\[(email_draft|email_send|calendar_write|plan_steps|manage_reminder|manage_notification_watch)\]/;
  const assistants = context.recentTurns
    .filter((t) => t.role === "assistant");

  return assistants.slice(-3).some((t) => WRITE_TOOL_TAG.test(t.content));
}

// ── Research fast-lane detection ──────────────────────────────
// After a disqualifier fires, check whether the message is unambiguously
// a web-search lookup (sports fixture, weather, news, prices, general
// factual).  These don't need the LLM classifier or heavy reasoning —
// they're simple lookups that should resolve in 3-5s, not 20+s.

const SPORTS_PATTERN =
  /\b(playing|play|game|match|fixture|verse|vs\.?|bounce|kick off|lineup|line-?up|team sheet|season|round\s+\d|score|scored|won|lost|beat|defeated|premiership|grand final|semi|final|derby|ladder|standings|draw|afl|nrl|nba|nfl|epl|a-?league|big ?bash|bbl|f1|formula\s*1|grand\s*prix|qualifying|quali|fp[1-3]|podium|constructors|drivers.{0,5}championship|motogp|supercars|indycar|nascar|ufc|mma|cricket|rugby|tennis|golf|boxing|soccer|football)\b/i;

const AFL_FOOTY_PATTERN =
  /\b(afl|footy|footie|aussie rules|australian football|sherrin|brownlow|coleman|norm smith|crichton|rising star|mark of the year|goal of the year|afl draft|trade period|afl trade|pre-?season|jlt|marsh series|gather round|magic round|dreamtime|anzac day (game|match|eve)|indigenous round|pride (game|round|match)|sir doug nicholls|showdown|q-?clash|western derby|elimination final|qualifying final|preliminary final|bye round|bye week|wafl|sanfl|vfl|aflw)\b/i;

const AFL_TEAM_PATTERN =
  /\b(adelaide crows|crows|brisbane lions|lions|carlton|blues|collingwood|magpies|pies|essendon|bombers|dons|fremantle|dockers|freo|geelong|cats|gold coast suns|suns|gws giants|giants|gws|hawthorn|hawks|melbourne demons|demons|dees|north melbourne|kangaroos|roos|port adelaide|power|port|richmond|tigers|tiges|st kilda|saints|sydney swans|swans|west coast eagles|eagles|western bulldogs|bulldogs|dogs|doggies)\b/i;

const WEATHER_ONLY_QUERY =
  /\b(weather|forecast|rain(ing)?|temperature|degrees|humid|cold .{0,10}outside|hot .{0,10}outside|warm .{0,10}outside|freezing|sunny|cloudy|storm|snow(ing)?|uv|umbrella|jacket|sunset|sunrise|air quality)\b/i;
const EXACT_TRAVEL_QUERY =
  /\b(directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|walk to|drive to|cycle to|going to .{1,40}(street|st|road|rd|ave|avenue|blvd|boulevard|drive|dr|place|pl|lane|ln|way|crescent|cr|parade|pde|club|hotel|station|uni|university|hospital|airport|park|gardens?|square|mall|centre|center|tower|house)|heading to .{1,40}(street|st|road|rd|club|hotel|station|airport|park)|train from .{1,40} to|flight from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to)\b/i;
const LOW_RISK_LOCAL_DISCOVERY =
  /\b(near me|nearby|nearest|open now|around here|best .{1,40} near me|good .{1,40} near me|restaurants?|cafe|cafes|coffee|brunch|lunch|dinner|bar|pub|pharmacy|chemist|park|gym|supermarket|grocer|dog[-\s]?friendly)\b/i;
const LOCAL_EVENTS_OR_HOURS =
  /\b(what'?s on|events?|markets?|gig|show|festival|opening hours?|hours|open now|close[sd]?|closing time)\b/i;
const LOCAL_SERVICE_AVAILABILITY =
  /\b(deliver(?:y)?|available here|same[-\s]?day|coverage|provider|providers|internet|ubereats|doordash|instacart|service area|ship here)\b/i;
const JURISDICTION_SENSITIVE =
  /\b(legal|law|rebate|eligible|eligibility|permit|allowed|tax|jurisdiction|postcode|address)\b/i;
const SERVICE_AVAILABILITY_INTENT =
  /\b(deliver(?:y)?|deliver here|available here|service area|coverage|provider|providers|internet|ubereats|doordash|instacart|ship here)\b/i;

// Delivery brands appear in contract/HR email too — avoid mis-routing those to the
// research fast lane (no email.read).
const INBOX_OR_CONTRACT_CONTEXT =
  /\b(contract|employment|offer letter|agreement|who sent|sent me|my original|signed|docu|inbox|gmail|outlook|message from|hr\b|people ops)\b/i;

/**
 * Personal flight / booking time questions (often a follow-up after Nest mentioned
 * a trip). These need email_read and/or calendar_read — not the web-only research
 * fast lane with tool_choice=required, which traps the model in semantic_search
 * loops and can yield zero user-visible text.
 */
function isPersonalBookingFlightTimeQuery(msg: string): boolean {
  return /\b(my|our|the)\s+flight\b|\bflight\s+time\b|\bwhen\s+(do|does|am)\s+(i|we)\s+(fly|flying|leave|depart|board)\b|\bwhat\s+time\s+(do|does|am)\s+(i|we)\s+(fly|flying|leave|depart|board)\b|\b(do|when do|when does|when are|when am)\s+(i|we)\s+fly\b|\bfly\s+(out\s+)?(to|from)\b|\bbooking ref(?:erence)?\b|\bpnr\b|\be-?ticket\b|\bitinerary\b|\bboarding pass\b|\blounge pass\b|\b(qantas|jetstar|virgin australia|bonza|rex)\b/i
    .test(msg);
}

function shouldUseLocalContextFastLane(
  msg: string,
  bucket: DisqualifierBucket,
): boolean {
  if (WEATHER_ONLY_QUERY.test(msg)) return true;

  if (bucket === "location_intent") return true;
  if (bucket === "service_availability_intent") return true;

  if (bucket === "local_or_travel") {
    if (EXACT_TRAVEL_QUERY.test(msg)) return false;
    return LOW_RISK_LOCAL_DISCOVERY.test(msg) || LOCAL_EVENTS_OR_HOURS.test(msg);
  }

  if (bucket === "temporal_signals" || bucket === "event_time_query") {
    return LOCAL_EVENTS_OR_HOURS.test(msg) || WEATHER_ONLY_QUERY.test(msg);
  }

  if (bucket === "lookup_verbs") {
    return (
      LOW_RISK_LOCAL_DISCOVERY.test(msg) ||
      LOCAL_EVENTS_OR_HOURS.test(msg) ||
      (LOCAL_SERVICE_AVAILABILITY.test(msg) && !JURISDICTION_SENSITIVE.test(msg))
    );
  }

  return false;
}

function isWebSearchLookup(msg: string, bucket: DisqualifierBucket): boolean {
  if (PERSONAL_SYSTEM_NOUNS.test(msg)) return false;
  if (HIDDEN_PERSONAL.test(msg)) return false;
  if (PERSONAL_RECALL.test(msg)) return false;

  // These buckets are inherently external lookups
  if (bucket === 'weather_price_live') return true;
  if (bucket === 'news_current') return true;
  if (bucket === 'location_intent') return true;
  if (bucket === 'service_availability_intent') return true;
  if (bucket === 'lookup_verbs') return true;
  if (bucket === 'event_time_query') {
    if (isPersonalBookingFlightTimeQuery(msg)) return false;
    return true;
  }
  if (bucket === 'sports_live_data') return true;
  if (bucket === 'local_or_travel' && shouldUseLocalContextFastLane(msg, bucket)) {
    return true;
  }

  // Temporal signals are ambiguous — "this weekend" could be calendar or
  // sports or travel or personal.  Only fast-lane when there's clear,
  // specific external-lookup evidence.  Everything else (travel, personal,
  // general factual with temporal words) should go to the classifier.
  if (bucket === 'temporal_signals') {
    if (SPORTS_PATTERN.test(msg)) return true;
    if (AFL_FOOTY_PATTERN.test(msg)) return true;
    if (AFL_TEAM_PATTERN.test(msg)) return true;
    if (WEATHER_PRICE_LIVE.test(msg)) return true;
    if (NEWS_CURRENT.test(msg)) return true;
    if (shouldUseLocalContextFastLane(msg, bucket)) return true;
  }

  return false;
}

const RECALL_NAMESPACES: ToolNamespace[] = [
  "memory.read",
  "knowledge.search",
  "granola.read",
  "calendar.read",
  "messaging.react",
];

const VERIFICATION_GATED_NAMESPACES: Set<ToolNamespace> = new Set([
  "email.read",
  "email.write",
  "calendar.read",
  "calendar.write",
  "reminders.manage",
  "notifications.watch",
  "contacts.read",
  "granola.read",
]);

function applyOnboardingConstraints(route: RouteDecision): RouteDecision {
  route.allowedNamespaces = route.allowedNamespaces.filter(
    (ns) => !VERIFICATION_GATED_NAMESPACES.has(ns),
  );
  if (route.routeLayer === "0B-casual") {
    route.routeLayer = "0B-knowledge";
  }
  return route;
}

const RESEARCH_LITE_NAMESPACES: ToolNamespace[] = [
  "web.search",
  "knowledge.search",
  "contacts.read",
  "memory.read",
  "messaging.react",
  "weather.search",
  "travel.search",
  "weather.search",
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
      const researchToolChoice = "required";
      const useLocalContext = shouldUseLocalContextFastLane(msg, disqualifier);
      const isNewsQuery = disqualifier === 'news_current';
      return {
        mode: "single_agent",
        agent: "smart",
        allowedNamespaces: RESEARCH_LITE_NAMESPACES,
        needsMemoryRead: useLocalContext || isNewsQuery,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: true,
        userStyle: "normal",
        confidence: 0.95,
        fastPathUsed: true,
        routerLatencyMs: 0,
        primaryDomain: "research",
        memoryDepth: (useLocalContext || isNewsQuery) ? "light" : "none",
        routeLayer: "0B-research",
        routeReason: isNewsQuery
          ? `news_fast_lane:${disqualifier}:memory_light`
          : useLocalContext
          ? `research_fast_lane:${disqualifier}:memory_light`
          : `research_fast_lane:${disqualifier}`,
        reasoningEffortOverride: isNewsQuery ? "medium" : "low",
        forcedToolChoice: researchToolChoice,
        hadPendingState: false,
        matchedDisqualifierBucket: disqualifier,
      };
    }

    // Step 1.6: Recall fast lane — "what did I do", "do you remember", etc.
    // Route directly to smart with recall + calendar tools to avoid the
    // classifier misrouting temporal recall queries as calendar domain.
    // Exception: deep_profile queries need the classifier for HIGH reasoning
    // and exhaustive multi-source search (applyDeepProfileHeuristic).
    if (disqualifier === 'personal_recall') {
      if (DEEP_PROFILE_ESCAPE.test(msg)) {
        console.log(`[route-v2] deep_profile in recall fast lane — escaping to classifier: "${msg.substring(0, 60)}"`);
        return null;
      }
      console.log(`[route-v2] recall fast lane: "${msg.substring(0, 60)}" → smart with recall namespaces`);
      return {
        mode: "single_agent",
        agent: "smart",
        allowedNamespaces: RECALL_NAMESPACES,
        needsMemoryRead: true,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: "normal",
        confidence: 0.95,
        fastPathUsed: true,
        routerLatencyMs: 0,
        primaryDomain: "recall",
        memoryDepth: "full",
        routeLayer: "0B-recall",
        routeReason: "recall_fast_lane:personal_recall",
        forcedToolChoice: "required",
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
      allowedNamespaces: isDaypart ? CHAT_NAMESPACES : CASUAL_ACK_NAMESPACES,
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

  // Step 2.5a: Weather follow-up detection
  // When the recent conversation includes weather_lookup usage and the user
  // sends a short follow-up like "tomorrow?", "Sunday?", "what about Saturday?",
  // route to smart with weather.search so the tool can actually be called.
  if (msg.length <= 40) {
    const recentAssistant = context.recentTurns
      .filter((t) => t.role === "assistant")
      .slice(-3);
    const recentUser = context.recentTurns
      .filter((t) => t.role === "user")
      .slice(-3);
    const weatherContextInRecent =
      recentAssistant.some((t) =>
        /\[weather_lookup\]/.test(t.content) ||
        /\b(forecast|weather|temperature|rain|°C|°F|cloudy|sunny|showers)\b/i.test(t.content)
      ) ||
      recentUser.some((t) =>
        /\b(weather|forecast|rain|temperature|umbrella)\b/i.test(t.content)
      );

    const isWeatherFollowUp = weatherContextInRecent && (
      /\b(tomorrow|tmrw|tomoz|today|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday|this week|next week|weekend|arvo|afternoon|morning|evening)\b/i.test(msg) ||
      /\b(what about|and|how about|how's)\b/i.test(msg) ||
      /\b(wind|rain|humid|uv|sun|cloud|storm|thunder|shower|cold|hot|warm|cool|fog|hail|snow|drizzle|umbrella|jacket|coat)\b/i.test(msg)
    );

    if (isWeatherFollowUp) {
      console.log(`[route-v2] weather follow-up detected: "${msg}" after weather context → smart with weather.search`);
      return {
        mode: "single_agent",
        agent: "smart",
        allowedNamespaces: RESEARCH_LITE_NAMESPACES,
        needsMemoryRead: true,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: "normal",
        confidence: 0.95,
        fastPathUsed: true,
        routerLatencyMs: 0,
        primaryDomain: "research",
        memoryDepth: "light",
        routeLayer: "0B-research",
        routeReason: "weather_followup_fast_lane",
        reasoningEffortOverride: "medium",
        forcedToolChoice: "required",
        hadPendingState: false,
        matchedDisqualifierBucket: null,
      };
    }
  }

  // Step 2.5: Short sport-keyword follow-up detection
  // When the user sends a bare sport league/team name (e.g. "AFL", "NRL",
  // "NBA") and the recent conversation contains a sports-related question
  // from the assistant (e.g. "Which sport?"), treat it as a continuation
  // of a live-data lookup and route to the research fast lane.
  if (msg.length <= 30 && (SPORT_LEAGUE_STANDALONE.test(msg) || AFL_TEAM_PATTERN.test(msg) || AFL_FOOTY_PATTERN.test(msg) || SPORTS_PATTERN.test(msg))) {
    const recentAssistant = context.recentTurns
      .filter((t) => t.role === "assistant")
      .slice(-2);
    const recentUser = context.recentTurns
      .filter((t) => t.role === "user")
      .slice(-2);
    const sportsContextInRecent =
      recentAssistant.some((t) =>
        /\b(sport|league|team|which (one|game|match)|playing|fixture|afl|nrl|nba|nfl|epl)\b/i.test(t.content)
      ) ||
      recentUser.some((t) =>
        SPORTS_PATTERN.test(t.content) || EVENT_TIME_QUERY.test(t.content)
      );

    if (sportsContextInRecent) {
      console.log(`[route-v2] sport follow-up detected: "${msg}" after sports context → research fast lane`);
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
        routeReason: "sport_followup_fast_lane",
        reasoningEffortOverride: "low",
        forcedToolChoice: "required",
        hadPendingState: false,
        matchedDisqualifierBucket: "sports_live_data",
      };
    }
  }

  // Step 2.5c: Web-grounded topic continuation
  // When web_search was used in recent assistant turns and the user sends a
  // factual follow-up (not a pure acknowledgment or a clear topic shift),
  // force web_search to prevent hallucination about live/current data.
  // This is the general-purpose safety net — it catches ALL topics (sports,
  // news, prices, research) without needing per-domain regex.
  if (msg.length <= 100) {
    const recentAssistant = context.recentTurns
      .filter((t) => t.role === "assistant")
      .slice(-4);

    const webSearchInRecent = recentAssistant.some((t) =>
      /\[(web_search|news_search)\]/.test(t.content)
    );

    if (webSearchInRecent) {
      const isTopicShift =
        /\b(email|inbox|calendar|schedule|remind|draft|send|book|weather|forecast|rain|directions?|how long to get|how far|recipe|password|define\s+\w|from work|at work|been away|missed|catch.{0,3}up|rundown|my (inbox|calendar|schedule|emails?))\b/i
          .test(msg);

      const isFactualFollowUp =
        /\?/.test(msg) ||
        /\b(how|what|who|when|where|which|why|did|does|has|is|are|was|were|will|can|could|should)\b/i.test(msg) ||
        /\b(season|this year|standings|results?|stats?|record|form|performance|ranking|points?|wins?|goals?|score|latest|update|news|currently|recent|championship|gone|going|doing)\b/i.test(msg);

      if (!isTopicShift && isFactualFollowUp) {
        console.log(`[route-v2] web-grounded topic continuation: "${msg.substring(0, 60)}" after recent web_search → research fast lane`);
        return {
          mode: "single_agent",
          agent: "smart",
          allowedNamespaces: RESEARCH_LITE_NAMESPACES,
          needsMemoryRead: false,
          needsMemoryWriteCandidate: false,
          needsWebFreshness: true,
          userStyle: "normal",
          confidence: 0.90,
          fastPathUsed: true,
          routerLatencyMs: 0,
          primaryDomain: "research",
          memoryDepth: "none",
          routeLayer: "0B-research",
          routeReason: "web_grounded_topic_continuation",
          reasoningEffortOverride: "low",
          forcedToolChoice: "required",
          hadPendingState: false,
          matchedDisqualifierBucket: null,
        };
      }
    }
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

  // ── Lane 2 gate: positive identification only ───────────────
  // Lane 2 is NO LONGER the catch-all default. The classifier is.
  // Only route to Lane 2 when the message is clearly general knowledge
  // or a short conversational statement with no personal/action signals.
  //
  // Philosophy: fast lanes are narrow and confident. The classifier
  // handles ambiguous intent correctly at ~1s extra cost. False positives
  // (sending knowledge to classifier) cost ~1s. False negatives (keeping
  // personal requests in Lane 2) produce wrong responses.

  const hasPersonalSignal =
    /\b(give me|show me|help me|check (my|if|on|for)|look (into|at my|through)|fill me in|catch.{0,5}(me |us )?up|been away|from work|at work|the office|missed|rundown|brief me|for me\b|pull (up|together)|can you .{0,10}(check|read|find|get|pull|search|look|review)|back (at|in|from) (work|the office)|up to speed|my (flight|booking|itinerary|reservation|appointment|ticket|e-?ticket|boarding pass|lounge pass|pnr|confirmation|ref(erence)?|trip|travel|visa|passport|insurance|hotel|accommodation|qantas|jetstar|virgin|bonza|rex|tax file number|tfn|abn|medicare|superannuation|super fund|bank account|account number|salary|payslip|leave balance|address|phone number|membership|subscription|password|login|username|pin|api key|license|rego|registration))\b/i
      .test(msg);

  if (hasPersonalSignal) {
    console.log(`[route-v2] personal/action signal in "${msg.substring(0, 60)}" → classifier`);
    return null;
  }

  const isKnowledgeOpener =
    /^(what |how |why |when |where |who |which |explain |describe |define |tell me about |compare |what'?s (the |a )|what are |what is |what does |what do |how does |how do |how is |is it true |can you explain|can you describe|can you tell)/i
      .test(msg);

  if (isKnowledgeOpener || msg.length <= 50) {
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
      routeReason: isKnowledgeOpener ? "pure_knowledge_question" : "short_general_message",
      hadPendingState: false,
      matchedDisqualifierBucket: null,
    };
  }

  // Default: not confident enough for any fast lane → classifier
  console.log(`[route-v2] no confident fast lane for "${msg.substring(0, 60)}" → classifier`);
  return null;
}

/**
 * Layer 0B only — deterministic pre-router (no LLM, no pending-action layer).
 * Used by the router scenario harness in CI/local tests.
 */
export function previewDeterministicRoute(
  input: TurnInput,
  context: RouterContext,
): RouteDecision | null {
  return tryDeterministicContinuation(input, context);
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
    needsMemoryRead: result.memoryDepth !== "none" || isDeepProfile ||
      result.requiredCapabilities.includes("travel.search"),
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
  /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search|news_search|weather_lookup|manage_reminder|manage_notification_watch)\]/g;

const TOOL_TO_DOMAIN: Record<string, import("./types.ts").DomainTag> = {
  email_read: "email",
  email_draft: "email",
  email_send: "email",
  calendar_read: "calendar",
  calendar_write: "calendar",
  contacts_read: "contacts",
  travel_time: "research",
  places_search: "research",
  weather_lookup: "research",
  semantic_search: "recall",
  granola_read: "meeting_prep",
  web_search: "research",
  news_search: "research",
  manage_reminder: "calendar",
  manage_notification_watch: "email",
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
  // Group chats run the classifier to pick the right agent (chat vs smart)
  // but namespaces are always clamped to the group-safe set (no personal data).
  if (input.isGroupChat) {
    const { GROUP_ALLOWED_NAMESPACES } = await import("../group.ts");
    const msg = input.userMessage.trim().replace(/\s+/g, " ");

    if (isSafeCasual(msg)) {
      console.log(`[route-v2] Group chat (casual) → chat agent`);
      return {
        mode: "single_agent",
        agent: "chat",
        allowedNamespaces: GROUP_ALLOWED_NAMESPACES,
        needsMemoryRead: false,
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: "brief",
        confidence: 1.0,
        fastPathUsed: true,
        routerLatencyMs: 0,
        primaryDomain: "general",
        memoryDepth: "none",
        routeLayer: "0B-group",
        routeReason: "Group chat casual fast-path",
      };
    }

    const start = Date.now();
    const classification = await classifyTurn(input, context);
    const latency = Date.now() - start;
    let agent: "smart" | "chat" = classification.mode === "smart" ? "smart" : "chat";
    const clampedNamespaces = GROUP_ALLOWED_NAMESPACES;

    // Live routes need the stronger model + tool discipline; classifier sometimes picks chat.
    const groupTravelOrNav =
      /\b(how (do|to) (i |we )?get|directions?|transit|train|bus|tram|commute|travel time|how long\b.*\b(drive|walk|take|get)|airport run|to the airport|from .+ to .+|ptv|myki|skybus|uber to|taxi to|public transport)\b/i;
    const groupWeatherQuery =
      /\b(weather|forecast|rain(ing)?|temperature|degrees|humid|cold|hot|warm|freezing|sunny|cloudy|storm|snow(ing)?|umbrella)\b/i;

    let groupForcedToolChoice: string | undefined;

    if (agent === "chat" && groupTravelOrNav.test(msg)) {
      agent = "smart";
      groupForcedToolChoice = "required";
      console.log(`[route-v2] Group chat → forcing smart + required (travel/nav heuristic)`);
    } else if (groupTravelOrNav.test(msg)) {
      groupForcedToolChoice = "required";
    }

    if (groupWeatherQuery.test(msg)) {
      if (agent === "chat") agent = "smart";
      groupForcedToolChoice = "required";
      console.log(`[route-v2] Group chat → forcing smart + required (weather heuristic)`);
    }

    if (classification.requiresToolUse && !groupForcedToolChoice) {
      groupForcedToolChoice = "required";
    }

    console.log(
      `[route-v2] Group chat → ${agent} agent (classifier: mode=${classification.mode}, domain=${classification.primaryDomain}, conf=${classification.confidence}, ${latency}ms, forcedTool=${groupForcedToolChoice ?? "none"})`,
    );

    return {
      mode: "single_agent",
      agent,
      allowedNamespaces: clampedNamespaces,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: classification.requiredCapabilities.includes("web.search"),
      userStyle: classification.style,
      confidence: classification.confidence,
      fastPathUsed: false,
      routerLatencyMs: latency,
      classifierResult: classification,
      primaryDomain: classification.primaryDomain,
      secondaryDomains: classification.secondaryDomains,
      memoryDepth: "none",
      routeLayer: "0B-group",
      routeReason: `Group chat → classifier picked ${agent}`,
      forcedToolChoice: groupForcedToolChoice,
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
    if (input.isOnboarding) applyOnboardingConstraints(layer0B);
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
    : 'no_confident_fast_path';

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
      'draft':      ['email.read', 'email.write', 'contacts.read'],
      'send':       ['email.read', 'email.write', 'contacts.read'],
      'compose':    ['email.read', 'email.write', 'contacts.read'],
      'forward':    ['email.read', 'email.write', 'contacts.read'],
      'reply':      ['email.read', 'email.write', 'contacts.read'],
      'respond':    ['email.read', 'email.write', 'contacts.read'],
      'book':       ['calendar.read', 'calendar.write', 'contacts.read'],
      'schedule':   ['calendar.read', 'calendar.write', 'contacts.read'],
      'reschedule': ['calendar.read', 'calendar.write', 'contacts.read'],
      'cancel':     ['calendar.read', 'calendar.write'],
      'remind':     ['reminders.manage', 'memory.read'],
      'create':     ['calendar.read', 'calendar.write', 'contacts.read'],
      'update':     ['calendar.read', 'calendar.write', 'email.read', 'email.write'],
      'delete':     ['calendar.read', 'calendar.write'],
      'remove':     ['calendar.read', 'calendar.write'],
      'set up':     ['calendar.read', 'calendar.write', 'contacts.read'],
      'arrange':    ['calendar.read', 'calendar.write', 'contacts.read'],
      'add':        ['calendar.read', 'calendar.write', 'contacts.read'],
      'put':        ['calendar.read', 'calendar.write', 'contacts.read'],
      'move':       ['calendar.read', 'calendar.write', 'contacts.read'],
      'invite':     ['calendar.read', 'calendar.write', 'contacts.read'],
      'prepare':    ['email.read', 'email.write', 'contacts.read'],
      'prep':       ['email.read', 'email.write', 'contacts.read'],
      'notify':     ['notifications.watch', 'email.read', 'calendar.read'],
      'alert':      ['notifications.watch', 'email.read', 'calendar.read'],
      'watch':      ['notifications.watch', 'email.read', 'calendar.read'],
    };
    const msgLower = msg.toLowerCase();
    const matchedVerb = Object.keys(WRITE_VERB_NS).find(v => new RegExp(`\\b${v}\\b`).test(msgLower));
    if (matchedVerb) {
      const ns = WRITE_VERB_NS[matchedVerb];
      console.log(
        `[route-v2] safety net 2: overriding chat→smart (workflow_verb="${matchedVerb}", classifier_conf=${layer0C.confidence})`,
      );
      layer0C.agent = "smart";
      layer0C.allowedNamespaces = [...new Set([...ns, ...CHAT_NAMESPACES])] as ToolNamespace[];
      layer0C.routeReason = `workflow_verb_override:${matchedVerb}`;
      layer0C.confidence = Math.max(layer0C.confidence, 0.85);
    }
  }

  // Safety net 3: classifier returned very low confidence (likely parse failure)
  // but message clearly needs tools — upgrade to smart with required.
  if (layer0C.confidence <= 0.3 && layer0C.agent === "chat") {
    const lowerMsg = msg.toLowerCase();
    const needsEmail = /\b(email|inbox|unread|gmail|outlook)\b/i.test(lowerMsg);
    const needsCalendar = /\b(calendar|schedule|what'?s on|meeting|event|appointment|free at|busy at)\b/i.test(lowerMsg);
    const needsTravel = /\b(how (long|far)|directions?|train|tram|bus|transit|drive to|walk to|travel time|from .{1,30} to)\b/i.test(lowerMsg);
    const needsWeather = /\b(weather|forecast|rain|temperature|degrees|umbrella)\b/i.test(lowerMsg);
    const needsReminder = /\b(remind|reminder|nudge)\b/i.test(lowerMsg);

    if (needsEmail || needsCalendar || needsTravel || needsWeather || needsReminder) {
      const ns: ToolNamespace[] = [...CHAT_NAMESPACES];
      if (needsEmail) ns.push("email.read", "email.write", "contacts.read");
      if (needsCalendar) ns.push("calendar.read", "calendar.write", "contacts.read");
      if (needsTravel) ns.push("travel.search");
      if (needsWeather) ns.push("weather.search");
      if (needsReminder) ns.push("reminders.manage");
      const unique = [...new Set(ns)];

      console.log(
        `[route-v2] safety net (parse failure): overriding chat→smart (conf=${layer0C.confidence}, keywords=[${[needsEmail && "email", needsCalendar && "calendar", needsTravel && "travel", needsWeather && "weather", needsReminder && "reminder"].filter(Boolean).join(",")}])`,
      );
      layer0C.agent = "smart";
      layer0C.allowedNamespaces = unique;
      layer0C.forcedToolChoice = "required";
      layer0C.routeReason = `parse_failure_safety_net:${classifierReason}`;
    }
  }

  // Safety net 4 (was 3): personal_recall disqualifier fired but classifier
  // produced namespaces that miss knowledge.search / calendar.read / granola.read.
  // This happens when hasPendingState bypasses the deterministic fast-lane.
  if (disqualifier === 'personal_recall') {
    const recallNs: ToolNamespace[] = [...RECALL_NAMESPACES];
    const existing = new Set(layer0C.allowedNamespaces);
    let enriched = false;
    for (const ns of recallNs) {
      if (!existing.has(ns)) {
        layer0C.allowedNamespaces.push(ns);
        enriched = true;
      }
    }
    if (layer0C.agent === "chat") {
      layer0C.agent = "smart";
      enriched = true;
    }
    if (!layer0C.primaryDomain || layer0C.primaryDomain !== "recall") {
      layer0C.primaryDomain = "recall";
      enriched = true;
    }
    layer0C.needsMemoryRead = true;
    layer0C.memoryDepth = "full";
    if (enriched) {
      console.log(
        `[route-v2] safety net 3: enriched recall namespaces for personal_recall (ns=[${layer0C.allowedNamespaces.join(",")}])`,
      );
      layer0C.routeReason = `recall_enriched:${classifierReason}`;
    }
  }

  if (input.isOnboarding) applyOnboardingConstraints(layer0C);

  console.log(
    `[route-v2] Layer 0C (classifier): agent=${layer0C.agent}, domain=${layer0C.primaryDomain}, reason=${layer0C.routeReason}, latency=${layer0C.routerLatencyMs}ms`,
  );
  return layer0C;
}
