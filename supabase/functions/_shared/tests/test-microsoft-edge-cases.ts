/**
 * Microsoft edge case tests — contacts, multi-inbox, calendar clarification, account targeting.
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-microsoft-edge-cases.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const TIMEZONE = 'Australia/Sydney';

interface EdgeTest {
  id: string;
  message: string;
  expectAgent: string;
  expectTools: string[];
  expectInResponse?: string[];
  expectNotInResponse?: string[];
  description: string;
}

const EDGE_TESTS: EdgeTest[] = [
  {
    id: 'contacts-who-is',
    message: 'Who is Sarah from Taployalty?',
    expectAgent: 'smart',
    expectTools: ['contacts_read'],
    description: 'Should search Microsoft contacts when user mentions a company linked to MS account',
  },
  {
    id: 'multi-inbox-generic',
    message: 'Show me my latest emails from all accounts',
    expectAgent: 'smart',
    expectTools: ['email_read'],
    description: 'Generic email query should return results from ALL inboxes (Google + Microsoft)',
  },
  {
    id: 'calendar-create-ambiguous',
    message: 'Book a meeting called "Strategy sync" for tomorrow at 2pm',
    expectAgent: 'smart',
    expectTools: [],
    expectInResponse: ['which', 'calendar', 'account'],
    description: 'Calendar create with multiple accounts should ask which calendar/account to use',
  },
  {
    id: 'ms-specific-taployalty',
    message: 'Check my Taployalty emails',
    expectAgent: 'smart',
    expectTools: ['email_read'],
    expectInResponse: ['taployalty', 'instagram'],
    description: 'Should target only the Microsoft account when user says "Taployalty"',
  },
  {
    id: 'ms-draft-from',
    message: 'Draft an email from my Microsoft account to test@example.com saying hello',
    expectAgent: 'smart',
    expectTools: ['email_draft'],
    description: 'Should create draft using Outlook when user specifies Microsoft account',
  },
  {
    id: 'ms-inbox-whats-new',
    message: "What's new in my Outlook inbox?",
    expectAgent: 'smart',
    expectTools: ['email_read'],
    description: 'Should recognise "Outlook" as Microsoft and search that account',
  },
  {
    id: 'contacts-find-email',
    message: "Find Tom's email address in my contacts",
    expectAgent: 'smart',
    expectTools: ['contacts_read'],
    description: 'Should search contacts across ALL providers including Microsoft',
  },
  {
    id: 'calendar-read-all',
    message: "What's on my calendar this week across all accounts?",
    expectAgent: 'smart',
    expectTools: ['calendar_read'],
    description: 'Should read calendar from both Google and Microsoft accounts',
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

for (const test of EDGE_TESTS) {
  const chatId = `TEST#msft#edge#${test.id}`;
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
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const response = result.text.toLowerCase();
    const failures: string[] = [];

    if (test.expectAgent && agent !== test.expectAgent) {
      failures.push(`agent: expected ${test.expectAgent}, got ${agent}`);
    }

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
    console.log(`RESPONSE: ${result.text.slice(0, 300)}${result.text.length > 300 ? '...' : ''}`);
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
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${EDGE_TESTS.length} tests`);
console.log(`${'═'.repeat(70)}`);

Deno.exit(failed > 0 ? 1 : 0);
