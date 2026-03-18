/**
 * E2E test for safety net write-tool exemption.
 *
 * Validates that casual follow-ups after READ-ONLY tools (web_search,
 * email_read, calendar_read, etc.) route to "chat" — NOT bumped to
 * "smart" by the safety net. Write tools (email_draft, calendar_write,
 * etc.) should still trigger the safety net upgrade.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-safety-net-e2e.ts
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
  /** If true, we just log the result without assertions (info turn) */
  infoOnly?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
}

const CONVERSATIONS: Conversation[] = [

  // ═══════════════════════════════════════════════════════════════
  // GROUP A: Read-only tools → casual follow-up should be CHAT
  // ═══════════════════════════════════════════════════════════════

  // A1: web_search → "Interesting" (the original bug)
  {
    id: 'safety-net-websearch-interesting',
    title: 'web_search → "Interesting" should stay chat (original bug case)',
    turns: [
      {
        message: 'Search the web for the latest Tesla stock news',
        description: 'web_search query → Lane 3, smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectAnyTool: ['web_search'],
      },
      {
        message: 'Interesting',
        description: 'Casual follow-up after web_search → should be CHAT (not bumped to smart)',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // A2: email_read → "nice"
  {
    id: 'safety-net-emailread-nice',
    title: 'email_read → "nice" should stay chat',
    turns: [
      {
        message: 'Check my latest emails',
        description: 'Email read → Lane 3, smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['email_read'],
      },
      {
        message: 'nice',
        description: 'Casual after email_read → should be CHAT',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // A3: calendar_read → "ok thanks"
  {
    id: 'safety-net-calread-thanks',
    title: 'calendar_read → "ok thanks" should stay chat',
    turns: [
      {
        message: "What's on my calendar today",
        description: 'Calendar read → Lane 3, smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['calendar_read'],
      },
      {
        message: 'ok thanks',
        description: 'Casual after calendar_read → should be CHAT',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // A4: web_search → longer casual "That's really cool"
  {
    id: 'safety-net-websearch-cool',
    title: 'web_search → "Thats really cool" should stay chat',
    turns: [
      {
        message: 'Search the web for best restaurants in Tokyo',
        description: 'web_search → smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectAnyTool: ['web_search'],
      },
      {
        message: "That's really cool",
        description: 'Casual reaction after web_search → should be CHAT',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // A5: semantic_search → "got it"
  {
    id: 'safety-net-semantic-gotit',
    title: 'semantic_search → "got it" should stay chat',
    turns: [
      {
        message: 'What do you know about my travel preferences',
        description: 'Memory/semantic search → Lane 3, smart',
        expectLane: '0C',
        expectAgent: 'smart',
      },
      {
        message: 'got it',
        description: 'Casual after semantic_search → should be CHAT',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // GROUP B: Write tools → casual follow-up should STAY SMART
  // (safety net fires correctly)
  // ═══════════════════════════════════════════════════════════════

  // B1: email draft workflow → "looks good"
  {
    id: 'safety-net-draft-looksgood',
    title: 'email_draft → "looks good" should stay smart (safety net fires)',
    turns: [
      {
        message: 'Draft an email to tom@lidgett.net saying hey just testing the routing system',
        description: 'Email draft → smart, email_draft tool',
        expectLane: '0C',
        expectAgent: 'smart',
      },
      {
        message: 'looks good',
        description: 'After email_draft → should stay SMART (write tool, safety net fires)',
        expectAgent: 'smart',
      },
    ],
  },

  // B2: calendar_write → "perfect"
  {
    id: 'safety-net-calwrite-perfect',
    title: 'calendar_write → "perfect" should stay smart',
    turns: [
      {
        message: 'Schedule a test meeting for next Friday at 3pm called Router Test',
        description: 'Calendar create → smart, calendar_write tool',
        expectLane: '0C',
        expectAgent: 'smart',
      },
      {
        message: 'perfect',
        description: 'After calendar_write → should stay SMART (write tool, safety net fires)',
        expectAgent: 'smart',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // GROUP C: Read → Write transition within conversation
  // ═══════════════════════════════════════════════════════════════

  // C1: email_read → draft → casual (should stay smart because last tool was write)
  {
    id: 'safety-net-read-then-draft',
    title: 'email_read → draft → "yes" stays smart',
    turns: [
      {
        message: 'Check my emails from today',
        description: 'Email read → smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectTools: ['email_read'],
      },
      {
        message: 'ok thanks',
        description: 'Casual after email_read → should be CHAT (read-only)',
        expectAgent: 'chat',
        expectNoTools: true,
      },
      {
        message: 'Actually, draft a reply to tom@lidgett.net saying thanks for the update',
        description: 'Now requesting a draft → smart',
        expectAgent: 'smart',
      },
      {
        message: 'yes',
        description: 'After email_draft → should stay SMART (write tool context)',
        expectAgent: 'smart',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // GROUP D: Edge cases — new topic after tool use
  // ═══════════════════════════════════════════════════════════════

  // D1: web_search → completely new knowledge question
  {
    id: 'safety-net-websearch-newtopic',
    title: 'web_search → new knowledge question should be chat',
    turns: [
      {
        message: 'Search the web for latest AI news',
        description: 'web_search → smart',
        expectLane: '0C',
        expectAgent: 'smart',
        expectAnyTool: ['web_search'],
      },
      {
        message: 'Tell me about the history of coffee',
        description: 'New knowledge topic → should be CHAT (long msg, no lookback)',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },

  // D2: email_draft → completely new knowledge question (long msg bypasses lookback)
  {
    id: 'safety-net-draft-newtopic',
    title: 'email_draft → new long knowledge question should be chat (long msg)',
    turns: [
      {
        message: 'Draft an email to tom@lidgett.net about the weather today',
        description: 'Email draft → smart',
        expectAgent: 'smart',
      },
      {
        message: 'Explain the difference between machine learning and deep learning in simple terms',
        description: 'Long new topic → should be CHAT (long message bypasses tool lookback)',
        expectAgent: 'chat',
        expectNoTools: true,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  Safety Net Write-Tool Exemption — E2E Tests                     ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

for (const conv of CONVERSATIONS) {
  const chatId = `test-safety-net-${conv.id}-${Date.now()}`;
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
    const toolNames = trace.toolCalls.map((t: { name: string }) => t.name);
    const routeReason = trace.routeReason ?? 'n/a';
    const responseSnippet = (result.text ?? '').substring(0, 120).replace(/\n/g, ' ');

    if (turn.infoOnly) {
      console.log(`  ℹ️  "${turn.message}" → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | reason=${routeReason} | ${latency}ms`);
      console.log(`     ${responseSnippet}`);
      continue;
    }

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
      const hasAny = turn.expectAnyTool.some((t: string) => toolNames.includes(t));
      if (!hasAny) {
        turnPassed = false;
        turnFailures.push(`expected any of [${turn.expectAnyTool.join(', ')}], got [${toolNames.join(', ')}]`);
      }
    }

    if (turn.expectNoTools && toolNames.length > 0) {
      turnPassed = false;
      turnFailures.push(`expected no tools, got [${toolNames.join(', ')}]`);
    }

    if (turnPassed) {
      passed++;
      console.log(`  ✅ "${turn.message}" → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | reason=${routeReason} | ${latency}ms`);
      console.log(`     ${responseSnippet}`);
    } else {
      failed++;
      const detail = `[${conv.id}] "${turn.message}" — ${turnFailures.join('; ')}`;
      failures.push(detail);
      console.log(`  ❌ "${turn.message}" → ${actualLane} | ${actualAgent} | tools=[${toolNames.join(',')}] | reason=${routeReason} | ${latency}ms`);
      console.log(`     FAILURES: ${turnFailures.join('; ')}`);
      console.log(`     Response: ${responseSnippet}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const totalTurns = CONVERSATIONS.reduce((sum, c) => sum + c.turns.length, 0);

console.log(`\n${'═'.repeat(66)}`);
console.log(`Results: ${passed}/${totalTurns} passed, ${failed} failed`);
console.log(`Conversations: ${CONVERSATIONS.length}`);

if (failures.length > 0) {
  console.log('\n🔴 Failures:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
} else {
  console.log('\n🟢 All tests passed!');
}
