/**
 * End-to-end stress test for the 3-lane deterministic pre-router.
 * Tests multi-turn conversations with lane transitions, edge cases,
 * and challenging follow-ups that a real human would send.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-3lane-e2e.ts
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
  description: string;
  expectLane?: string;
  expectAgent?: string;
  expectTools?: string[];
  expectAnyTool?: string[];
  expectNoTools?: boolean;
  expectInResponse?: string[];
  expectNotInResponse?: string[];
}

interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
}

const CONVERSATIONS: Conversation[] = [

  // ── Conv 1: Pure Lane 2 knowledge conversation ──────────────
  {
    id: '3lane-knowledge-flow',
    title: 'Pure knowledge conversation (all Lane 2)',
    turns: [
      {
        message: 'Tell me about the history of coffee',
        description: 'Static knowledge → Lane 2, no tools',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Where did it originate',
        description: 'Follow-up knowledge question → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'How is it different from tea culturally',
        description: 'Comparative knowledge → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Interesting',
        description: 'Short reaction → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 2: Lane transition — knowledge then personal ───────
  {
    id: '3lane-knowledge-to-personal',
    title: 'Knowledge → personal transition',
    turns: [
      {
        message: 'What is OAuth and how does it work',
        description: 'Static knowledge → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Cool explain it like im 5',
        description: 'Follow-up simplification → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Any emails from Google today',
        description: 'Switches to personal → Lane 3 (disqualifier: emails, today)',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['email_read'],
      },
    ],
  },

  // ── Conv 3: Casual → knowledge → travel ─────────────────────
  {
    id: '3lane-casual-knowledge-travel',
    title: 'Casual → knowledge → travel transition',
    turns: [
      {
        message: 'Hey',
        description: 'Greeting → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
      {
        message: 'What are the best things to do in Kyoto',
        description: 'Knowledge question → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'How long to get from Tokyo to Kyoto by train',
        description: 'Travel query → Lane 3 (disqualifier: from X to Y)',
        expectLane: '0C',
        expectAnyTool: ['travel_time'],
      },
    ],
  },

  // ── Conv 4: Tricky false-positive boundary ──────────────────
  {
    id: '3lane-false-positive-boundary',
    title: 'False-positive boundary — must stay Lane 2',
    turns: [
      {
        message: 'How do trains work',
        description: 'General knowledge about trains → Lane 2 (not travel)',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'What about bullet trains specifically',
        description: 'Follow-up about trains → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Tell me about the history of trams in Melbourne',
        description: 'History question → Lane 2 (not travel)',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 5: Calendar + email workflow ────────────────────────
  {
    id: '3lane-calendar-email',
    title: 'Calendar and email workflow (all Lane 3)',
    turns: [
      {
        message: "What's on my calendar tomorrow",
        description: 'Personal + temporal → Lane 3',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['calendar_read'],
      },
      {
        message: 'Any unread emails',
        description: 'Personal inbox → Lane 3',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['email_read'],
      },
    ],
  },

  // ── Conv 6: Ambiguous follow-ups after tool use ─────────────
  {
    id: '3lane-tool-followups',
    title: 'Ambiguous follow-ups after tool use',
    turns: [
      {
        message: 'Best coffee near East Melbourne',
        description: 'Local query → Lane 3 (disqualifier: near)',
        expectLane: '0C',
        expectAnyTool: ['places_search'],
      },
      {
        message: 'Nice',
        description: 'Short reaction AFTER tool use → Lane 3 (tools in last turn)',
        expectLane: '0C',
      },
      {
        message: 'What about their opening hours',
        description: 'Follow-up about previous result → should use tools',
        expectLane: '0C',
      },
    ],
  },

  // ── Conv 7: Creative writing (Lane 2) ───────────────────────
  {
    id: '3lane-creative',
    title: 'Creative writing stays in Lane 2',
    turns: [
      {
        message: 'Write me a haiku about Melbourne weather',
        description: 'Creative → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Now make it funny',
        description: 'Creative follow-up → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Haha thats great',
        description: 'Short reaction → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 8: Tricky "meeting" word ───────────────────────────
  {
    id: '3lane-meeting-word',
    title: 'Meeting as concept vs personal meeting',
    turns: [
      {
        message: 'What is a standup meeting and how do they work',
        description: 'Concept question → Lane 2 (meeting is a system noun but this is educational)',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'How should I run one effectively',
        description: 'Advice question → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 9: Rapid lane switching ────────────────────────────
  {
    id: '3lane-rapid-switch',
    title: 'Rapid switching between lanes',
    turns: [
      {
        message: 'Hey',
        description: 'Lane 1 casual',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
      {
        message: 'Explain photosynthesis',
        description: 'Lane 2 knowledge',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Check my emails',
        description: 'Lane 3 personal',
        expectLane: '0C',
        expectTools: ['email_read'],
      },
      {
        message: 'Thanks',
        description: 'Lane 1 casual (no tools in last turn check — email_read was used)',
        expectLane: '0C',
      },
    ],
  },

  // ── Conv 10: Chicken salt conversation (real user scenario) ──
  {
    id: '3lane-chicken-salt',
    title: 'Chicken salt conversation (real scenario from logs)',
    turns: [
      {
        message: 'Can you get chicken salt in the US particularly in NY, if so where',
        description: 'General knowledge question → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: "What's the best brand in Australia",
        description: 'Follow-up knowledge → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Thanks',
        description: 'Casual → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
      {
        message: "What about nice'n tasty",
        description: 'Follow-up about a brand → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 11: Japan history (real scenario from logs) ─────────
  {
    id: '3lane-japan-history',
    title: 'Japan history conversation (real scenario)',
    turns: [
      {
        message: 'Tell me about Japan history',
        description: 'Knowledge → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
      {
        message: 'Wow',
        description: 'Reaction → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
      {
        message: 'Interesting',
        description: 'Reaction → Lane 1',
        expectLane: '0B-casual',
        expectNoTools: true,
      },
      {
        message: 'Tell me more about the samurai era',
        description: 'Follow-up knowledge → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
    ],
  },

  // ── Conv 12: Ashburton Cycles scenario (the original bug) ───
  {
    id: '3lane-ashburton-cycles',
    title: 'Ashburton Cycles — the original "Yeah pease" bug',
    turns: [
      {
        message: 'Thoughts on Ashburton Cycles',
        description: 'Business query → Lane 3 (places_search)',
        expectLane: '0C',
        expectAnyTool: ['places_search', 'web_search'],
      },
      {
        message: 'Yeah pease',
        description: 'Follow-up after tool use → Lane 3 (tools in last turn)',
        expectLane: '0C',
      },
    ],
  },

  // ── Conv 13: "What's in my inbox" hallucination scenario ────
  {
    id: '3lane-inbox-hallucination',
    title: 'Microsoft inbox query — must not hallucinate',
    turns: [
      {
        message: "What's in my Microsoft inbox",
        description: 'Personal + inbox → Lane 3 (must use email_read)',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['email_read'],
      },
    ],
  },

  // ── Conv 14: Temporal edge cases ────────────────────────────
  {
    id: '3lane-temporal-edges',
    title: 'Temporal edge cases',
    turns: [
      {
        message: 'Who is the current president of France',
        description: 'Has "current" → Lane 3 (temporal disqualifier)',
        expectLane: '0C',
      },
      {
        message: 'What about historically',
        description: 'Follow-up without temporal → depends on context',
        expectLane: '0C',
      },
    ],
  },

  // ── Conv 15: Long knowledge question ────────────────────────
  {
    id: '3lane-long-knowledge',
    title: 'Long knowledge question',
    turns: [
      {
        message: 'Can you explain the difference between machine learning, deep learning, and artificial intelligence in simple terms that a non-technical person would understand',
        description: 'Long knowledge question → Lane 2',
        expectLane: '0B-knowledge',
        expectNoTools: true,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  3-Lane Pre-Router End-to-End Stress Test                ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

for (const conv of CONVERSATIONS) {
  const chatId = `test-3lane-e2e-${conv.id}-${Date.now()}`;
  console.log(`\n━━━ ${conv.title} ━━━`);

  try {
    await clearConversation(chatId);
  } catch { /* new conversation */ }

  for (const turn of conv.turns) {
    const turnStart = Date.now();
    let result;
    try {
      result = await sendMessage(chatId, turn.message);
    } catch (err) {
      failed++;
      const msg = `[${conv.id}] "${turn.message}" — CRASHED: ${(err as Error).message}`;
      failures.push(msg);
      console.log(`  ❌ ${turn.description}`);
      console.log(`     CRASH: ${(err as Error).message}`);
      continue;
    }
    const latency = Date.now() - turnStart;

    const trace = result.trace;
    const actualLane = trace.routeLayer ?? 'unknown';
    const actualAgent = trace.agentName;
    const toolNames = trace.toolCalls.map(t => t.name);
    const responseSnippet = (result.text ?? '').substring(0, 120).replace(/\n/g, ' ');

    let turnPassed = true;
    const turnFailures: string[] = [];

    if (turn.expectLane && actualLane !== turn.expectLane) {
      turnPassed = false;
      turnFailures.push(`lane: expected ${turn.expectLane}, got ${actualLane}`);
    }

    if (turn.expectAgent && actualAgent !== turn.expectAgent) {
      turnPassed = false;
      turnFailures.push(`agent: expected ${turn.expectAgent}, got ${actualAgent}`);
    }

    if (turn.expectTools) {
      for (const tool of turn.expectTools) {
        if (!toolNames.includes(tool)) {
          turnPassed = false;
          turnFailures.push(`missing tool: ${tool}`);
        }
      }
    }

    if (turn.expectAnyTool) {
      const hasAny = turn.expectAnyTool.some(t => toolNames.includes(t));
      if (!hasAny) {
        turnPassed = false;
        turnFailures.push(`expected any of [${turn.expectAnyTool.join(', ')}], got [${toolNames.join(', ')}]`);
      }
    }

    if (turn.expectNoTools && toolNames.length > 0) {
      turnPassed = false;
      turnFailures.push(`expected no tools, got [${toolNames.join(', ')}]`);
    }

    if (turn.expectInResponse) {
      const lower = (result.text ?? '').toLowerCase();
      for (const keyword of turn.expectInResponse) {
        if (!lower.includes(keyword.toLowerCase())) {
          turnPassed = false;
          turnFailures.push(`response missing keyword: "${keyword}"`);
        }
      }
    }

    if (turn.expectNotInResponse) {
      const lower = (result.text ?? '').toLowerCase();
      for (const keyword of turn.expectNotInResponse) {
        if (lower.includes(keyword.toLowerCase())) {
          turnPassed = false;
          turnFailures.push(`response contains forbidden keyword: "${keyword}"`);
        }
      }
    }

    if (turnPassed) {
      passed++;
      console.log(`  ✅ "${turn.message}" → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | ${latency}ms`);
      console.log(`     ${responseSnippet}`);
    } else {
      failed++;
      const detail = `[${conv.id}] "${turn.message}" — ${turnFailures.join('; ')}`;
      failures.push(detail);
      console.log(`  ❌ "${turn.message}" → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | ${latency}ms`);
      console.log(`     FAILURES: ${turnFailures.join('; ')}`);
      console.log(`     Response: ${responseSnippet}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const totalTurns = CONVERSATIONS.reduce((sum, c) => sum + c.turns.length, 0);

console.log(`\n${'═'.repeat(60)}`);
console.log(`Results: ${passed}/${totalTurns} passed, ${failed} failed`);
console.log(`Conversations: ${CONVERSATIONS.length}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
}

if (failed > 0) {
  Deno.exit(1);
}
