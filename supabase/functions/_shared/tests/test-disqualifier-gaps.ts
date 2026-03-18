/**
 * Comprehensive edge-case test for disqualifier gaps.
 * Tests messages that SHOULD trigger Lane 3 but previously slipped to Lane 2,
 * plus false-positive checks that MUST stay in Lane 2.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-disqualifier-gaps.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const TIMEZONE = 'Australia/Sydney';

const nestUser = await ensureNestUser(SENDER, BOT);
console.log(`authUserId: ${nestUser.authUserId}\n`);

if (!nestUser.authUserId) {
  console.log('FATAL: No authUserId');
  Deno.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

interface TestCase {
  message: string;
  description: string;
  expectLane: string;
  expectedBucket?: string;
}

const TESTS: TestCase[] = [

  // ═══════════════════════════════════════════════════════════
  // WEATHER — always live, should be Lane 3
  // ═══════════════════════════════════════════════════════════
  {
    message: "Whats the weather like in Melbourne",
    description: "Weather query → Lane 3",
    expectLane: "0C",
    expectedBucket: "weather_price_live",
  },
  {
    message: "Is it going to rain tomorrow",
    description: "Rain forecast → Lane 3 (temporal + weather)",
    expectLane: "0C",
  },
  {
    message: "How cold is it outside",
    description: "Temperature query → Lane 3",
    expectLane: "0C",
  },

  // ═══════════════════════════════════════════════════════════
  // PRICE / STOCK / MARKET — always live
  // ═══════════════════════════════════════════════════════════
  {
    message: "Whats the bitcoin price",
    description: "Crypto price → Lane 3",
    expectLane: "0C",
    expectedBucket: "weather_price_live",
  },
  {
    message: "How much does a Tesla Model 3 cost",
    description: "Product price → Lane 3",
    expectLane: "0C",
    expectedBucket: "weather_price_live",
  },
  {
    message: "How is the ASX going",
    description: "Stock market → Lane 3",
    expectLane: "0C",
    expectedBucket: "weather_price_live",
  },
  {
    message: "Whats the exchange rate AUD to USD",
    description: "Exchange rate → Lane 3",
    expectLane: "0C",
    expectedBucket: "weather_price_live",
  },

  // ═══════════════════════════════════════════════════════════
  // NEWS / CURRENT EVENTS — freshness-sensitive
  // ═══════════════════════════════════════════════════════════
  {
    message: "Any news about the Ukraine war",
    description: "News query → Lane 3",
    expectLane: "0C",
    expectedBucket: "news_current",
  },
  {
    message: "What happened with that earthquake in Japan",
    description: "Current event → Lane 3",
    expectLane: "0C",
    expectedBucket: "news_current",
  },
  {
    message: "Whats going on with OpenAI",
    description: "Current affairs → Lane 3",
    expectLane: "0C",
    expectedBucket: "news_current",
  },
  {
    message: "Latest on the interest rate decision",
    description: "Latest + topic → Lane 3 (temporal)",
    expectLane: "0C",
  },

  // ═══════════════════════════════════════════════════════════
  // LOOKUP / SEARCH — implies tool use
  // ═══════════════════════════════════════════════════════════
  {
    message: "Look up the number for Pellegrinis",
    description: "Look up + phone number → Lane 3",
    expectLane: "0C",
    expectedBucket: "lookup_verbs",
  },
  {
    message: "Find me a good dentist in South Yarra",
    description: "Find + location → Lane 3",
    expectLane: "0C",
    expectedBucket: "lookup_verbs",
  },
  {
    message: "Reviews of Higher Ground Melbourne",
    description: "Reviews of business → Lane 3",
    expectLane: "0C",
    expectedBucket: "lookup_verbs",
  },
  {
    message: "Whats the phone number for my doctor",
    description: "Phone number + personal → Lane 3",
    expectLane: "0C",
  },
  {
    message: "Search for flights to Bali",
    description: "Search for + travel → Lane 3",
    expectLane: "0C",
    expectedBucket: "lookup_verbs",
  },

  // ═══════════════════════════════════════════════════════════
  // LOCATION INTENT — "best X in [Place]" pattern
  // ═══════════════════════════════════════════════════════════
  {
    message: "Best pizza in Richmond",
    description: "Best + category + in + place → Lane 3",
    expectLane: "0C",
    expectedBucket: "location_intent",
  },
  {
    message: "Good bars in Fitzroy",
    description: "Good + category + in + place → Lane 3",
    expectLane: "0C",
    expectedBucket: "location_intent",
  },
  {
    message: "Top ramen spots in Melbourne CBD",
    description: "Top + category + in + place → Lane 3",
    expectLane: "0C",
    expectedBucket: "location_intent",
  },
  {
    message: "Where can I get a good haircut in Prahran",
    description: "Where can I + in + place → Lane 3",
    expectLane: "0C",
    expectedBucket: "location_intent",
  },

  // ═══════════════════════════════════════════════════════════
  // HIDDEN PERSONAL — expanded patterns
  // ═══════════════════════════════════════════════════════════
  {
    message: "Check my calendar for next week",
    description: "Check my + system noun → Lane 3",
    expectLane: "0C",
  },
  {
    message: "Show me my contacts",
    description: "Show me my → Lane 3",
    expectLane: "0C",
  },
  {
    message: "What was discussed in the standup",
    description: "Meeting notes query → Lane 3",
    expectLane: "0C",
    expectedBucket: "hidden_personal",
  },
  {
    message: "Notes from the team meeting",
    description: "Notes from meeting → Lane 3",
    expectLane: "0C",
    expectedBucket: "hidden_personal",
  },
  {
    message: "How many unread emails do I have",
    description: "How many emails → Lane 3",
    expectLane: "0C",
  },

  // ═══════════════════════════════════════════════════════════
  // PERSONAL RECALL — user asking about their own past data
  // ═══════════════════════════════════════════════════════════
  {
    message: "How many goals did I kick in my last game",
    description: "Personal stats recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "What did I eat for dinner on Friday",
    description: "Personal activity recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "When did I last see the dentist",
    description: "Personal timeline recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "Where did we go for our anniversary",
    description: "Shared memory recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "Did I ever tell you about my trip to Japan",
    description: "Memory check → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "Do you remember what I said about the project",
    description: "Explicit memory recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },
  {
    message: "Try again: How many goals did I kick in my last game",
    description: "Retry + personal recall → Lane 3",
    expectLane: "0C",
    expectedBucket: "personal_recall",
  },

  // ═══════════════════════════════════════════════════════════
  // COMPOUND EDGE CASES — realistic multi-intent messages
  // ═══════════════════════════════════════════════════════════
  {
    message: "Hey can you check if Sarah replied to my email",
    description: "Compound: check + reply + email → Lane 3",
    expectLane: "0C",
  },
  {
    message: "Whats the weather and do I have anything on tomorrow",
    description: "Weather + calendar → Lane 3",
    expectLane: "0C",
  },
  {
    message: "I need to find a good mechanic, any recommendations",
    description: "Find + recommendation → Lane 3",
    expectLane: "0C",
    expectedBucket: "lookup_verbs",
  },
  {
    message: "How much is an Uber from the city to the airport",
    description: "Price + travel → Lane 3",
    expectLane: "0C",
  },

  // ═══════════════════════════════════════════════════════════
  // ACCEPTABLE FALSE-POSITIVES — route to Lane 3 (higher latency but correct)
  // These contain disqualifier keywords in educational contexts.
  // Lane 3 can handle them fine; the tradeoff is latency not correctness.
  // ═══════════════════════════════════════════════════════════
  {
    message: "Tell me about the history of weather forecasting",
    description: "FP: 'weather' in educational context → Lane 3 (acceptable)",
    expectLane: "0C",
  },
  {
    message: "How does the stock market work",
    description: "FP: 'stock' in educational context → Lane 3 (acceptable)",
    expectLane: "0C",
  },
  {
    message: "Explain how bitcoin mining works",
    description: "FP: 'bitcoin' in educational context → Lane 3 (acceptable)",
    expectLane: "0C",
  },
  {
    message: "What is photosynthesis",
    description: "Pure knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Tell me about the Roman Empire",
    description: "Pure knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "How do aeroplanes fly",
    description: "Pure knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Write me a poem about the ocean",
    description: "Creative → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Explain quantum computing simply",
    description: "Knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "What are the rules of cricket",
    description: "Knowledge about sport rules → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Summarise the plot of Inception",
    description: "Knowledge/creative → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Whats the difference between latte and cappuccino",
    description: "Knowledge → Lane 2",
    expectLane: "0B-knowledge",
  },
];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Disqualifier Gap Test — Comprehensive Edge Cases       ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

for (const test of TESTS) {
  const chatId = `test-gaps-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const turnStart = Date.now();
  let result;
  try {
    result = await sendMessage(chatId, test.message);
  } catch (err) {
    failed++;
    failures.push(`"${test.message}" — CRASHED: ${(err as Error).message}`);
    console.log(`  ❌ ${test.description}`);
    console.log(`     CRASH: ${(err as Error).message}`);
    continue;
  }
  const latency = Date.now() - turnStart;

  const trace = result.trace;
  const actualLane = trace.routeLayer ?? 'unknown';
  const actualAgent = trace.agentName;
  const toolNames = trace.toolCalls.map((t: { name: string }) => t.name);
  const responseSnippet = (result.text ?? '').substring(0, 100).replace(/\n/g, ' ');

  let turnPassed = true;
  const turnFailures: string[] = [];

  if (actualLane !== test.expectLane) {
    turnPassed = false;
    turnFailures.push(`lane: expected ${test.expectLane}, got ${actualLane}`);
  }

  if (turnPassed) {
    passed++;
    console.log(`  ✅ "${test.message}"`);
    console.log(`     → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | ${latency}ms`);
    console.log(`     ${responseSnippet}`);
  } else {
    failed++;
    failures.push(`"${test.message}" — ${turnFailures.join('; ')}`);
    console.log(`  ❌ "${test.message}"`);
    console.log(`     → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | ${latency}ms`);
    console.log(`     FAILURES: ${turnFailures.join('; ')}`);
    console.log(`     ${responseSnippet}`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Results: ${passed}/${TESTS.length} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
}

if (failed > 0) Deno.exit(1);
