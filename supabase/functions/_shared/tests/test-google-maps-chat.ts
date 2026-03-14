/**
 * End-to-end chat tests for Google Maps tools (places_search + travel_time).
 * Tests real user messages through the full handleTurn pipeline.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-google-maps-chat.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const TIMEZONE = 'Australia/Sydney';

interface ChatTest {
  id: string;
  message: string;
  expectTools: string[];
  expectInResponse?: string[];
  expectNotInResponse?: string[];
  description: string;
}

const TESTS: ChatTest[] = [
  {
    id: 'places-coffee-near-me',
    message: 'Where is the best coffee near Melbourne CBD?',
    expectTools: ['places_search'],
    expectInResponse: ['coffee'],
    description: 'Should use places_search for "best coffee near" query',
  },
  {
    id: 'places-restaurant-reco',
    message: 'Can you recommend a good restaurant near Federation Square?',
    expectTools: ['places_search'],
    description: 'Should use places_search for restaurant recommendation',
  },
  {
    id: 'travel-driving-time',
    message: 'How long to drive from Melbourne CBD to the airport?',
    expectTools: ['travel_time'],
    description: 'Should use travel_time for driving duration query',
  },
  {
    id: 'travel-transit',
    message: 'What is the next train from Flinders Street to Caulfield?',
    expectTools: ['travel_time'],
    description: 'Should use travel_time with transit mode for train query',
  },
  {
    id: 'travel-walking',
    message: 'How far is it to walk from Federation Square to South Yarra?',
    expectTools: ['travel_time'],
    description: 'Should use travel_time with walking mode',
  },
  {
    id: 'places-phone-number',
    message: "What's the phone number for Higher Ground in Melbourne?",
    expectTools: ['places_search'],
    description: 'Should use places_search to find business phone number',
  },
  {
    id: 'travel-can-i-make-it',
    message: 'Can I get from South Yarra to Melbourne Airport in 30 minutes by car?',
    expectTools: ['travel_time'],
    description: 'Should use travel_time and give a yes/no answer with actual time',
  },
  {
    id: 'places-bars',
    message: 'Best bars in Fitzroy Melbourne?',
    expectTools: ['places_search'],
    description: 'Should use places_search for bar recommendations',
  },
  {
    id: 'travel-bus',
    message: 'How do I get from Richmond to St Kilda by bus?',
    expectTools: ['travel_time'],
    description: 'Should use travel_time with transit mode for bus query',
  },
  {
    id: 'places-open-now',
    message: 'Any good cafes open right now near South Melbourne?',
    expectTools: ['places_search'],
    expectInResponse: ['open'],
    description: 'Should use places_search and mention open/closed status',
  },
];

const nestUser = await ensureNestUser(SENDER, BOT);
console.log(`authUserId: ${nestUser.authUserId}\n`);

if (!nestUser.authUserId) {
  console.log('FATAL: No authUserId');
  Deno.exit(1);
}

let passed = 0;
let failed = 0;

for (const test of TESTS) {
  const chatId = `TEST#maps#${test.id}`;
  await clearConversation(chatId).catch(() => {});

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TEST: ${test.id}`);
  console.log(`DESC: ${test.description}`);
  console.log(`MSG:  "${test.message}"`);
  console.log(`${'─'.repeat(70)}`);

  try {
    const result = await handleTurn({
      chatId,
      userMessage: test.message,
      images: [],
      audio: [],
      senderHandle: SENDER,
      isGroupChat: false,
      participantNames: [],
      chatName: null,
      authUserId: nestUser.authUserId,
      isOnboarding: false,
      timezone: TIMEZONE,
    });

    const agent = result.trace.agentName;
    // deno-lint-ignore no-explicit-any
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const response = result.text.toLowerCase();
    const failures: string[] = [];

    for (const tool of test.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`missing tool: ${tool} (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (test.expectInResponse) {
      for (const keyword of test.expectInResponse) {
        if (!response.includes(keyword.toLowerCase())) {
          failures.push(`response missing keyword: "${keyword}"`);
        }
      }
    }

    if (test.expectNotInResponse) {
      for (const keyword of test.expectNotInResponse) {
        if (response.includes(keyword.toLowerCase())) {
          failures.push(`response should NOT contain: "${keyword}"`);
        }
      }
    }

    const status = failures.length === 0 ? 'PASS' : 'FAIL';
    if (failures.length === 0) passed++; else failed++;

    console.log(`AGENT:    ${agent}`);
    console.log(`TOOLS:    ${tools.join(', ') || '(none)'}`);
    console.log(`LATENCY:  ${result.trace.totalMs}ms`);
    console.log(`RESPONSE: ${result.text.slice(0, 400)}${result.text.length > 400 ? '...' : ''}`);
    console.log(`STATUS:   ${status}`);
    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAILURE: ${f}`);
    }
  } catch (e) {
    failed++;
    console.log(`STATUS:   ERROR`);
    console.log(`  ${(e as Error).message}`);
  }
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${TESTS.length} tests`);
console.log(`${'═'.repeat(70)}`);

Deno.exit(failed > 0 ? 1 : 0);
