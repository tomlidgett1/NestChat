/**
 * Quick regex-only validation — no API calls, instant results.
 * Tests that the disqualifier regexes match/don't match as expected.
 *
 * Run:
 *   deno run --allow-all supabase/functions/_shared/tests/test-regex-quick.ts
 */

const PERSONAL_SYSTEM_NOUNS =
  /\b(inbox|calendar|schedule|emails?|gmail|outlook|contacts?|messages?|account|granola)\b/i;

const WORKFLOW_VERBS =
  /\b(send|draft|book|remind|schedule|cancel|delete|create|update|forward|compose|set up|arrange)\b/i;

const TEMPORAL_SIGNALS =
  /\b(today|tomorrow|tonight|yesterday|last night|last weekend|on the weekend|this week|next week|next month|this weekend|right now|currently|latest|current|open now|later today|later tonight|this morning|this afternoon|this evening|this arvo|at the moment)\b/i;

const EXPLICIT_TIME =
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

const LOCAL_OR_TRAVEL =
  /\b(near me|near \w{2,}|nearest|directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|open now|walk to|drive to|cycle to|train from .{1,40} to|flight from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to)/i;

const EVENT_TIME_QUERY =
  /\b(what time|when does|when is|when'?s|what time'?s|what day is|who'?s playing|who won|what'?s the score|what'?s on at|kick'?s? off|bounce|first ball|starts? at|line-?up|team sheet|fixture)\b/i;

const WEATHER_PRICE_LIVE =
  /\b(weather|forecast|rain(ing)?|temperature|degrees|humid|cold .{0,10}outside|hot .{0,10}outside|warm .{0,10}outside|freezing|sunny|cloudy|storm|snow(ing)?|stock|shares?|share price|price of|how much does .{1,30} cost|how much is .{1,20} worth|bitcoin|crypto|btc|eth|asx|nasdaq|dow jones|exchange rate|interest rate)\b/i;

const NEWS_CURRENT =
  /\b(news about|any news|what happened with|what'?s going on with|what'?s happening|latest on|update on|updates? about|breaking)\b/i;

const LOOKUP_VERBS =
  /\b(look up|find|search for|check on|check if|google|number for|address of|phone number|contact info|reviews? of|reviews? for|rating for|rated)\b/i;

const LOCATION_INTENT =
  /\b(best .{1,30} in [A-Z][a-z]|good .{1,30} in [A-Z][a-z]|top .{1,30} in [A-Z][a-z]|where can I .{1,30} in [A-Z][a-z]|where to .{1,30} in [A-Z][a-z]|places to .{1,30} in [A-Z][a-z])/i;

