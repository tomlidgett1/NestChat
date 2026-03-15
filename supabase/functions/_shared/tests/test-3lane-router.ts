import { emptyWorkingMemory } from '../orchestrator/types.ts';
import type { TurnInput, WorkingMemory, RouteDecision, ToolNamespace } from '../orchestrator/types.ts';
import type { RouterContext } from '../orchestrator/build-context.ts';

// ═══════════════════════════════════════════════════════════════
// 3-Lane Deterministic Pre-Router Test Suite
//
// Tests the deterministic routing logic (Layers 0A + 0B) without
// needing an OpenAI API key. Lane 3 tests verify that the
// deterministic router returns null (i.e. would fall through to
// the classifier).
// ═══════════════════════════════════════════════════════════════

// We import routeTurnV2 but also need direct access to the
// deterministic function. Since it's not exported, we'll use
// routeTurnV2 for Lane 1/2 tests and catch the classifier error
// for Lane 3 tests. Better approach: import and test directly.
// The function is internal, so we'll replicate the test by calling
// routeTurnV2 and catching errors for Lane 3.

// Actually, let's just import the module and test the full flow.
// For Lane 3 tests, we expect the classifier to be called, which
// will fail without an API key. We catch that and treat it as
// "correctly routed to classifier".

import { routeTurnV2 } from '../orchestrator/route-turn-v2.ts';

const baseInput: TurnInput = {
  chatId: 'test-3lane',
  userMessage: '',
  images: [],
  audio: [],
  senderHandle: '+61400000000',
  isGroupChat: false,
  participantNames: [],
  chatName: null,
  authUserId: 'test-user-id',
  isOnboarding: false,
};

function makeContext(overrides?: {
  recentTurns?: Array<{ role: string; content: string }>;
  workingMemory?: Partial<WorkingMemory>;
  pendingEmailSends?: Array<{ id: number; to: string[]; subject?: string; status: string; draftId?: string; account?: string; sourceTurnId?: string }>;
}): RouterContext {
  const wm = { ...emptyWorkingMemory(), ...(overrides?.workingMemory ?? {}) };
  return {
    recentTurns: overrides?.recentTurns ?? [],
    workingMemory: wm,
    pendingEmailSend: null,
    pendingEmailSends: overrides?.pendingEmailSends ?? [],
  };
}

interface TestCase {
  name: string;
  message: string;
  expectedLane: '0B-casual' | '0B-knowledge' | '0C';
  context?: Parameters<typeof makeContext>[0];
}

