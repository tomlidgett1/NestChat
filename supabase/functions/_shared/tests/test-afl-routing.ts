/**
 * AFL / Footy routing tests — regex-only validation + live E2E.
 * Verifies that AFL, footy, aussie rules queries route correctly:
 *   - Temporal/live queries → Lane 3 (0C) or research fast lane (0B-research)
 *   - Static knowledge queries → Lane 2 (0B-knowledge)
 *
 * Run (regex only — instant, no API calls):
 *   deno run --allow-all supabase/functions/_shared/tests/test-afl-routing.ts
 *
 * Run (full E2E — requires .env with API keys):
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-afl-routing.ts --e2e
 */

// ═══════════════════════════════════════════════════════════════
// Import regex patterns from route-turn-v2 (duplicated for offline testing)
// ═══════════════════════════════════════════════════════════════

const PERSONAL_SYSTEM_NOUNS =
  /\b(inbox|calendar|schedule|emails?|gmail|outlook|contacts?|messages?|account|granola|meetings?)\b/i;

const WORKFLOW_VERBS =
  /\b(send|draft|book|remind|schedule|cancel|delete|create|update|forward|compose|set up|arrange|prepare|prep|respond|reply)\b/i;

const TEMPORAL_SIGNALS =
  /\b(today|tomorrow|tonight|yesterday|last night|last weekend|on the weekend|this week|next week|next month|this weekend|right now|currently|latest|current|open now|later today|later tonight|this morning|this afternoon|this evening|this arvo|at the moment|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const TEMPORAL_RANGE_OVERRIDE = /\b(from .{1,50} to today|until today|through today|to the present|to today)\b/i;

const EXPLICIT_TIME =
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

const LOCAL_OR_TRAVEL =
  /\b(near me|near \w{2,}|nearest|directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|open now|walk to|drive to|cycle to|going to .{1,40}(street|st|road|rd|ave|avenue|blvd|boulevard|drive|dr|place|pl|lane|ln|way|crescent|cr|parade|pde|club|hotel|station|uni|university|hospital|airport|park|gardens?|square|mall|centre|center|tower|house)|heading to .{1,40}(street|st|road|rd|club|hotel|station|airport|park)|train from .{1,40} to|flight from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to)/i;

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

const SAFE_CASUAL_EXPANDED =
  /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|perfect|amazing|wow|damn|omg|wtf|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;
const DAYPART_GREETING =
  /^(good\s+)?(morning|afternoon|evening|night)[!.?]*$|^(gm|gn)[!.?]*$/i;

const SPORTS_PATTERN =
  /\b(playing|play|game|match|fixture|verse|vs\.?|bounce|kick off|lineup|line-?up|team sheet|season|round\s+\d|score|scored|won|lost|beat|defeated|premiership|grand final|semi|final|derby|ladder|standings|draw|afl|nrl|nba|nfl|epl|a-?league|big ?bash|bbl)\b/i;

const AFL_FOOTY_PATTERN =
  /\b(afl|footy|footie|aussie rules|australian football|sherrin|brownlow|coleman|norm smith|crichton|rising star|mark of the year|goal of the year|afl draft|trade period|afl trade|pre-?season|jlt|marsh series|gather round|magic round|dreamtime|anzac day (game|match|eve)|indigenous round|pride (game|round|match)|sir doug nicholls|showdown|q-?clash|western derby|elimination final|qualifying final|preliminary final|bye round|bye week|wafl|sanfl|vfl|aflw)\b/i;

const AFL_TEAM_PATTERN =
  /\b(adelaide crows|crows|brisbane lions|lions|carlton|blues|collingwood|magpies|pies|essendon|bombers|dons|fremantle|dockers|freo|geelong|cats|gold coast suns|suns|gws giants|giants|gws|hawthorn|hawks|melbourne demons|demons|dees|north melbourne|kangaroos|roos|port adelaide|power|port|richmond|tigers|tiges|st kilda|saints|sydney swans|swans|west coast eagles|eagles|western bulldogs|bulldogs|dogs|doggies)\b/i;

const SPORTS_LIVE_DATA =
  /\b(ladder|standings|results?|fixtures?|draw|tipping|tips|score|scores|scored|who won|who lost|who beat|who plays|who'?s playing|trade period|traded|trades?|draft|free agenc|delist|delisted|suspended|injured|injury list|team changes|ins and outs|selected|dropped|omitted|named|interchange)\b/i;

const FACTUAL_QW =
  /\b(where|when|what time|who won|who is|who are|how many|how much|how tall|how old|how long|how far|what is|what are|what was|what were|is there|are there)\b/i;

type Bucket = string;

function matchedDisqualifier(message: string): Bucket | null {
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

function isWebSearchLookup(msg: string, bucket: string): boolean {
  if (PERSONAL_SYSTEM_NOUNS.test(msg)) return false;
  if (HIDDEN_PERSONAL.test(msg)) return false;
  if (PERSONAL_RECALL.test(msg)) return false;

  if (bucket === 'weather_price_live') return true;
  if (bucket === 'news_current') return true;
  if (bucket === 'location_intent') return true;
  if (bucket === 'lookup_verbs') return true;
  if (bucket === 'event_time_query') {
    if (/\b(my|our|the)\s+flight\b|\bflight\s+time\b|\bwhen\s+(do|does|am)\s+(i|we)\s+(fly|flying|leave|depart|board)\b|\bwhat\s+time\s+(do|does|am)\s+(i|we)\s+(fly|flying|leave|depart|board)\b|\bbooking ref(?:erence)?\b|\bpnr\b|\be-?ticket\b|\bitinerary\b|\bboarding pass\b|\blounge pass\b|\b(qantas|jetstar|virgin australia|bonza|rex)\b/i.test(msg)) return false;
    return true;
  }
  if (bucket === 'sports_live_data') return true;

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

function isSafeCasual(msg: string): boolean {
  if (msg.length > 16) return false;
  return SAFE_CASUAL_EXPANDED.test(msg) || DAYPART_GREETING.test(msg);
}

function route(rawMsg: string): { lane: string; bucket: string | null; isResearch: boolean } {
  const msg = rawMsg.trim().replace(/\s+/g, ' ');
  const disq = matchedDisqualifier(msg);
  if (disq) {
    const research = isWebSearchLookup(msg, disq);
    return { lane: research ? '0B-research' : '0C', bucket: disq, isResearch: research };
  }
  if (isSafeCasual(msg)) return { lane: '0B-casual', bucket: null, isResearch: false };
  return { lane: '0B-knowledge', bucket: null, isResearch: false };
}

// ═══════════════════════════════════════════════════════════════
// Test cases
// ═══════════════════════════════════════════════════════════════

interface Test {
  message: string;
  description: string;
  expectLane: string;
  expectBucket?: string;
}

const tests: Test[] = [
  // ── AFL temporal queries → should trigger web search (0C or 0B-research) ──
  {
    message: "When does the footy start this weekend",
    description: "footy + this weekend → temporal + sports",
    expectLane: "0B-research",
    expectBucket: "temporal_signals",
  },
  {
    message: "Whats the afl ladder looking like",
    description: "afl + ladder → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "AFL results from last night",
    description: "AFL + results + last night → temporal + sports",
    expectLane: "0B-research",
    expectBucket: "temporal_signals",
  },
  {
    message: "Who won the footy last night",
    description: "who won + footy + last night → temporal + sports",
    expectLane: "0B-research",
    expectBucket: "temporal_signals",
  },
  {
    message: "Whos playing in the afl tonight",
    description: "who's playing + afl + tonight → temporal + sports",
    expectLane: "0B-research",
    expectBucket: "temporal_signals",
  },
  {
    message: "What time does the footy bounce today",
    description: "what time + footy + bounce + today",
    expectLane: "0B-research",
  },
  {
    message: "Collingwood vs Essendon what time",
    description: "team names + what time → event_time_query",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
  {
    message: "What time is the flight",
    description: "personal flight follow-up — needs email/calendar, not 0B-research",
    expectLane: "0C",
    expectBucket: "event_time_query",
  },
  {
    message: "What time am I flying to Cairns",
    description: "explicit personal departure question",
    expectLane: "0C",
    expectBucket: "event_time_query",
  },
  {
    message: "Did the cats win on the weekend",
    description: "cats (Geelong) + win + weekend → event_time_query",
    expectLane: "0B-research",
  },
  {
    message: "Whats the score in the hawks game",
    description: "score + hawks → event_time_query",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
  {
    message: "When is the brownlow medal",
    description: "brownlow medal → event_time_query (when is)",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
  {
    message: "AFL fixtures this round",
    description: "AFL + fixtures + this round → sports_live_data",
    expectLane: "0B-research",
  },
  {
    message: "Whos on top of the afl ladder right now",
    description: "afl + ladder + right now → temporal + sports",
    expectLane: "0B-research",
  },
  {
    message: "Footy tipping tips for this week",
    description: "footy + tipping + this week → temporal + sports",
    expectLane: "0B-research",
  },
  {
    message: "Richmond tigers results",
    description: "team name + results → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "Is there footy on tonight",
    description: "footy + tonight → temporal + sports",
    expectLane: "0B-research",
  },
  {
    message: "Whens the next carlton game",
    description: "when + carlton → event_time_query",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
  {
    message: "AFLW results this weekend",
    description: "AFLW + results + this weekend → sports_live_data",
    expectLane: "0B-research",
  },
  {
    message: "Who got suspended in the afl this week",
    description: "afl + suspended + this week → sports_live_data",
    expectLane: "0B-research",
  },
  {
    message: "Collingwood injury list",
    description: "team + injury list → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "Whos been traded in the afl",
    description: "afl + traded → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },

  // ── Edge cases: slang, abbreviations, Aussie vernacular ──
  {
    message: "Oi whats the footy scores",
    description: "slang + footy + scores → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "Footie results",
    description: "footie (alternate spelling) + results → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "How did the dees go",
    description: "dees (Melbourne) — no explicit temporal but team name",
    expectLane: "0B-knowledge",
  },
  {
    message: "How did the dees go last night",
    description: "dees + last night → temporal + team",
    expectLane: "0B-research",
  },
  {
    message: "Pies v dons anzac day game what time",
    description: "team abbreviations + anzac day + what time",
    expectLane: "0B-research",
  },
  {
    message: "When does the grand final start",
    description: "when does + grand final → event_time_query",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
  {
    message: "Aussie rules scores today",
    description: "aussie rules + scores + today → temporal + sports",
    expectLane: "0B-research",
  },
  {
    message: "Who is playing at the MCG this saturday",
    description: "who is playing + MCG + saturday → event_time_query + temporal",
    expectLane: "0B-research",
  },
  {
    message: "Freo dockers score",
    description: "Freo dockers + score → sports_live_data",
    expectLane: "0B-research",
    expectBucket: "sports_live_data",
  },
  {
    message: "Latest afl trade news",
    description: "latest + afl + trade → temporal + sports",
    expectLane: "0B-research",
  },

  // ── False positives: static knowledge about AFL → Lane 2 ──
  {
    message: "How does AFL scoring work",
    description: "static knowledge about AFL scoring → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "What are the rules of aussie rules",
    description: "static knowledge about rules → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "How many players on an AFL team",
    description: "static factual about AFL → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Tell me about the history of the VFL",
    description: "historical knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "What is a behind in football",
    description: "static knowledge about football terminology → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Explain the mark rule in AFL",
    description: "static rule explanation → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Who is the greatest AFL player of all time",
    description: "subjective/timeless question → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Difference between rugby and AFL",
    description: "comparison knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },

  // ── Cross-sport sanity checks ──
  {
    message: "NRL results this weekend",
    description: "NRL + results + this weekend → temporal + sports",
    expectLane: "0B-research",
  },
  {
    message: "When does the cricket start",
    description: "when does + cricket → event_time_query",
    expectLane: "0B-research",
    expectBucket: "event_time_query",
  },
];

// ═══════════════════════════════════════════════════════════════
// Run regex-only tests
// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  AFL / Footy Routing Tests — Regex Validation           ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

let p = 0;
let f = 0;
const fails: string[] = [];

for (const t of tests) {
  const { lane, bucket, isResearch } = route(t.message);
  const laneMatch = t.expectLane === '0B-research'
    ? (lane === '0B-research')
    : (lane === t.expectLane);
  const bucketMatch = !t.expectBucket || bucket === t.expectBucket;

  if (laneMatch && bucketMatch) {
    p++;
    console.log(`  ✅ "${t.message}"`);
    console.log(`     → ${lane} | bucket=${bucket ?? 'none'} | research=${isResearch}`);
  } else {
    f++;
    const reasons: string[] = [];
    if (!laneMatch) reasons.push(`lane: expected ${t.expectLane}, got ${lane}`);
    if (!bucketMatch) reasons.push(`bucket: expected ${t.expectBucket}, got ${bucket}`);
    fails.push(`"${t.message}" — ${reasons.join('; ')}`);
    console.log(`  ❌ "${t.message}" — ${t.description}`);
    console.log(`     → ${lane} | bucket=${bucket ?? 'none'} | research=${isResearch}`);
    console.log(`     FAILURES: ${reasons.join('; ')}`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Regex results: ${p}/${tests.length} passed, ${f} failed`);

if (fails.length > 0) {
  console.log('\nFailures:');
  for (const fl of fails) console.log(`  • ${fl}`);
}

// ═══════════════════════════════════════════════════════════════
// E2E tests (only if --e2e flag is passed)
// ═══════════════════════════════════════════════════════════════

const isE2E = Deno.args.includes('--e2e');

if (isE2E) {
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  AFL / Footy Routing Tests — E2E (Live)                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const { handleTurn } = await import('../orchestrator/handle-turn.ts');
  const { ensureNestUser } = await import('../state.ts');

  const SENDER = '+61414187820';
  const BOT = '+13466215973';
  const TIMEZONE = 'Australia/Melbourne';

  const nestUser = await ensureNestUser(SENDER, BOT);
  console.log(`authUserId: ${nestUser.authUserId}\n`);

  if (!nestUser.authUserId) {
    console.log('FATAL: No authUserId for E2E tests');
    Deno.exit(1);
  }

  async function sendMessage(chatId: string, message: string) {
    return handleTurn({
      chatId,
      userMessage: message,
      images: [],
      audio: [],
      senderHandle: SENDER,
      isGroupChat: false,
      participantNames: [],
      chatName: null,
      authUserId: nestUser.authUserId!,
      isOnboarding: false,
      timezone: TIMEZONE,
    });
  }

  interface E2ETest {
    message: string;
    description: string;
    expectWebSearch: boolean;
    expectLanePrefix: string;
  }

  const e2eTests: E2ETest[] = [
    {
      message: "Whats the afl ladder looking like",
      description: "AFL ladder → should web search",
      expectWebSearch: true,
      expectLanePrefix: "0B-research",
    },
    {
      message: "Who won the footy last night",
      description: "footy results → should web search",
      expectWebSearch: true,
      expectLanePrefix: "0B-research",
    },
    {
      message: "When does collingwood play next",
      description: "team fixture → should web search",
      expectWebSearch: true,
      expectLanePrefix: "0B-research",
    },
    {
      message: "Whats the score in the bombers game",
      description: "live score → should web search",
      expectWebSearch: true,
      expectLanePrefix: "0B-research",
    },
    {
      message: "AFL fixtures this round",
      description: "round fixtures → should web search",
      expectWebSearch: true,
      expectLanePrefix: "0B-research",
    },
    {
      message: "How does AFL scoring work",
      description: "static knowledge → should NOT web search",
      expectWebSearch: false,
      expectLanePrefix: "0B-knowledge",
    },
  ];

  let e2ePassed = 0;
  let e2eFailed = 0;
  const e2eFails: string[] = [];

  for (const test of e2eTests) {
    const chatId = `test-afl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const turnStart = Date.now();
    let result;
    try {
      result = await sendMessage(chatId, test.message);
    } catch (err) {
      e2eFailed++;
      e2eFails.push(`"${test.message}" — CRASHED: ${(err as Error).message}`);
      console.log(`  ❌ ${test.description}`);
      console.log(`     CRASH: ${(err as Error).message}`);
      continue;
    }
    const latency = Date.now() - turnStart;

    const trace = result.trace;
    const actualLane = trace.routeLayer ?? 'unknown';
    const toolNames = trace.toolCalls.map((t: { name: string }) => t.name);
    const hasWebSearch = toolNames.includes('web_search');
    const responseSnippet = (result.text ?? '').substring(0, 120).replace(/\n/g, ' ');

    let turnPassed = true;
    const turnFailures: string[] = [];

    if (!actualLane.startsWith(test.expectLanePrefix)) {
      turnPassed = false;
      turnFailures.push(`lane: expected ${test.expectLanePrefix}*, got ${actualLane}`);
    }

    if (test.expectWebSearch && !hasWebSearch) {
      turnPassed = false;
      turnFailures.push(`expected web_search tool call but got [${toolNames.join(',')}]`);
    }

    if (turnPassed) {
      e2ePassed++;
      console.log(`  ✅ "${test.message}"`);
      console.log(`     → ${actualLane} | tools=[${toolNames.join(',')}] | ${latency}ms`);
      console.log(`     ${responseSnippet}`);
    } else {
      e2eFailed++;
      e2eFails.push(`"${test.message}" — ${turnFailures.join('; ')}`);
      console.log(`  ❌ "${test.message}"`);
      console.log(`     → ${actualLane} | tools=[${toolNames.join(',')}] | ${latency}ms`);
      console.log(`     FAILURES: ${turnFailures.join('; ')}`);
      console.log(`     ${responseSnippet}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`E2E results: ${e2ePassed}/${e2eTests.length} passed, ${e2eFailed} failed`);

  if (e2eFails.length > 0) {
    console.log('\nE2E Failures:');
    for (const fl of e2eFails) console.log(`  • ${fl}`);
  }

  if (e2eFailed > 0) Deno.exit(1);
}

if (f > 0) Deno.exit(1);
