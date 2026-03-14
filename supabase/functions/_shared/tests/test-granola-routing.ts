/**
 * Granola routing + fallback tests.
 *
 * Part 1: List all Granola meetings (live API call)
 * Part 2: Routing regex tests (offline, no API calls)
 * Part 3: Live integration tests via handleTurn (Granola query + fallback)
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-granola-routing.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser } from '../state.ts';
import { listGranolaMeetings, queryGranolaMeetings } from '../granola-helpers.ts';
import type { TurnInput, TurnResult } from '../orchestrator/types.ts';

const SENDER_HANDLE = '+61414187820';
const BOT_NUMBER = '+13466215973';
const CHAT_ID = `DM#${BOT_NUMBER}#${SENDER_HANDLE}`;
const TIMEZONE = 'Australia/Melbourne';

let authUserId: string | null = null;

function makeTurnInput(message: string): TurnInput {
  return {
    chatId: `TEST#granola#${Date.now()}`,
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

// ═══════════════════════════════════════════════════════════════
// Part 1: List Granola meetings
// ═══════════════════════════════════════════════════════════════

async function listMeetings() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Part 1: Granola Meetings (Live API)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!authUserId) {
    console.log('  ✗ No authUserId — skipping Granola API calls');
    return;
  }

  try {
    const recent = await listGranolaMeetings(authUserId, { limit: 15 });
    console.log('  Recent meetings (last 15):');
    console.log(recent);
  } catch (err) {
    console.log(`  ✗ listGranolaMeetings failed: ${(err as Error).message}`);
  }

  console.log('\n  ---\n');

  try {
    const today = new Date().toISOString().split('T')[0];
    const todayMeetings = await listGranolaMeetings(authUserId, { after: `${today}T00:00:00Z` });
    console.log(`  Today's meetings (after ${today}T00:00:00Z):`);
    console.log(todayMeetings);
  } catch (err) {
    console.log(`  ✗ listGranolaMeetings (today) failed: ${(err as Error).message}`);
  }

  console.log('\n  ---\n');

  try {
    const queryResult = await queryGranolaMeetings(authUserId, 'What did Daniel and I chat about in our 1:1 today?');
    console.log('  Query "What did Daniel and I chat about in our 1:1 today?":');
    console.log(queryResult);
  } catch (err) {
    console.log(`  ✗ queryGranolaMeetings failed: ${(err as Error).message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Part 2: Routing regex tests (offline)
// ═══════════════════════════════════════════════════════════════

function testRouting() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Part 2: Routing Regex Tests (Offline)                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const granolaRegex1 = /\b(granola|meeting\s*notes?|meeting\s*transcript|what (was|were|did \w+( and i)?|did we) (discuss(ed)?|chat(ted)? about|talk(ed)? about|spo?ke about|go(ne)? over|cover(ed)?|say|said|decide[d]?|agree[d]?( on)?)|action\s*items?\s*(from|after|came out of)|decisions?\s*(from|in|were made in)\s*(the|my|our|last|recent)|notes?\s*(from|about)\s*((the|my|our|last|recent)\s*)+(meeting|call|sync|standup))\b/i;
  const granolaRegex2a = /\b(chat(ted)?|talk(ed)?|discuss(ed)?|spoke|went over|cover(ed)?)\b/i;
  const granolaRegex2b = /\b(in|about|during|from)\b/i;
  const granolaRegex2c = /\b(1[:\-]1|one.on.one|meeting|call|sync|standup|catch ?up|review)\b/i;
  const granolaRegex3a = /\b(main\s*points?|key\s*(points?|takeaways?)|highlights?|summary|recap)\b/i;
  const granolaRegex3b = /\b(meeting|call|sync|standup|catch ?up|review|1[:\-]1|one.on.one)\b/i;

  const matchesGranola = (msg: string) =>
    granolaRegex1.test(msg) ||
    (granolaRegex2a.test(msg) && granolaRegex2b.test(msg) && granolaRegex2c.test(msg)) ||
    (granolaRegex3a.test(msg) && granolaRegex3b.test(msg));

  const cases: [boolean, string][] = [
    // Should route to meeting_prep
    [true, 'Hey Nest! What did Daniel and I chat about in our 1:1 today'],
    [true, 'What did we talk about in the meeting today'],
    [true, 'What did Ralph talk about in our last call'],
    [true, 'What was discussed in the standup'],
    [true, 'What did Daniel and I go over in our 1:1'],
    [true, 'What did we cover in the review'],
    [true, 'What was said in the meeting'],
    [true, 'What did Sarah say in the call'],
    [true, 'We chatted about something in our 1:1'],
    [true, 'We talked about budgets in the sync'],
    [true, 'We discussed the roadmap in our meeting'],
    [true, 'notes from the last meeting'],
    [true, 'notes from our last standup'],
    [true, 'What did we discuss in the catchup'],
    [true, 'What did we discuss in the catch up'],
    [true, 'meeting notes from today'],
    [true, 'What were Ralph\'s main points in that last call'],
    [true, 'granola meeting anything'],
    [true, 'Give me a granola meeting anything'],
    [true, 'What action items came out of the meeting'],
    [true, 'What decisions were made in our last sync'],
    [true, 'What did we agree on in the review'],
    [true, 'What did Tom and I discuss in our 1:1'],
    [true, 'What did we chat about during the standup'],
    [true, 'What did we go over in the call'],
    [true, 'What did we spoke about in the meeting'],

    // Should NOT route to meeting_prep (false positives)
    [false, 'Tell me about Japan history'],
    [false, 'Who is Elon Musk'],
    [false, 'I want to chat about my plans'],
    [false, 'Lets talk about the weather'],
    [false, 'Whats the weather'],
    [false, 'Hey whats up'],
    [false, 'Compare Tesla Model 3 vs BMW i4'],
    [false, 'Check my latest emails'],
    [false, 'Whats on my calendar today'],
    [false, 'Hey'],
    [false, 'Thanks'],
    [false, 'Who is better, Clarry or Petracca'],
  ];

  let pass = 0;
  let fail = 0;

  for (const [shouldMatch, msg] of cases) {
    const matched = matchesGranola(msg);
    const ok = matched === shouldMatch;
    if (ok) {
      pass++;
      console.log(`  ✓ ${matched ? 'MATCH' : 'NO   '} | ${msg}`);
    } else {
      fail++;
      console.log(`  ✗ ${matched ? 'MATCH' : 'NO   '} | ${msg} (expected ${shouldMatch ? 'MATCH' : 'NO'})`);
    }
  }

  console.log(`\n  Routing regex: ${pass} passed, ${fail} failed out of ${cases.length}`);
  return fail === 0;
}

// ═══════════════════════════════════════════════════════════════
// Part 3: Live integration tests
// ═══════════════════════════════════════════════════════════════

interface LiveTestCase {
  id: string;
  message: string;
  expectRoute: string;
  expectTool: string;
  expectTextMin: number;
}

async function runLiveTests() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Part 3: Live Integration Tests (Granola)                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const liveTests: LiveTestCase[] = [
    {
      id: 'granola-1:1-chat-about',
      message: 'What did Daniel and I chat about in our 1:1 today',
      expectRoute: '',
      expectTool: 'granola_read',
      expectTextMin: 20,
    },
    {
      id: 'granola-discussed-standup',
      message: 'What was discussed in the standup today',
      expectRoute: '',
      expectTool: 'granola_read',
      expectTextMin: 20,
    },
    {
      id: 'granola-meeting-notes',
      message: 'Give me the meeting notes from today',
      expectRoute: '',
      expectTool: 'granola_read',
      expectTextMin: 20,
    },
  ];

  let pass = 0;
  let fail = 0;

  for (const tc of liveTests) {
    console.log(`\n  [${tc.id}] "${tc.message}"`);
    const start = Date.now();

    try {
      const result: TurnResult = await handleTurn(makeTurnInput(tc.message));
      const latency = Date.now() - start;
      const trace = result.trace;
      const toolNames = trace.toolCalls.map((t: { name: string }) => t.name);
      const failures: string[] = [];

      if (tc.expectRoute && trace.agentName !== tc.expectRoute) {
        failures.push(`route: expected ${tc.expectRoute}, got ${trace.agentName}`);
      }
      if (!toolNames.includes(tc.expectTool)) {
        failures.push(`tool: expected ${tc.expectTool}, used [${toolNames.join(', ')}]`);
      }
      if (!result.text || result.text.length < tc.expectTextMin) {
        failures.push(`text too short: ${result.text?.length ?? 0} < ${tc.expectTextMin}`);
      }

      if (failures.length === 0) {
        pass++;
        console.log(`  ✓ PASS | route=${trace.agentName} | tools=[${toolNames.join(', ')}] | ${latency}ms | rounds=${trace.agentLoopRounds}`);
        console.log(`    "${(result.text ?? '').substring(0, 200)}"`);
      } else {
        fail++;
        console.log(`  ✗ FAIL | route=${trace.agentName} | tools=[${toolNames.join(', ')}] | ${latency}ms`);
        for (const f of failures) console.log(`    ✗ ${f}`);
        console.log(`    "${(result.text ?? '').substring(0, 200)}"`);
      }

      // Show tool call details
      for (const tc2 of trace.toolCalls) {
        console.log(`    tool: ${tc2.name} (${tc2.outcome}) ${tc2.latencyMs}ms — ${tc2.inputSummary ?? ''}`);
      }
    } catch (err) {
      fail++;
      console.log(`  ✗ THREW: ${(err as Error).message}`);
    }
  }

  console.log(`\n  Live tests: ${pass} passed, ${fail} failed out of ${liveTests.length}`);
  return fail === 0;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Granola Routing + Fallback Tests                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Resolve authUserId
  console.log('\nResolving authUserId...');
  try {
    const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
    authUserId = nestUser.authUserId ?? null;
    console.log(`  authUserId: ${authUserId}`);
  } catch (err) {
    console.error('Failed to resolve nest user:', (err as Error).message);
    Deno.exit(1);
  }

  // Part 1: List meetings
  await listMeetings();

  // Part 2: Routing regex
  const routingOk = testRouting();

  // Part 3: Live integration
  const liveOk = await runLiveTests();

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Routing regex: ${routingOk ? '✓ ALL PASS' : '✗ FAILURES'}`);
  console.log(`  Live tests:    ${liveOk ? '✓ ALL PASS' : '✗ FAILURES'}`);

  Deno.exit(routingOk && liveOk ? 0 : 1);
}

main();