const tests: TestCase[] = [
  // ── Lane 1: Instant Casual ──────────────────────────────────
  { name: 'L1: hey', message: 'hey', expectedLane: '0B-casual' },
  { name: 'L1: thanks', message: 'thanks', expectedLane: '0B-casual' },
  { name: 'L1: lol', message: 'lol', expectedLane: '0B-casual' },
  { name: 'L1: ok', message: 'ok', expectedLane: '0B-casual' },
  { name: 'L1: nice', message: 'nice', expectedLane: '0B-casual' },
  { name: 'L1: perfect', message: 'perfect', expectedLane: '0B-casual' },
  { name: 'L1: sounds good', message: 'sounds good', expectedLane: '0B-casual' },
  { name: 'L1: fair enough', message: 'fair enough', expectedLane: '0B-casual' },
  { name: 'L1: good morning', message: 'good morning', expectedLane: '0B-casual' },
  { name: 'L1: gm', message: 'gm', expectedLane: '0B-casual' },
  { name: 'L1: bye', message: 'bye', expectedLane: '0B-casual' },
  { name: 'L1: yes', message: 'yes', expectedLane: '0B-casual' },
  { name: 'L1: nah', message: 'nah', expectedLane: '0B-casual' },
  { name: 'L1: haha', message: 'haha', expectedLane: '0B-casual' },
  { name: 'L1: interesting', message: 'interesting', expectedLane: '0B-casual' },

  // ── Lane 2: Fast Static Knowledge ───────────────────────────
  { name: 'L2: tell me about Japan', message: 'tell me about Japan', expectedLane: '0B-knowledge' },
  { name: 'L2: explain OAuth simply', message: 'explain OAuth simply', expectedLane: '0B-knowledge' },
  { name: 'L2: what is the capital of France', message: 'what is the capital of France', expectedLane: '0B-knowledge' },
  { name: 'L2: how does photosynthesis work', message: 'how does photosynthesis work', expectedLane: '0B-knowledge' },
  { name: 'L2: help me rewrite this sentence', message: 'help me rewrite this sentence', expectedLane: '0B-knowledge' },
  { name: 'L2: brainstorm 10 names for a cafe', message: 'brainstorm 10 names for a cafe', expectedLane: '0B-knowledge' },
  { name: 'L2: write me a joke', message: 'write me a joke', expectedLane: '0B-knowledge' },
  { name: 'L2: whats your view on jazz', message: "what's your view on jazz", expectedLane: '0B-knowledge' },
  { name: 'L2: how do trains work', message: 'how do trains work', expectedLane: '0B-knowledge' },
  { name: 'L3: what is a standup meeting', message: 'what is a standup meeting', expectedLane: '0C' },
  { name: 'L3: meeting culture in Japan', message: 'tell me about meeting culture in Japan', expectedLane: '0C' },
  { name: 'L2: how should I reply politely', message: 'how should I reply politely', expectedLane: '0B-knowledge' },
  { name: 'L2: summarise this paragraph', message: 'summarise this paragraph', expectedLane: '0B-knowledge' },
  { name: 'L2: trams in Melbourne history', message: 'tell me about trams in Melbourne history', expectedLane: '0B-knowledge' },
  { name: 'L2: best programming languages', message: 'what are the best programming languages', expectedLane: '0B-knowledge' },
  { name: 'L2: explain quantum computing', message: 'explain quantum computing', expectedLane: '0B-knowledge' },
  { name: 'L2: what is machine learning', message: 'what is machine learning', expectedLane: '0B-knowledge' },
  { name: 'L2: tell me a fun fact', message: 'tell me a fun fact', expectedLane: '0B-knowledge' },
  { name: 'L2: whats the difference between HTTP and HTTPS', message: "what's the difference between HTTP and HTTPS", expectedLane: '0B-knowledge' },

  // ── Lane 3: Classifier (disqualifier: meeting prep intent) ─────
  { name: 'L3: help me prepare for my Monday meeting', message: 'Please help me prepare for my Monday meeting', expectedLane: '0C' },
  { name: 'L3: prep me for the standup', message: 'prep me for the standup', expectedLane: '0C' },
  { name: 'L3: brief me for the 1:1', message: 'brief me for the 1:1', expectedLane: '0C' },
  { name: 'L3: get me ready for the call', message: 'get me ready for the call', expectedLane: '0C' },
  { name: 'L3: meeting prep for tomorrow', message: 'meeting prep for tomorrow', expectedLane: '0C' },
  { name: 'L3: help me prepare for the interview', message: 'help me prepare for the interview', expectedLane: '0C' },
  { name: 'L3: prepare for my Monday meeting', message: 'prepare for my Monday meeting', expectedLane: '0C' },

  // ── Lane 3: Classifier (disqualifier: personal system nouns) ─
  { name: 'L3: check my inbox', message: 'check my inbox', expectedLane: '0C' },
  { name: 'L3: any emails from Ryan', message: 'any emails from Ryan', expectedLane: '0C' },
  { name: 'L3: whats on my calendar', message: "what's on my calendar", expectedLane: '0C' },
  { name: 'L3: search my contacts', message: 'search my contacts', expectedLane: '0C' },
  { name: 'L3: check my gmail', message: 'check my gmail', expectedLane: '0C' },
  { name: 'L3: check outlook', message: 'check outlook', expectedLane: '0C' },
  { name: 'L3: whats in my messages', message: "what's in my messages", expectedLane: '0C' },

  // ── Lane 3: Classifier (disqualifier: workflow verbs) ────────
  { name: 'L3: draft an email', message: 'draft an email', expectedLane: '0C' },
  { name: 'L3: book lunch Friday', message: 'book lunch Friday', expectedLane: '0C' },
  { name: 'L3: remind me tomorrow', message: 'remind me tomorrow', expectedLane: '0C' },
  { name: 'L3: schedule a meeting', message: 'schedule a meeting', expectedLane: '0C' },
  { name: 'L3: send that to Tom', message: 'send that to Tom', expectedLane: '0C' },
  { name: 'L3: cancel the booking', message: 'cancel the booking', expectedLane: '0C' },
  { name: 'L3: forward this to Sarah', message: 'forward this to Sarah', expectedLane: '0C' },
  { name: 'L3: compose a reply', message: 'compose a reply', expectedLane: '0C' },

  // ── Lane 3: Classifier (disqualifier: temporal signals) ──────
  { name: 'L3: whats on tomorrow', message: "what's on tomorrow", expectedLane: '0C' },
  { name: 'L3: weather today', message: 'weather today', expectedLane: '0C' },
  { name: 'L3: latest OpenAI pricing', message: 'latest OpenAI pricing', expectedLane: '0C' },
  { name: 'L3: who won tonight', message: 'who won tonight', expectedLane: '0C' },
  { name: 'L3: free after 3pm', message: 'free after 3pm', expectedLane: '0C' },
  { name: 'L3: this weekend plans', message: 'this weekend plans', expectedLane: '0C' },
  { name: 'L3: whats happening next week', message: "what's happening next week", expectedLane: '0C' },

  // ── Lane 3: Classifier (disqualifier: local/travel) ──────────
  { name: 'L3: best sushi near me', message: 'best sushi near me', expectedLane: '0C' },
  { name: 'L3: how long to get from Kyoto to Osaka', message: 'how long to get from Kyoto to Osaka', expectedLane: '0C' },
  { name: 'L3: directions to the station', message: 'directions to the station', expectedLane: '0C' },
  { name: 'L3: train from Tokyo to Kyoto', message: 'train from Tokyo to Kyoto', expectedLane: '0C' },
  { name: 'L3: nearest pharmacy', message: 'nearest pharmacy', expectedLane: '0C' },
  { name: 'L3: walk to the office', message: 'walk to the office', expectedLane: '0C' },
  { name: 'L3: drive to the airport', message: 'drive to the airport', expectedLane: '0C' },

  // ── Lane 3: Classifier (disqualifier: hidden personal) ───────
  { name: 'L3: any unread', message: 'any unread', expectedLane: '0C' },
  { name: 'L3: did Ryan reply', message: 'did Ryan reply', expectedLane: '0C' },
  { name: 'L3: free after lunch', message: 'free after lunch', expectedLane: '0C' },
  { name: 'L3: whats in my inbox', message: "what's in my inbox", expectedLane: '0C' },

  // ── Lane 3: Classifier (pending state) ───────────────────────
  {
    name: 'L3: yes (awaitingConfirmation)',
    message: 'yes',
    expectedLane: '0C',
    context: { workingMemory: { awaitingConfirmation: true } },
  },
  {
    name: 'L0A: yeah (pending calendar action → Layer 0A)',
    message: 'yeah',
    expectedLane: '0A' as any,
    context: {
      workingMemory: {
        pendingActions: [{ type: 'calendar_create', description: 'Create event', createdTurnId: 'x' }],
      },
    },
  },
  {
    name: 'L3: Google (awaitingChoice)',
    message: 'Google',
    expectedLane: '0C',
    context: { workingMemory: { awaitingChoice: true } },
  },
  {
    name: 'L3: 3pm (awaitingMissingParameter)',
    message: '3pm',
    expectedLane: '0C',
    context: { workingMemory: { awaitingMissingParameter: true } },
  },
  {
    name: 'L3: tell me about Japan (but awaitingConfirmation)',
    message: 'tell me about Japan',
    expectedLane: '0C',
    context: { workingMemory: { awaitingConfirmation: true } },
  },

  // ── Lane 3: Classifier (tools in last turn) ──────────────────
  {
    name: 'L3: yeah pease (after places_search)',
    message: 'Yeah pease',
    expectedLane: '0C',
    context: {
      recentTurns: [
        { role: 'assistant', content: 'Ashburton Cycles is solid. Need their hours? [places_search]' },
      ],
    },
  },
  {
    name: 'L3: nice (after email_read)',
    message: 'nice',
    expectedLane: '0C',
    context: {
      recentTurns: [
        { role: 'assistant', content: 'Here are your latest emails [email_read]' },
      ],
    },
  },
  {
    name: 'L3: ok (after calendar_read)',
    message: 'ok',
    expectedLane: '0C',
    context: {
      recentTurns: [
        { role: 'assistant', content: 'Your schedule for today [calendar_read]' },
      ],
    },
  },
  {
    name: 'L3: tell me about Japan (after travel_time)',
    message: 'tell me about Japan',
    expectedLane: '0C',
    context: {
      recentTurns: [
        { role: 'assistant', content: 'The trip takes about 2 hours [travel_time]' },
      ],
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  3-Lane Deterministic Pre-Router Test Suite              ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const tc of tests) {
  const input = { ...baseInput, userMessage: tc.message };
  const ctx = makeContext(tc.context);

  try {
    const route = await routeTurnV2(input, ctx);
    const actualLane = route.routeLayer ?? 'unknown';

    if (actualLane === tc.expectedLane) {
      passed++;
      console.log(`  ✅ ${tc.name} → ${actualLane} (reason: ${route.routeReason ?? 'n/a'})`);
    } else {
      failed++;
      const detail = `expected ${tc.expectedLane}, got ${actualLane} (reason: ${route.routeReason ?? 'n/a'})`;
      failures.push(`${tc.name}: ${detail}`);
      console.log(`  ❌ ${tc.name} → ${detail}`);
    }
  } catch (err) {
    // If the error is about missing OpenAI credentials, it means the
    // deterministic router returned null and the classifier was called.
    // That's correct for Lane 3 tests.
    const errMsg = (err as Error).message ?? '';
    if (tc.expectedLane === '0C' && (errMsg.includes('apiKey') || errMsg.includes('OPENAI_API_KEY') || errMsg.includes('credentials'))) {
      passed++;
      console.log(`  ✅ ${tc.name} → 0C (classifier called, no API key — correct)`);
    } else {
      failed++;
      const detail = `unexpected error: ${errMsg}`;
      failures.push(`${tc.name}: ${detail}`);
      console.log(`  ❌ ${tc.name} → ${detail}`);
    }
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Results: ${passed}/${tests.length} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
}

const lane1Tests = tests.filter(t => t.expectedLane === '0B-casual').length;
const lane2Tests = tests.filter(t => t.expectedLane === '0B-knowledge').length;
const lane3Tests = tests.filter(t => t.expectedLane === '0C').length;
console.log(`\nLane distribution:`);
console.log(`  Lane 1 (casual):     ${lane1Tests} tests`);
console.log(`  Lane 2 (knowledge):  ${lane2Tests} tests`);
console.log(`  Lane 3 (classifier): ${lane3Tests} tests`);
console.log(`  Total:               ${tests.length} tests`);

if (failed > 0) {
  Deno.exit(1);
}
