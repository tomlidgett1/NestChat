/**
 * Extensive E2E tests — Email, Calendar, Contacts, Multi-turn.
 * Medium and hard complexity. Uses tom@lidgett.net exclusively.
 *
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/e2e-extensive-march.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import {
  ensureNestUser,
  clearConversation,
  cancelPendingEmailSends,
  getLatestPendingEmailSend,
  addMessage,
} from '../state.ts';
import type { TurnInput, TurnResult } from '../orchestrator/types.ts';

const SENDER_HANDLE = '+61414187820';
const BOT_NUMBER = '+13466215973';
const TIMEZONE = 'Australia/Melbourne';

let authUserId: string | null = null;

function makeTurnInput(message: string, chatId: string): TurnInput {
  return {
    chatId,
    userMessage: message,
    images: [],
    audio: [],
    senderHandle: SENDER_HANDLE,
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId,
    isOnboarding: false,
    timezone: TIMEZONE,
  };
}

let totalPassed = 0;
let totalFailed = 0;
const allFailures: { test: string; failures: string[] }[] = [];

function header(title: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(80)}`);
}

function subheader(title: string) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(70)}`);
}

function logResult(
  testId: string,
  result: TurnResult,
  failures: string[],
  extra?: Record<string, string>,
) {
  const tools = result.trace.toolCalls.map((t: any) => t.name);
  const pass = failures.length === 0;
  if (pass) totalPassed++; else totalFailed++;
  if (!pass) allFailures.push({ test: testId, failures });

  console.log(`  TEST:     ${testId}`);
  console.log(`  AGENT:    ${result.trace.agentName}`);
  console.log(`  ROUTE:    ${result.trace.routeDecision.agent} (${result.trace.routeDecision.mode})`);
  console.log(`  TOOLS:    ${tools.join(', ') || '(none)'}`);
  console.log(`  LATENCY:  ${result.trace.totalLatencyMs}ms (loop: ${result.trace.agentLoopLatencyMs}ms)`);
  console.log(`  TOKENS:   ${result.trace.inputTokens}in / ${result.trace.outputTokens}out`);
  console.log(`  ROUNDS:   ${result.trace.agentLoopRounds}`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      console.log(`  ${k.padEnd(9)} ${v}`);
    }
  }
  const preview = (result.text ?? '').slice(0, 500);
  console.log(`  RESPONSE: ${preview}${(result.text?.length ?? 0) > 500 ? '...' : ''}`);
  console.log(`  STATUS:   ${pass ? '✅ PASS' : '❌ FAIL'}`);
  if (!pass) {
    for (const f of failures) console.log(`    ↳ ${f}`);
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════

header('SETUP');

const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
authUserId = nestUser.authUserId ?? null;
console.log(`  authUserId: ${authUserId}`);
console.log(`  status:     ${nestUser.status}`);

if (!authUserId) {
  console.log('\n  FATAL: No authUserId — cannot run authenticated tests.');
  console.log('  Ensure tom@lidgett.net has a linked Google account.\n');
  Deno.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: CONTACT SEARCH DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════

header('SECTION 1: CONTACT SEARCH DIAGNOSTICS');

console.log('  Testing Google token refresh and People API access directly...\n');

try {
  const { getGoogleAccessToken, getAllGoogleTokens } = await import('../token-broker.ts');

  const tokens = await getAllGoogleTokens(authUserId);
  console.log(`  Google accounts found: ${tokens.length}`);
  for (const t of tokens) {
    console.log(`    → ${t.email} (token length: ${t.accessToken.length})`);
  }

  if (tokens.length === 0) {
    console.log('  ⚠️  No Google tokens available — contact search will fail.');
  } else {
    for (const token of tokens) {
      console.log(`\n  Testing People API for ${token.email}...`);

      // Test 1: Check granted scopes
      const scopeResp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token.accessToken)}`,
      );
      if (scopeResp.ok) {
        const scopeData = await scopeResp.json();
        const scopes = (scopeData.scope ?? '').split(' ');
        const hasContacts = scopes.some((s: string) => s.includes('contacts'));
        const hasOtherContacts = scopes.some((s: string) => s.includes('contacts.other'));
        console.log(`    Granted scopes: ${scopes.length} total`);
        console.log(`    contacts.readonly: ${hasContacts ? '✅' : '❌ MISSING'}`);
        console.log(`    contacts.other.readonly: ${hasOtherContacts ? '✅' : '❌ MISSING (expected — not in BASE_SCOPES)'}`);

        const contactScopes = scopes.filter((s: string) => s.includes('contact') || s.includes('people'));
        if (contactScopes.length > 0) {
          console.log(`    Contact-related scopes: ${contactScopes.join(', ')}`);
        }

        const allScopesList = scopes.join('\n      ');
        console.log(`    All scopes:\n      ${allScopesList}`);
      } else {
        console.log(`    ⚠️  Could not fetch token info: ${scopeResp.status}`);
      }

      // Test 2: Direct People API search
      const searchResp = await fetch(
        `https://people.googleapis.com/v1/people:searchContacts?query=tom&readMask=names,emailAddresses,phoneNumbers&pageSize=5`,
        { headers: { Authorization: `Bearer ${token.accessToken}` } },
      );
      console.log(`    people:searchContacts status: ${searchResp.status}`);
      if (searchResp.ok) {
        const data = await searchResp.json();
        const results = data.results ?? [];
        console.log(`    Search results for "tom": ${results.length} contacts found`);
        for (const r of results.slice(0, 3)) {
          const name = r.person?.names?.[0]?.displayName ?? '(no name)';
          const email = r.person?.emailAddresses?.[0]?.value ?? '(no email)';
          console.log(`      → ${name} <${email}>`);
        }
      } else {
        const errBody = await searchResp.text();
        console.log(`    ❌ People API search failed: ${errBody.slice(0, 300)}`);
      }

      // Test 3: otherContacts search
      const otherResp = await fetch(
        `https://people.googleapis.com/v1/otherContacts:search?query=tom&readMask=names,emailAddresses,phoneNumbers&pageSize=5`,
        { headers: { Authorization: `Bearer ${token.accessToken}` } },
      );
      console.log(`    otherContacts:search status: ${otherResp.status}`);
      if (otherResp.ok) {
        const data = await otherResp.json();
        const results = data.results ?? [];
        console.log(`    Other contacts for "tom": ${results.length} found`);
      } else {
        const errBody = await otherResp.text();
        console.log(`    otherContacts failed (expected if scope missing): ${errBody.slice(0, 200)}`);
      }

      // Test 4: List connections (alternative approach)
      const connResp = await fetch(
        `https://people.googleapis.com/v1/people/me/connections?pageSize=10&personFields=names,emailAddresses&sortOrder=LAST_MODIFIED_DESCENDING`,
        { headers: { Authorization: `Bearer ${token.accessToken}` } },
      );
      console.log(`    people/me/connections status: ${connResp.status}`);
      if (connResp.ok) {
        const data = await connResp.json();
        const connections = data.connections ?? [];
        console.log(`    Total connections: ${data.totalPeople ?? connections.length}`);
        for (const c of connections.slice(0, 3)) {
          const name = c.names?.[0]?.displayName ?? '(no name)';
          const email = c.emailAddresses?.[0]?.value ?? '(no email)';
          console.log(`      → ${name} <${email}>`);
        }
      } else {
        const errBody = await connResp.text();
        console.log(`    ❌ connections list failed: ${errBody.slice(0, 300)}`);
      }
    }
  }
} catch (err) {
  console.log(`  ❌ Token/API diagnostic failed: ${(err as Error).message}`);
}

// ═══════════════════════════════════════════════════════════════
// SECTION 2: CONTACT SEARCH VIA TOOL (through handleTurn)
// ═══════════════════════════════════════════════════════════════

header('SECTION 2: CONTACT SEARCH VIA ORCHESTRATOR');

const contactTests = [
  {
    id: 'contact-search-by-name',
    message: "What's Tom Lidgett's email address?",
    difficulty: 'medium',
    expectTools: ['contacts_read'],
    expectInResponse: ['tom', 'lidgett'],
  },
  {
    id: 'contact-search-generic',
    message: 'Look up Tom in my contacts',
    difficulty: 'medium',
    expectTools: ['contacts_read'],
  },
  {
    id: 'contact-search-for-email',
    message: "I need to email Sarah — can you find her contact details?",
    difficulty: 'medium',
    expectTools: ['contacts_read'],
  },
  {
    id: 'contact-search-phone',
    message: "What's the phone number for Tom Lidgett?",
    difficulty: 'medium',
    expectTools: ['contacts_read'],
  },
];

for (const tc of contactTests) {
  const chatId = `TEST#contacts#${tc.id}`;
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}]`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    for (const tool of tc.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (tc.expectInResponse) {
      for (const kw of tc.expectInResponse) {
        if (!(result.text ?? '').toLowerCase().includes(kw.toLowerCase())) {
          failures.push(`Response missing keyword: "${kw}"`);
        }
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 3: EMAIL — MEDIUM DIFFICULTY
// ═══════════════════════════════════════════════════════════════

header('SECTION 3: EMAIL — MEDIUM DIFFICULTY');

const emailMediumTests = [
  {
    id: 'email-search-recent',
    message: 'Show me my most recent emails',
    difficulty: 'medium',
    expectTools: ['email_read'],
  },
  {
    id: 'email-search-from-person',
    message: 'Do I have any emails from Tom Lidgett?',
    difficulty: 'medium',
    expectTools: ['email_read'],
  },
  {
    id: 'email-search-subject',
    message: 'Find emails about "meeting notes" in my inbox',
    difficulty: 'medium',
    expectTools: ['email_read'],
  },
  {
    id: 'email-draft-simple',
    message: 'Draft an email to tom@lidgett.net saying "Hey Tom, just checking in. How are things going?"',
    difficulty: 'medium',
    expectTools: ['email_draft'],
  },
  {
    id: 'email-search-unread',
    message: 'How many unread emails do I have?',
    difficulty: 'medium',
    expectTools: ['email_read'],
  },
];

for (const tc of emailMediumTests) {
  const chatId = `TEST#email-med#${tc.id}`;
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}]`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    for (const tool of tc.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 4: EMAIL — HARD DIFFICULTY
// ═══════════════════════════════════════════════════════════════

header('SECTION 4: EMAIL — HARD DIFFICULTY');

const emailHardTests = [
  {
    id: 'email-draft-professional',
    message: 'Write a professional email to tom@lidgett.net about rescheduling our Friday meeting to Monday at 10am. Apologise for the short notice and suggest we use the time to review Q1 results.',
    difficulty: 'hard',
    expectTools: ['email_draft'],
    expectInResponse: ['monday', '10'],
  },
  {
    id: 'email-search-and-summarise',
    message: 'Search my emails for anything from the last week and give me a summary of the important ones',
    difficulty: 'hard',
    expectTools: ['email_read'],
  },
  {
    id: 'email-draft-with-context',
    message: 'Draft a follow-up email to tom@lidgett.net referencing our last conversation about the project timeline. Ask for an update on the deliverables.',
    difficulty: 'hard',
    expectTools: ['email_draft'],
  },
];

for (const tc of emailHardTests) {
  const chatId = `TEST#email-hard#${tc.id}`;
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}]`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    for (const tool of tc.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (tc.expectInResponse) {
      for (const kw of tc.expectInResponse) {
        if (!(result.text ?? '').toLowerCase().includes(kw.toLowerCase())) {
          failures.push(`Response missing keyword: "${kw}"`);
        }
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 5: CALENDAR — MEDIUM DIFFICULTY
// ═══════════════════════════════════════════════════════════════

header('SECTION 5: CALENDAR — MEDIUM DIFFICULTY');

const calendarMediumTests = [
  {
    id: 'cal-today',
    message: "What's on my calendar today?",
    difficulty: 'medium',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-tomorrow',
    message: "What do I have on tomorrow?",
    difficulty: 'medium',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-this-week',
    message: "Show me my schedule for this week",
    difficulty: 'medium',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-free-slots',
    message: "When am I free this afternoon?",
    difficulty: 'medium',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-next-meeting',
    message: "What's my next meeting?",
    difficulty: 'medium',
    expectTools: ['calendar_read'],
  },
];

for (const tc of calendarMediumTests) {
  const chatId = `TEST#cal-med#${tc.id}`;
  await clearConversation(chatId).catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}]`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    for (const tool of tc.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 6: CALENDAR — HARD DIFFICULTY
// ═══════════════════════════════════════════════════════════════

header('SECTION 6: CALENDAR — HARD DIFFICULTY');

const calendarHardTests = [
  {
    id: 'cal-create-event',
    message: 'Schedule a 30-minute meeting called "Test Sync" for tomorrow at 2pm',
    difficulty: 'hard',
    expectTools: ['calendar_write'],
  },
  {
    id: 'cal-search-specific',
    message: 'Do I have any meetings with "standup" in the title this week?',
    difficulty: 'hard',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-busy-check',
    message: "Am I free on Friday between 1pm and 4pm?",
    difficulty: 'hard',
    expectTools: ['calendar_read'],
  },
  {
    id: 'cal-next-week-overview',
    message: "Give me a rundown of next week — what's the busiest day?",
    difficulty: 'hard',
    expectTools: ['calendar_read'],
  },
];

for (const tc of calendarHardTests) {
  const chatId = `TEST#cal-hard#${tc.id}`;
  await clearConversation(chatId).catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}]`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    for (const tool of tc.expectTools) {
      if (!tools.includes(tool)) {
        failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 7: MULTI-TURN — CALENDAR + CONTACTS
// ═══════════════════════════════════════════════════════════════

header('SECTION 7: MULTI-TURN — CALENDAR + CONTACTS + EMAIL');

{
  subheader('multi-turn-1: Schedule meeting with contact lookup [hard]');
  const chatId = 'TEST#multi#cal-contact-1';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  // Turn 1: Ask to schedule a meeting with someone
  console.log('  TURN 1: "Schedule a meeting with Tom Lidgett for Thursday at 11am"\n');
  const turn1 = await handleTurn(makeTurnInput(
    'Schedule a meeting with Tom Lidgett for Thursday at 11am',
    chatId,
  ));
  const tools1 = turn1.trace.toolCalls.map((t: any) => t.name);
  const failures1: string[] = [];

  // Should either use contacts_read to look up Tom, or calendar_write directly
  const usedContactOrCalendar = tools1.includes('contacts_read') || tools1.includes('calendar_write');
  if (!usedContactOrCalendar) {
    failures1.push(`Expected contacts_read or calendar_write (used: ${tools1.join(', ') || 'none'})`);
  }
  if (!turn1.text || turn1.text.trim().length === 0) {
    failures1.push('Empty response');
  }

  logResult('multi-turn-1/turn-1', turn1, failures1);

  // Turn 2: Follow up
  console.log('  TURN 2: "Actually make it 30 minutes and add a Google Meet link"\n');
  const turn2 = await handleTurn(makeTurnInput(
    'Actually make it 30 minutes and add a Google Meet link',
    chatId,
  ));
  const tools2 = turn2.trace.toolCalls.map((t: any) => t.name);
  const failures2: string[] = [];

  if (!turn2.text || turn2.text.trim().length === 0) {
    failures2.push('Empty response');
  }

  logResult('multi-turn-1/turn-2', turn2, failures2, {
    'CONTEXT:': 'Follow-up to meeting scheduling request',
  });
}

{
  subheader('multi-turn-2: Email search → draft reply [hard]');
  const chatId = 'TEST#multi#email-reply-1';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  // Turn 1: Search for emails
  console.log('  TURN 1: "Check my recent emails"\n');
  const turn1 = await handleTurn(makeTurnInput('Check my recent emails', chatId));
  const tools1 = turn1.trace.toolCalls.map((t: any) => t.name);
  const failures1: string[] = [];

  if (!tools1.includes('email_read')) {
    failures1.push(`Expected email_read (used: ${tools1.join(', ') || 'none'})`);
  }
  if (!turn1.text || turn1.text.trim().length === 0) {
    failures1.push('Empty response');
  }

  logResult('multi-turn-2/turn-1', turn1, failures1);

  // Turn 2: Draft a reply
  console.log('  TURN 2: "Draft a reply to tom@lidgett.net saying thanks for the update, I\'ll review it today"\n');
  const turn2 = await handleTurn(makeTurnInput(
    "Draft a reply to tom@lidgett.net saying thanks for the update, I'll review it today",
    chatId,
  ));
  const tools2 = turn2.trace.toolCalls.map((t: any) => t.name);
  const failures2: string[] = [];

  if (!tools2.includes('email_draft')) {
    failures2.push(`Expected email_draft (used: ${tools2.join(', ') || 'none'})`);
  }
  if (!turn2.text || turn2.text.trim().length === 0) {
    failures2.push('Empty response');
  }

  logResult('multi-turn-2/turn-2', turn2, failures2);

  // Turn 3: Modify the draft
  console.log('  TURN 3: "Actually, also mention that I\'ll need the budget figures by Friday"\n');
  const turn3 = await handleTurn(makeTurnInput(
    "Actually, also mention that I'll need the budget figures by Friday",
    chatId,
  ));
  const failures3: string[] = [];

  if (!turn3.text || turn3.text.trim().length === 0) {
    failures3.push('Empty response');
  }

  logResult('multi-turn-2/turn-3', turn3, failures3, {
    'CONTEXT:': 'Modifying previously drafted email',
  });
}

{
  subheader('multi-turn-3: Calendar check → email about availability [very hard]');
  const chatId = 'TEST#multi#cal-email-1';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  // Turn 1: Check calendar
  console.log('  TURN 1: "What does my Thursday look like?"\n');
  const turn1 = await handleTurn(makeTurnInput("What does my Thursday look like?", chatId));
  const tools1 = turn1.trace.toolCalls.map((t: any) => t.name);
  const failures1: string[] = [];

  if (!tools1.includes('calendar_read')) {
    failures1.push(`Expected calendar_read (used: ${tools1.join(', ') || 'none'})`);
  }

  logResult('multi-turn-3/turn-1', turn1, failures1);

  // Turn 2: Now email about availability
  console.log('  TURN 2: "Email tom@lidgett.net and let him know when I\'m free on Thursday for a catch-up"\n');
  const turn2 = await handleTurn(makeTurnInput(
    "Email tom@lidgett.net and let him know when I'm free on Thursday for a catch-up",
    chatId,
  ));
  const tools2 = turn2.trace.toolCalls.map((t: any) => t.name);
  const failures2: string[] = [];

  const usedEmailDraft = tools2.includes('email_draft');
  if (!usedEmailDraft) {
    failures2.push(`Expected email_draft (used: ${tools2.join(', ') || 'none'})`);
  }

  logResult('multi-turn-3/turn-2', turn2, failures2, {
    'CONTEXT:': 'Should use calendar context from turn 1 to compose email',
  });
}

{
  subheader('multi-turn-4: Contact lookup → email → send confirmation [very hard]');
  const chatId = 'TEST#multi#contact-email-send-1';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  // Turn 1: Look up contact
  console.log('  TURN 1: "Find Tom Lidgett in my contacts"\n');
  const turn1 = await handleTurn(makeTurnInput("Find Tom Lidgett in my contacts", chatId));
  const tools1 = turn1.trace.toolCalls.map((t: any) => t.name);
  const failures1: string[] = [];

  if (!tools1.includes('contacts_read')) {
    failures1.push(`Expected contacts_read (used: ${tools1.join(', ') || 'none'})`);
  }

  logResult('multi-turn-4/turn-1', turn1, failures1);

  // Turn 2: Draft email to that contact
  console.log('  TURN 2: "Send him an email saying the project kickoff is confirmed for next Monday at 9am"\n');
  const turn2 = await handleTurn(makeTurnInput(
    'Send him an email saying the project kickoff is confirmed for next Monday at 9am',
    chatId,
  ));
  const tools2 = turn2.trace.toolCalls.map((t: any) => t.name);
  const failures2: string[] = [];

  const usedDraft = tools2.includes('email_draft') || tools2.includes('email_send');
  if (!usedDraft) {
    failures2.push(`Expected email_draft or email_send (used: ${tools2.join(', ') || 'none'})`);
  }

  logResult('multi-turn-4/turn-2', turn2, failures2, {
    'CONTEXT:': 'Should resolve "him" to Tom Lidgett from turn 1',
  });

  // Check if there's a pending email send
  const pending = await getLatestPendingEmailSend(chatId);
  if (pending) {
    console.log(`  📧 Pending email send detected: draft_id=${pending.draftId}, to=${JSON.stringify(pending.to)}`);

    // Turn 3: Confirm send
    console.log('\n  TURN 3: "Yes, send it"\n');
    const turn3 = await handleTurn(makeTurnInput('Yes, send it', chatId));
    const tools3 = turn3.trace.toolCalls.map((t: any) => t.name);
    const failures3: string[] = [];

    logResult('multi-turn-4/turn-3', turn3, failures3, {
      'CONTEXT:': 'Confirming pending email send',
    });
  } else {
    console.log('  ℹ️  No pending email send detected — skipping confirmation turn\n');
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 8: COMPLEX MULTI-DOMAIN SCENARIOS
// ═══════════════════════════════════════════════════════════════

header('SECTION 8: COMPLEX MULTI-DOMAIN SCENARIOS');

{
  subheader('complex-1: Morning briefing [very hard]');
  const chatId = 'TEST#complex#morning-brief';
  await clearConversation(chatId).catch(() => {});

  console.log('  MSG: "Give me a morning briefing — what\'s on my calendar today and any important emails I should know about?"\n');
  const result = await handleTurn(makeTurnInput(
    "Give me a morning briefing — what's on my calendar today and any important emails I should know about?",
    chatId,
  ));
  const tools = result.trace.toolCalls.map((t: any) => t.name);
  const failures: string[] = [];

  const usedCalendar = tools.includes('calendar_read');
  const usedEmail = tools.includes('email_read');

  if (!usedCalendar) {
    failures.push(`Expected calendar_read (used: ${tools.join(', ') || 'none'})`);
  }
  if (!usedEmail) {
    failures.push(`Expected email_read (used: ${tools.join(', ') || 'none'})`);
  }
  if (!result.text || result.text.length < 50) {
    failures.push('Response too short for a briefing');
  }

  logResult('complex-1', result, failures, {
    'MULTI:': `calendar=${usedCalendar}, email=${usedEmail}`,
  });
}

{
  subheader('complex-2: Draft email referencing calendar [very hard]');
  const chatId = 'TEST#complex#email-cal-ref';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  console.log('  MSG: "Check my calendar for tomorrow and then email tom@lidgett.net with a summary of what meetings we have together"\n');
  const result = await handleTurn(makeTurnInput(
    "Check my calendar for tomorrow and then email tom@lidgett.net with a summary of what meetings we have together",
    chatId,
  ));
  const tools = result.trace.toolCalls.map((t: any) => t.name);
  const failures: string[] = [];

  if (!tools.includes('calendar_read')) {
    failures.push(`Expected calendar_read (used: ${tools.join(', ') || 'none'})`);
  }
  if (!tools.includes('email_draft')) {
    failures.push(`Expected email_draft (used: ${tools.join(', ') || 'none'})`);
  }

  logResult('complex-2', result, failures, {
    'MULTI:': 'Should chain calendar_read → email_draft',
  });
}

{
  subheader('complex-3: Reschedule + notify [very hard]');
  const chatId = 'TEST#complex#reschedule-notify';
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  console.log('  MSG: "I need to move my 2pm meeting tomorrow to 4pm and email tom@lidgett.net to let him know about the change"\n');
  const result = await handleTurn(makeTurnInput(
    "I need to move my 2pm meeting tomorrow to 4pm and email tom@lidgett.net to let him know about the change",
    chatId,
  ));
  const tools = result.trace.toolCalls.map((t: any) => t.name);
  const failures: string[] = [];

  const hasCalendarAction = tools.includes('calendar_read') || tools.includes('calendar_write');
  if (!hasCalendarAction) {
    failures.push(`Expected calendar_read or calendar_write (used: ${tools.join(', ') || 'none'})`);
  }

  logResult('complex-3', result, failures, {
    'MULTI:': 'Should attempt calendar modification + email notification',
  });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 9: EDGE CASES
// ═══════════════════════════════════════════════════════════════

header('SECTION 9: EDGE CASES');

const edgeCases = [
  {
    id: 'edge-vague-email',
    message: 'Email tom@lidgett.net',
    difficulty: 'medium',
    description: 'Vague email request — should ask for subject/body or make reasonable assumptions',
  },
  {
    id: 'edge-ambiguous-time',
    message: 'Schedule something for next week',
    difficulty: 'medium',
    description: 'Ambiguous time — should ask for clarification',
  },
  {
    id: 'edge-calendar-conflict',
    message: "Book a meeting for tomorrow at 9am — but first check if I'm free",
    difficulty: 'hard',
    description: 'Should check calendar before creating event',
    expectTools: ['calendar_read'],
  },
  {
    id: 'edge-rapid-fire',
    message: "What's on my calendar today, do I have any unread emails, and what's the weather like?",
    difficulty: 'hard',
    description: 'Multiple requests in one message',
  },
];

for (const tc of edgeCases) {
  const chatId = `TEST#edge#${tc.id}`;
  await clearConversation(chatId).catch(() => {});
  await cancelPendingEmailSends(chatId, 'test_reset').catch(() => {});

  subheader(`${tc.id} [${tc.difficulty}] — ${tc.description}`);
  console.log(`  MSG: "${tc.message}"\n`);

  try {
    const result = await handleTurn(makeTurnInput(tc.message, chatId));
    const tools = result.trace.toolCalls.map((t: any) => t.name);
    const failures: string[] = [];

    if (tc.expectTools) {
      for (const tool of tc.expectTools) {
        if (!tools.includes(tool)) {
          failures.push(`Expected tool ${tool} not used (used: ${tools.join(', ') || 'none'})`);
        }
      }
    }

    if (!result.text || result.text.trim().length === 0) {
      failures.push('Empty response');
    }

    logResult(tc.id, result, failures);
  } catch (err) {
    totalFailed++;
    allFailures.push({ test: tc.id, failures: [`THREW: ${(err as Error).message}`] });
    console.log(`  ❌ ERROR: ${(err as Error).message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═══════════════════════════════════════════════════════════════

header('FINAL SUMMARY');

const total = totalPassed + totalFailed;
console.log(`  Total:  ${total} tests`);
console.log(`  Passed: ${totalPassed} ✅`);
console.log(`  Failed: ${totalFailed} ❌`);
console.log(`  Rate:   ${total > 0 ? ((totalPassed / total) * 100).toFixed(1) : 0}%`);

if (allFailures.length > 0) {
  console.log(`\n  FAILURES:`);
  for (const f of allFailures) {
    console.log(`    ${f.test}:`);
    for (const detail of f.failures) {
      console.log(`      ↳ ${detail}`);
    }
  }
}

console.log(`\n${'═'.repeat(80)}\n`);

Deno.exit(totalFailed > 0 ? 1 : 0);
