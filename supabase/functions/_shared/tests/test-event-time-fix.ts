/**
 * Quick targeted test for the event-time disqualifier fix.
 * Verifies that sports/event/time queries route to Lane 3.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-event-time-fix.ts
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
  expectDisqualifier?: string;
}

const TESTS: TestCase[] = [
  {
    message: "Nice, anyway im going to the footy later at the g, what time s bounce?",
    description: "THE ORIGINAL BUG — footy bounce time",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "What time does the Melbourne game start",
    description: "What time + game start",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "When does the footy kick off",
    description: "When does + kick off",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "Who won the cricket last night",
    description: "Who won — live/current sports",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "Whats the score in the game",
    description: "What's the score — live sports",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "When is the next F1 race",
    description: "When is — event query",
    expectLane: "0C",
    expectDisqualifier: "event_time_query",
  },
  {
    message: "Whos playing tonight at the MCG",
    description: "Who's playing + tonight",
    expectLane: "0C",
  },
  {
    message: "What time is the concert this arvo",
    description: "What time + this arvo",
    expectLane: "0C",
  },
  // False-positive checks — these should stay Lane 2
  {
    message: "Tell me about the history of cricket",
    description: "Static knowledge about cricket → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "How does AFL scoring work",
    description: "Static knowledge about AFL → Lane 2",
    expectLane: "0B-knowledge",
  },
  {
    message: "Explain the offside rule in football",
    description: "Static knowledge about football → Lane 2",
    expectLane: "0B-knowledge",
  },
  // Temporal signals that should trigger Lane 3
  {
    message: "Best restaurants open now in Fitzroy",
    description: "open now + near location → Lane 3",
    expectLane: "0C",
  },
  {
    message: "Whats happening this weekend in Melbourne",
    description: "this weekend → Lane 3",
    expectLane: "0C",
  },
];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Event-Time Disqualifier Fix — Targeted Test            ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

for (const test of TESTS) {
  const chatId = `test-event-fix-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