const HIDDEN_PERSONAL =
  /\b(what'?s on tomorrow|what'?s on today|any emails|any unread|did [A-Z][a-z]+ reply|did [A-Z][a-z]+ respond|free after|busy at|available at|what'?s in my|check my|show me my|my inbox|my calendar|my schedule|my contacts|my emails|meeting notes|what was discussed|what did we discuss|notes from .{1,20} meeting|how many emails|how many meetings)\b/i;

const SAFE_CASUAL_EXPANDED =
  /^(hey|hi|hello|yo|sup|hiya|howdy|thanks|thank you|cheers|thx|nice|cool|awesome|perfect|amazing|wow|damn|omg|wtf|lol|haha|hahaha|lmao|rofl|bye|cya|see ya|later|ttyl|good morning|morning|gm|gn|night|hey!|hi!|hello!|hey\?|hello\?|hi\?|what'?s up\??|whats up\??|sup\??|how are you\??|how'?s it going\??|how'?s things\??|hey,? how are you\??|hey,? what'?s up\??|hey,? how'?s it going\??|hey whats up|yo what'?s up|no worries|fair enough|huh|hmm|ah|oh|interesting|right|true|same|word|bet|aight|all good|sounds good|ok|okay|k|kk|sure|yep|yup|nah|nope|yeah|na|great|yes|no|\?|!)$/i;

type Bucket = string;

function matchedDisqualifier(message: string): Bucket | null {
  if (PERSONAL_SYSTEM_NOUNS.test(message)) return 'personal_system_nouns';
  if (WORKFLOW_VERBS.test(message)) return 'workflow_verbs';
  if (TEMPORAL_SIGNALS.test(message)) return 'temporal_signals';
  if (EXPLICIT_TIME.test(message)) return 'explicit_time';
  if (LOCAL_OR_TRAVEL.test(message)) return 'local_or_travel';
  if (EVENT_TIME_QUERY.test(message)) return 'event_time_query';
  if (WEATHER_PRICE_LIVE.test(message)) return 'weather_price_live';
  if (NEWS_CURRENT.test(message)) return 'news_current';
  if (LOOKUP_VERBS.test(message)) return 'lookup_verbs';
  if (LOCATION_INTENT.test(message)) return 'location_intent';
  if (HIDDEN_PERSONAL.test(message)) return 'hidden_personal';
  return null;
}

function isSafeCasual(msg: string): boolean {
  if (msg.length > 16) return false;
  return SAFE_CASUAL_EXPANDED.test(msg);
}

function route(rawMsg: string): string {
  const msg = rawMsg.trim().replace(/\s+/g, ' ');
  const disq = matchedDisqualifier(msg);
  if (disq) return `0C (${disq})`;
  if (isSafeCasual(msg)) return '0B-casual';
  return '0B-knowledge';
}

interface Test {
  message: string;
  expect: string; // '0C' or '0B-knowledge' or '0B-casual'
  description: string;
}

const tests: Test[] = [
  // ── Should be Lane 3 ──
  { message: "Whats the weather like in Melbourne", expect: "0C", description: "weather" },
  { message: "Is it going to rain tomorrow", expect: "0C", description: "rain + tomorrow" },
  { message: "How cold is it outside", expect: "0C", description: "temperature implicit" },
  { message: "Whats the bitcoin price", expect: "0C", description: "bitcoin" },
  { message: "How much does a Tesla Model 3 cost", expect: "0C", description: "how much does X cost" },
  { message: "How is the ASX going", expect: "0C", description: "ASX" },
  { message: "Whats the exchange rate AUD to USD", expect: "0C", description: "exchange rate" },
  { message: "Any news about the Ukraine war", expect: "0C", description: "any news" },
  { message: "What happened with that earthquake in Japan", expect: "0C", description: "what happened with" },
  { message: "Whats going on with OpenAI", expect: "0C", description: "whats going on with" },
  { message: "Latest on the interest rate decision", expect: "0C", description: "latest on" },
  { message: "Look up the number for Pellegrinis", expect: "0C", description: "look up + number for" },
  { message: "Find me a good dentist in South Yarra", expect: "0C", description: "find + location" },
  { message: "Reviews of Higher Ground Melbourne", expect: "0C", description: "reviews of" },
  { message: "Search for flights to Bali", expect: "0C", description: "search for" },
  { message: "Best pizza in Richmond", expect: "0C", description: "best X in Place" },
  { message: "Good bars in Fitzroy", expect: "0C", description: "good X in Place" },
  { message: "Top ramen spots in Melbourne CBD", expect: "0C", description: "top X in Place" },
  { message: "Where can I get a good haircut in Prahran", expect: "0C", description: "where can I in Place" },
  { message: "Check my calendar for next week", expect: "0C", description: "check my + calendar" },
  { message: "Show me my contacts", expect: "0C", description: "show me my" },
  { message: "What was discussed in the standup", expect: "0C", description: "what was discussed" },
  { message: "Notes from the team meeting", expect: "0C", description: "notes from meeting" },
  { message: "How many unread emails do I have", expect: "0C", description: "how many emails" },
  { message: "Nice, anyway im going to the footy later at the g, what time s bounce?", expect: "0C", description: "THE ORIGINAL BUG" },
  { message: "What time does the Melbourne game start", expect: "0C", description: "what time" },
  { message: "Who won the cricket last night", expect: "0C", description: "who won" },
  { message: "Whats the score in the game", expect: "0C", description: "whats the score" },
  { message: "Hey can you check if Sarah replied to my email", expect: "0C", description: "compound personal" },
  { message: "Whats the weather and do I have anything on tomorrow", expect: "0C", description: "compound weather+calendar" },
  { message: "I need to find a good mechanic, any recommendations", expect: "0C", description: "find + recommendation" },
  { message: "How much is an Uber from the city to the airport", expect: "0C", description: "from X to Y" },
  { message: "Whats the number for the closest pizza place", expect: "0C", description: "number for" },
  { message: "Is Lune Croissanterie open right now", expect: "0C", description: "open + right now" },
  { message: "Any updates about the train strike", expect: "0C", description: "updates about" },
  { message: "Whos the CEO of Tesla currently", expect: "0C", description: "currently" },
  { message: "Check on my order from Amazon", expect: "0C", description: "check on" },
  { message: "Google the opening hours of Coles Ashburton", expect: "0C", description: "google" },
  { message: "Whats the interest rate at the moment", expect: "0C", description: "interest rate + at the moment" },
  { message: "Did Ryan reply to that email", expect: "0C", description: "did X reply" },

  // ── Should stay Lane 2 ──
  { message: "What is photosynthesis", expect: "0B-knowledge", description: "pure knowledge" },
  { message: "Tell me about the Roman Empire", expect: "0B-knowledge", description: "pure knowledge" },
  { message: "How do aeroplanes fly", expect: "0B-knowledge", description: "pure knowledge" },
  { message: "Write me a poem about the ocean", expect: "0B-knowledge", description: "creative" },
  { message: "Explain quantum computing simply", expect: "0B-knowledge", description: "knowledge" },
  { message: "What are the rules of cricket", expect: "0B-knowledge", description: "sport rules" },
  { message: "Summarise the plot of Inception", expect: "0B-knowledge", description: "knowledge" },
  { message: "Whats the difference between latte and cappuccino", expect: "0B-knowledge", description: "knowledge" },
  { message: "How does gravity work", expect: "0B-knowledge", description: "knowledge" },
  { message: "Tell me about Japanese culture", expect: "0B-knowledge", description: "knowledge" },
  { message: "What is the capital of Mongolia", expect: "0B-knowledge", description: "knowledge" },
  { message: "Explain the offside rule in football", expect: "0B-knowledge", description: "knowledge" },
  { message: "Help me rewrite this sentence more formally", expect: "0B-knowledge", description: "writing help" },

  // ── Should stay Lane 1 ──
  { message: "Hey", expect: "0B-casual", description: "greeting" },
  { message: "Thanks", expect: "0B-casual", description: "thanks" },
  { message: "Wow", expect: "0B-casual", description: "reaction" },
  { message: "Interesting", expect: "0B-casual", description: "reaction" },
  { message: "Ok", expect: "0B-casual", description: "acknowledgement" },
  { message: "Lol", expect: "0B-casual", description: "reaction" },
];

let p = 0;
let f = 0;
const fails: string[] = [];

for (const t of tests) {
  const actual = route(t.message);
  const actualLane = actual.startsWith('0C') ? '0C' : actual;
  if (actualLane === t.expect) {
    p++;
    console.log(`  ✅ "${t.message}" → ${actual}`);
  } else {
    f++;
    fails.push(`"${t.message}" — expected ${t.expect}, got ${actual}`);
    console.log(`  ❌ "${t.message}" → ${actual} (expected ${t.expect})`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Regex-only results: ${p}/${tests.length} passed, ${f} failed`);

if (fails.length > 0) {
  console.log('\nFailures:');
  for (const fl of fails) console.log(`  • ${fl}`);
}

if (f > 0) Deno.exit(1);
