/**
 * Extensive multi-turn chat tests for Google Maps tools.
 * Tests realistic human queries with follow-ups, typos, vague phrasing, and edge cases.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-maps-extensive.ts
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

interface Turn {
  message: string;
  expectTools?: string[];
  expectAnyTool?: string[];
  expectInResponse?: string[];
  expectNotInResponse?: string[];
  description: string;
}

interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
}

const CONVERSATIONS: Conversation[] = [

  // ── Conversation 1: Dinner planning with follow-ups ──
  {
    id: 'dinner-planning',
    title: 'Dinner planning with follow-ups',
    turns: [
      {
        message: 'wheres good for dinner tonight in melbourne',
        expectTools: ['places_search'],
        description: 'Vague dinner query → should search places',
      },
      {
        message: 'what about something more casual like a pub',
        expectTools: ['places_search'],
        description: 'Follow-up refining to pubs → should search again',
      },
      {
        message: 'how do i get to the first one from richmond',
        expectTools: ['travel_time'],
        description: 'Follow-up asking directions to a previous result → should use travel_time',
      },
    ],
  },

  // ── Conversation 2: Getting to a meeting ──
  {
    id: 'meeting-commute',
    title: 'Getting to a meeting on time',
    turns: [
      {
        message: 'i have a meeting at 9am in the city tomorrow, im in south yarra. whats the best way to get there',
        expectAnyTool: ['travel_time'],
        description: 'Multi-mode commute question → should check travel options',
      },
      {
        message: 'what about driving, would that be quicker',
        expectTools: ['travel_time'],
        description: 'Follow-up comparing driving → should call travel_time again',
      },
      {
        message: 'is there parking near flinders street station',
        expectAnyTool: ['places_search', 'web_search'],
        description: 'Parking question → should search for parking',
      },
    ],
  },

  // ── Conversation 3: Weekend brunch hunt with typos ──
  {
    id: 'brunch-typos',
    title: 'Brunch with typos and slang',
    turns: [
      {
        message: 'know any good brunch spots in fitzroy',
        expectTools: ['places_search'],
        description: 'Casual brunch query → places_search',
      },
      {
        message: 'do they have good reviews',
        expectAnyTool: ['places_search'],
        description: 'Follow-up about reviews → should get place details',
      },
      {
        message: 'whats the one with the best rating',
        description: 'Follow-up asking to compare → may use context or re-search',
      },
    ],
  },

  // ── Conversation 4: Late night food ──
  {
    id: 'late-night-food',
    title: 'Late night food emergency',
    turns: [
      {
        message: 'im starving is anything open near south melbourne rn',
        expectTools: ['places_search'],
        description: 'Late night "open now" query with slang → places_search',
      },
      {
        message: 'anything closer to st kilda',
        expectTools: ['places_search'],
        description: 'Follow-up shifting location → new search',
      },
    ],
  },

  // ── Conversation 5: Airport rush ──
  {
    id: 'airport-rush',
    title: 'Airport rush — can I make my flight?',
    turns: [
      {
        message: 'my flight is at 7pm and im in collingwood, will i make it if i leave now',
        expectTools: ['travel_time'],
        description: 'Urgent time-sensitive query → travel_time to airport',
      },
      {
        message: 'what if i take an uber to southern cross and then skybus',
        expectAnyTool: ['travel_time'],
        description: 'Multi-leg journey question → should estimate transit',
      },
    ],
  },

  // ── Conversation 6: Tourist questions ──
  {
    id: 'tourist-questions',
    title: 'Tourist exploring Melbourne',
    turns: [
      {
        message: 'whats worth seeing in melbourne if i only have one day',
        expectAnyTool: ['places_search', 'web_search'],
        description: 'Open-ended tourist question → should search for attractions',
      },
      {
        message: 'how far is the great ocean road from the city',
        expectTools: ['travel_time'],
        description: 'Distance question → travel_time',
      },
      {
        message: 'any good fish and chips near st kilda beach',
        expectTools: ['places_search'],
        description: 'Specific food near landmark → places_search',
      },
    ],
  },

  // ── Conversation 7: Cycling route ──
  {
    id: 'cycling-route',
    title: 'Cycling commute planning',
    turns: [
      {
        message: 'how long would it take to cycle from brunswick to the cbd',
        expectTools: ['travel_time'],
        description: 'Cycling time query → travel_time with bicycle mode',
      },
      {
        message: 'and walking?',
        expectTools: ['travel_time'],
        description: 'Follow-up changing mode → travel_time with walking mode',
      },
    ],
  },

  // ── Conversation 8: Business lookup ──
  {
    id: 'business-lookup',
    title: 'Finding a specific business',
    turns: [
      {
        message: 'whats the number for lune croissanterie in fitzroy',
        expectTools: ['places_search'],
        description: 'Phone number lookup → places_search',
      },
      {
        message: 'are they open on sundays',
        expectAnyTool: ['places_search'],
        description: 'Follow-up about hours → should get details',
      },
      {
        message: 'how do i get there from caulfield by train',
        expectTools: ['travel_time'],
        description: 'Transit directions follow-up → travel_time',
      },
    ],
  },

  // ── Conversation 9: Comparing options ──
  {
    id: 'compare-options',
    title: 'Comparing travel options',
    turns: [
      {
        message: 'whats faster to get from footscray to the city, train or driving',
        expectTools: ['travel_time'],
        description: 'Comparison query → should check both modes (may call twice)',
      },
      {
        message: 'what about tram',
        expectAnyTool: ['travel_time'],
        description: 'Follow-up adding another mode → travel_time transit',
      },
    ],
  },

  // ── Conversation 10: Vague "near me" without location ──
  {
    id: 'vague-near-me',
    title: 'Vague query without explicit location',
    turns: [
      {
        message: 'find me a good thai place',
        expectAnyTool: ['places_search', 'web_search'],
        description: 'No location specified → should still attempt search or ask for location',
      },
      {
        message: 'in prahran',
        expectTools: ['places_search'],
        description: 'Follow-up providing location → places_search with location',
      },
    ],
  },

  // ── Conversation 11: Mixed tools — places + calendar ──
  {
    id: 'mixed-places-calendar',
    title: 'Finding a place then booking time',
    turns: [
      {
        message: 'find me a good barber in south yarra',
        expectTools: ['places_search'],
        description: 'Service business search → places_search',
      },
      {
        message: 'whats their phone number and website',
        expectAnyTool: ['places_search'],
        description: 'Follow-up for contact details → place details',
      },
    ],
  },

  // ── Conversation 12: Real edge case — ambiguous destination ──
  {
    id: 'ambiguous-destination',
    title: 'Ambiguous destination name',
    turns: [
      {
        message: 'how long to get to the G from here',
        expectAnyTool: ['travel_time', 'web_search'],
        description: '"The G" = MCG — slang test. May need to interpret or ask.',
      },
    ],
  },
];

for (const convo of CONVERSATIONS) {
  const chatId = `TEST#maps#ext#${convo.id}`;
  await clearConversation(chatId).catch(() => {});

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`CONVERSATION: ${convo.title}`);
  console.log(`${'═'.repeat(70)}`);

  for (let i = 0; i < convo.turns.length; i++) {
    const turn = convo.turns[i];
    console.log(`\n  Turn ${i + 1}: "${turn.message}"`);
    console.log(`  Expect: ${turn.description}`);

    try {
      const result = await sendMessage(chatId, turn.message);

      const agent = result.trace.agentName;
      // deno-lint-ignore no-explicit-any
      const tools = result.trace.toolCalls.map((t: any) => t.name);
      const response = result.text.toLowerCase();
      const turnFailures: string[] = [];

      if (turn.expectTools) {
        for (const tool of turn.expectTools) {
          if (!tools.includes(tool)) {
            turnFailures.push(`missing tool: ${tool} (used: ${tools.join(', ') || 'none'})`);
          }
        }
      }

      if (turn.expectAnyTool) {
        const hasAny = turn.expectAnyTool.some(t => tools.includes(t));
        if (!hasAny) {
          turnFailures.push(`expected one of [${turn.expectAnyTool.join(', ')}] but used: ${tools.join(', ') || 'none'}`);
        }
      }

      if (turn.expectInResponse) {
        for (const kw of turn.expectInResponse) {
          if (!response.includes(kw.toLowerCase())) {
            turnFailures.push(`response missing: "${kw}"`);
          }
        }
      }

      if (turn.expectNotInResponse) {
        for (const kw of turn.expectNotInResponse) {
          if (response.includes(kw.toLowerCase())) {
            turnFailures.push(`response should NOT contain: "${kw}"`);
          }
        }
      }

      const status = turnFailures.length === 0 ? 'PASS' : 'FAIL';
      if (turnFailures.length === 0) passed++; else { failed++; failures.push(`${convo.id} turn ${i+1}`); }

      console.log(`  Agent: ${agent} | Tools: ${tools.join(', ') || '(none)'} | ${result.trace.totalMs}ms`);
      console.log(`  Response: ${result.text.slice(0, 250)}${result.text.length > 250 ? '...' : ''}`);
      console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${status}`);
      if (turnFailures.length > 0) {
        for (const f of turnFailures) console.log(`    ↳ ${f}`);
      }
    } catch (e) {
      failed++;
      failures.push(`${convo.id} turn ${i+1}`);
      console.log(`  ❌ ERROR: ${(e as Error).message}`);
    }
  }
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`FINAL RESULTS: ${passed} passed, ${failed} failed out of ${CONVERSATIONS.reduce((n, c) => n + c.turns.length, 0)} turns`);
if (failures.length > 0) {
  console.log(`\nFailed:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'═'.repeat(70)}\n`);

Deno.exit(failed > 0 ? 1 : 0);
