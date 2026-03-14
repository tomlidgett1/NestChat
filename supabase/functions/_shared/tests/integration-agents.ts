/**
 * Integration tests for all agents via handleTurn().
 * Calls the real orchestrator with live Supabase + OpenAI.
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/integration-agents.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation, cancelPendingEmailSends, getLatestPendingEmailSend } from '../state.ts';
import { OPTION_A_ROUTING } from '../env.ts';
import type { TurnInput, TurnResult } from '../orchestrator/types.ts';

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const SENDER_HANDLE = '+61414187820';
const BOT_NUMBER = '+13466215973';
const CHAT_ID = `DM#${BOT_NUMBER}#${SENDER_HANDLE}`;
const TIMEZONE = 'Australia/Melbourne';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  id: string;
  agent: string;
  difficulty: string;
  message: string;
  expect: {
    routeAgent?: string;
    hasText: boolean;
    minTextLength?: number;
    toolsUsed?: string[];
    toolsNotUsed?: string[];
    textContains?: string[];
    textNotContains?: string[];
    hasReaction?: boolean;
    hasRememberedUser?: boolean;
  };
}

interface TestResult {
  id: string;
  agent: string;
  difficulty: string;
  message: string;
  pass: boolean;
  failures: string[];
  routedTo: string;
  responsePreview: string;
  toolsUsed: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  rounds: number;
}

let authUserId: string | null = null;

function makeTurnInput(message: string, chatId = CHAT_ID): TurnInput {
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

async function runTest(tc: TestCase): Promise<TestResult> {
  const start = Date.now();
  const failures: string[] = [];

  // State reset between single-turn tests
  try {
    await clearConversation(CHAT_ID);
    await cancelPendingEmailSends(CHAT_ID, 'test_reset');
  } catch { /* best effort */ }

  let result: TurnResult;
  try {
    result = await handleTurn(makeTurnInput(tc.message));
  } catch (err) {
    return {
      id: tc.id,
      agent: tc.agent,
      difficulty: tc.difficulty,
      message: tc.message,
      pass: false,
      failures: [`THREW: ${(err as Error).message}`],
      routedTo: 'ERROR',
      responsePreview: '',
      toolsUsed: [],
      latencyMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      rounds: 0,
    };
  }

  const latencyMs = Date.now() - start;
  const trace = result.trace;
  const toolNames = trace.toolCalls.map(t => t.name);

  // Check route — when OPTION_A_ROUTING is on, map legacy agent names to chat/smart
  if (tc.expect.routeAgent) {
    if (OPTION_A_ROUTING) {
      const legacyToOptionA: Record<string, string[]> = {
        casual: ['chat'],
        productivity: ['smart'],
        research: ['smart'],
        recall: ['smart'],
        operator: ['smart'],
        meeting_prep: ['smart'],
        onboard: ['onboard'],
        chat: ['chat'],
        smart: ['smart'],
      };
      const acceptableAgents = legacyToOptionA[tc.expect.routeAgent] ?? [tc.expect.routeAgent];
      if (!acceptableAgents.includes(trace.agentName)) {
        failures.push(`route: expected ${acceptableAgents.join('|')} (mapped from ${tc.expect.routeAgent}), got ${trace.agentName}`);
      }
    } else if (trace.agentName !== tc.expect.routeAgent) {
      failures.push(`route: expected ${tc.expect.routeAgent}, got ${trace.agentName}`);
    }
  }

  // Check text
  if (tc.expect.hasText && !result.text) {
    failures.push('expected text response, got null');
  }
  if (!tc.expect.hasText && result.text) {
    failures.push(`expected no text, got: ${result.text.substring(0, 100)}`);
  }

  if (result.text && tc.expect.minTextLength && result.text.length < tc.expect.minTextLength) {
    failures.push(`text too short: ${result.text.length} < ${tc.expect.minTextLength}`);
  }

  // Check tools used
  if (tc.expect.toolsUsed) {
    for (const t of tc.expect.toolsUsed) {
      if (!toolNames.includes(t)) {
        failures.push(`expected tool ${t} not used (used: ${toolNames.join(', ')})`);
      }
    }
  }
  if (tc.expect.toolsNotUsed) {
    for (const t of tc.expect.toolsNotUsed) {
      if (toolNames.includes(t)) {
        failures.push(`tool ${t} should NOT have been used`);
      }
    }
  }

  // Check text content
  if (result.text && tc.expect.textContains) {
    const lower = result.text.toLowerCase();
    for (const s of tc.expect.textContains) {
      if (!lower.includes(s.toLowerCase())) {
        failures.push(`text missing "${s}"`);
      }
    }
  }
  if (result.text && tc.expect.textNotContains) {
    const lower = result.text.toLowerCase();
    for (const s of tc.expect.textNotContains) {
      if (lower.includes(s.toLowerCase())) {
        failures.push(`text should NOT contain "${s}"`);
      }
    }
  }

  // Check side effects
  if (tc.expect.hasReaction && !result.reaction) {
    failures.push('expected reaction, got null');
  }
  if (tc.expect.hasRememberedUser && !result.rememberedUser) {
    failures.push('expected rememberedUser, got null');
  }

  return {
    id: tc.id,
    agent: tc.agent,
    difficulty: tc.difficulty,
    message: tc.message,
    pass: failures.length === 0,
    failures,
    routedTo: trace.agentName,
    responsePreview: result.text?.substring(0, 200) ?? '(null)',
    toolsUsed: toolNames,
    latencyMs,
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    rounds: trace.agentLoopRounds,
  };
}

interface WorkflowTestResult {
  id: string;
  pass: boolean;
  failures: string[];
  latencyMs: number;
}

async function runTurn(chatId: string, message: string): Promise<TurnResult> {
  return handleTurn(makeTurnInput(message, chatId));
}

async function resetWorkflowChat(chatId: string): Promise<void> {
  await clearConversation(chatId);
  await cancelPendingEmailSends(chatId, 'workflow_test_reset');
}

async function runWorkflowTest(
  id: string,
  fn: (chatId: string, failures: string[]) => Promise<void>,
): Promise<WorkflowTestResult> {
  const chatId = `TEST#workflow#${id}`;
  const failures: string[] = [];
  const start = Date.now();

  try {
    await resetWorkflowChat(chatId);
    await fn(chatId, failures);
  } catch (err) {
    failures.push(`THREW: ${(err as Error).message}`);
  }

  return {
    id,
    pass: failures.length === 0,
    failures,
    latencyMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════
// Test cases — every agent, Easy / Medium / Complex / Ambiguous + edge cases
// ═══════════════════════════════════════════════════════════════

const tests: TestCase[] = [
  // ─── CASUAL ────────────────────────────────────────────────
  {
    id: 'casual-easy',
    agent: 'casual',
    difficulty: 'Easy',
    message: 'Hey, how are you?',
    expect: { routeAgent: 'casual', hasText: true, minTextLength: 5 },
  },
  {
    id: 'casual-medium',
    agent: 'casual',
    difficulty: 'Medium',
    message: "I'm feeling a bit stressed about work lately, any advice?",
    expect: { routeAgent: 'casual', hasText: true, minTextLength: 20 },
  },
  {
    id: 'casual-complex',
    agent: 'casual',
    difficulty: 'Complex',
    message: "What's the weather like in Melbourne today? Also what's happening with the stock market?",
    expect: { hasText: true, minTextLength: 30, toolsUsed: ['web_search'] },
  },
  {
    id: 'casual-ambiguous',
    agent: 'casual',
    difficulty: 'Ambiguous',
    message: 'Nice',
    expect: { hasText: true },
  },
  {
    id: 'casual-edge-empty-ish',
    agent: 'casual',
    difficulty: 'Edge',
    message: '?',
    expect: { hasText: true },
  },

  // ─── RESEARCH ──────────────────────────────────────────────
  {
    id: 'research-easy',
    agent: 'research',
    difficulty: 'Easy',
    message: 'Who is the current president of France?',
    expect: { routeAgent: 'research', hasText: true, toolsUsed: ['web_search'] },
  },
  {
    id: 'research-medium',
    agent: 'research',
    difficulty: 'Medium',
    message: 'Compare the Toyota HiLux vs the Mazda BT-50 for towing capacity and fuel economy',
    expect: { routeAgent: 'research', hasText: true, minTextLength: 50, toolsUsed: ['web_search'] },
  },
  {
    id: 'research-complex',
    agent: 'research',
    difficulty: 'Complex',
    message: 'Give me a detailed breakdown of the Iran-US conflict timeline since February 2026, including key strikes, casualties, and diplomatic responses',
    expect: { hasText: true, minTextLength: 100, toolsUsed: ['web_search'] },
  },
  {
    id: 'research-ambiguous',
    agent: 'research',
    difficulty: 'Ambiguous',
    message: 'Tell me about that thing with Dubai',
    expect: { hasText: true, toolsUsed: ['web_search'] },
  },

  // ─── RESEARCH + RAG ────────────────────────────────────────
  {
    id: 'rag-azupay',
    agent: 'research',
    difficulty: 'RAG',
    message: 'What did I discuss with Azupay?',
    expect: { hasText: true },
  },
  {
    id: 'rag-tap-loyalty',
    agent: 'research',
    difficulty: 'RAG',
    message: 'What are the things to do with Tap Loyalty?',
    expect: { hasText: true },
  },

  // ─── RECALL ────────────────────────────────────────────────
  {
    id: 'recall-easy',
    agent: 'recall',
    difficulty: 'Easy',
    message: 'What do you know about me?',
    expect: { routeAgent: 'recall', hasText: true, minTextLength: 20 },
  },
  {
    id: 'recall-medium',
    agent: 'recall',
    difficulty: 'Medium',
    message: 'What are my food preferences?',
    expect: { routeAgent: 'recall', hasText: true },
  },
  {
    id: 'recall-complex',
    agent: 'recall',
    difficulty: 'Complex',
    message: 'What do you remember about my travel plans and interests?',
    expect: { routeAgent: 'recall', hasText: true },
  },
  {
    id: 'recall-ambiguous',
    agent: 'recall',
    difficulty: 'Ambiguous',
    message: 'Do you remember that thing I told you about?',
    expect: { hasText: true },
  },

  // ─── PRODUCTIVITY (email) ──────────────────────────────────
  {
    id: 'prod-email-easy',
    agent: 'productivity',
    difficulty: 'Easy',
    message: 'Check my latest emails',
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['email_read'] },
  },
  {
    id: 'prod-email-medium',
    agent: 'productivity',
    difficulty: 'Medium',
    message: 'Draft an email to tom@lidgett.net with subject "Test from Nest" saying "This is an integration test email, please disregard."',
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['email_draft'] },
  },
  {
    id: 'prod-email-complex',
    agent: 'productivity',
    difficulty: 'Complex',
    message: 'Search my emails for anything from Blacklane in the last week and summarise the key points',
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['email_read'], minTextLength: 30 },
  },

  // ─── PRODUCTIVITY (calendar) ───────────────────────────────
  {
    id: 'prod-cal-easy',
    agent: 'productivity',
    difficulty: 'Easy',
    message: "What's on my calendar today?",
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['calendar_read'] },
  },
  {
    id: 'prod-cal-medium',
    agent: 'productivity',
    difficulty: 'Medium',
    message: "What meetings do I have this week?",
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['calendar_read'] },
  },
  {
    id: 'prod-cal-complex',
    agent: 'productivity',
    difficulty: 'Complex',
    message: "What's my schedule looking like for the rest of the week? Any gaps where I could fit a 30 min call?",
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 30 },
  },

  // ─── PRODUCTIVITY (multi-tool: calendar + email) ───────────
  {
    id: 'prod-multi-easy',
    agent: 'productivity',
    difficulty: 'Multi-tool',
    message: "What's on my calendar today and do I have any unread emails?",
    expect: { routeAgent: 'productivity', hasText: true, toolsUsed: ['calendar_read', 'email_read'] },
  },
  {
    id: 'prod-multi-complex',
    agent: 'productivity',
    difficulty: 'Multi-tool',
    message: "Check my calendar for today, then check my emails for anything related to my next meeting",
    expect: { hasText: true, toolsUsed: ['calendar_read'], minTextLength: 20 },
  },

  // ─── MEETING PREP ──────────────────────────────────────────
  {
    id: 'meetprep-easy',
    agent: 'meeting_prep',
    difficulty: 'Easy',
    message: 'Prep me for my next meeting',
    expect: { routeAgent: 'meeting_prep', hasText: true, minTextLength: 20 },
  },
  {
    id: 'meetprep-medium',
    agent: 'meeting_prep',
    difficulty: 'Medium',
    message: "What should I know before my meeting with Daniel today?",
    expect: { routeAgent: 'meeting_prep', hasText: true, minTextLength: 30 },
  },
  {
    id: 'meetprep-complex',
    agent: 'meeting_prep',
    difficulty: 'Complex',
    message: "Prep me for all my meetings today. For each one, tell me who's attending, what context I need, and what I should bring up",
    expect: { routeAgent: 'meeting_prep', hasText: true, minTextLength: 50 },
  },

  // ─── OPERATOR (complex multi-step) ─────────────────────────
  {
    id: 'operator-complex',
    agent: 'operator',
    difficulty: 'Complex',
    message: "Check my calendar for tomorrow, find any emails related to those meetings, and draft a prep summary email to tom@lidgett.net",
    expect: { hasText: true, minTextLength: 30 },
  },

  // ─── EDGE CASES ────────────────────────────────────────────
  {
    id: 'edge-very-long',
    agent: 'edge',
    difficulty: 'Edge',
    message: 'I need you to help me with something. So basically what happened is that I was at work today and my boss Daniel came up to me and said that we need to restructure the entire Singapore incentive program because the current metrics are not aligned with our Q2 targets and he wants me to prepare a presentation by Friday that covers the historical performance data, the proposed changes, and a cost-benefit analysis. Can you help me think through this?',
    expect: { hasText: true, minTextLength: 30 },
  },
  {
    id: 'edge-typos',
    agent: 'edge',
    difficulty: 'Edge',
    message: 'waht tiem is my nxt meeitng',
    expect: { hasText: true },
  },
  {
    id: 'edge-mixed-intent',
    agent: 'edge',
    difficulty: 'Edge',
    message: "What's the weather in Dubai and also check my calendar for tomorrow",
    expect: { hasText: true },
  },
  {
    id: 'edge-memory-save',
    agent: 'edge',
    difficulty: 'Edge',
    message: "By the way, I'm thinking of getting a Tesla Model 3",
    expect: { hasText: true },
  },
  {
    id: 'edge-contacts',
    agent: 'edge',
    difficulty: 'Edge',
    message: "Who is Daniel Barth?",
    expect: { hasText: true, toolsUsed: ['contacts_read'] },
  },

  // ─── OPTION A: PREVIOUSLY BROKEN SCENARIOS ─────────────────
  {
    id: 'optiona-email-check',
    agent: 'edge',
    difficulty: 'OptionA',
    message: 'Check my latest emails',
    expect: { hasText: true, toolsUsed: ['email_read'] },
  },
  {
    id: 'optiona-weather-search',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "What's the weather in Melbourne?",
    expect: { hasText: true, toolsUsed: ['web_search'] },
  },
  {
    id: 'optiona-compound-email-calendar',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "Check my calendar for today and then draft a summary email to tom@lidgett.net",
    expect: { hasText: true, toolsUsed: ['calendar_read'] },
  },
  {
    id: 'optiona-meeting-recall',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "What did we discuss in our meeting last week?",
    expect: { hasText: true },
  },
  {
    id: 'optiona-general-knowledge',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "Tell me about the history of Japan",
    expect: { hasText: true, minTextLength: 50 },
  },
  {
    id: 'optiona-bored',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "Im bored lol",
    expect: { hasText: true },
  },
  {
    id: 'optiona-schedule-gaps',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "When am I free tomorrow afternoon?",
    expect: { hasText: true, toolsUsed: ['calendar_read'] },
  },
  {
    id: 'optiona-contact-email',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "What's Tom's email address?",
    expect: { hasText: true, toolsUsed: ['contacts_read'] },
  },
  {
    id: 'optiona-web-current-events',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "What's the latest news about AI regulation?",
    expect: { hasText: true, toolsUsed: ['web_search'] },
  },
  {
    id: 'optiona-casual-followup',
    agent: 'edge',
    difficulty: 'OptionA',
    message: "haha yeah true",
    expect: { hasText: true },
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Nest V3 Agent Integration Tests                           ║');
  console.log('║  Live Supabase + OpenAI Responses API                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Resolve authUserId
  console.log('Resolving authUserId...');
  try {
    const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
    authUserId = nestUser.authUserId ?? null;
    console.log(`  authUserId: ${authUserId}`);
    console.log(`  status: ${nestUser.status}\n`);
  } catch (err) {
    console.error('Failed to resolve nest user:', (err as Error).message);
    Deno.exit(1);
  }

  const results: TestResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  // Group tests by agent
  const grouped = new Map<string, TestCase[]>();
  for (const tc of tests) {
    const group = grouped.get(tc.agent) ?? [];
    group.push(tc);
    grouped.set(tc.agent, group);
  }

  for (const [agentGroup, agentTests] of grouped) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  AGENT: ${agentGroup.toUpperCase()}`);
    console.log(`${'═'.repeat(60)}`);

    for (const tc of agentTests) {
      console.log(`\n  [${tc.id}] ${tc.difficulty} — "${tc.message.substring(0, 80)}${tc.message.length > 80 ? '...' : ''}"`);

      const r = await runTest(tc);
      results.push(r);

      if (r.pass) {
        totalPass++;
        console.log(`  ✓ PASS | routed=${r.routedTo} | tools=[${r.toolsUsed.join(', ')}] | ${r.latencyMs}ms | ${r.inputTokens}in/${r.outputTokens}out | rounds=${r.rounds}`);
        console.log(`    "${r.responsePreview}"`);
      } else {
        totalFail++;
        console.log(`  ✗ FAIL | routed=${r.routedTo} | tools=[${r.toolsUsed.join(', ')}] | ${r.latencyMs}ms`);
        for (const f of r.failures) {
          console.log(`    ✗ ${f}`);
        }
        console.log(`    "${r.responsePreview}"`);
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  MULTI-TURN CONFIRM-SEND WORKFLOWS');
  console.log(`${'═'.repeat(60)}`);

  const workflowResults: WorkflowTestResult[] = [];

  workflowResults.push(await runWorkflowTest('draft-send-it', async (chatId, failures) => {
    const turn1 = await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "Nest workflow test A" saying "This is a workflow test email, please disregard."');
    if (!turn1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('turn1 did not use email_draft');
    if (turn1.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn1 should not send in same turn');
    const pending1 = await getLatestPendingEmailSend(chatId);
    if (!pending1) failures.push('turn1 did not create pending draft');

    const turn2 = await runTurn(chatId, 'Send it');
    if (!turn2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn2 did not use email_send');
    if (turn2.trace.toolCallsBlocked.length > 0) failures.push(`turn2 blocked tools: ${turn2.trace.toolCallsBlocked.map(t => t.name).join(', ')}`);
    const pending2 = await getLatestPendingEmailSend(chatId);
    if (pending2) failures.push('pending draft still exists after send');
  }));

  workflowResults.push(await runWorkflowTest('draft-yep-send', async (chatId, failures) => {
    const turn1 = await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "Nest workflow test B" saying "This is a second workflow test email, please disregard."');
    if (!turn1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('turn1 did not use email_draft');

    const turn2 = await runTurn(chatId, 'Yep');
    const expectedConfirmAgent = OPTION_A_ROUTING ? 'smart' : 'productivity';
    if (turn2.trace.agentName !== expectedConfirmAgent) failures.push(`turn2 routed to ${turn2.trace.agentName}, expected ${expectedConfirmAgent}`);
    if (!turn2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn2 did not use email_send');
    const pending2 = await getLatestPendingEmailSend(chatId);
    if (pending2) failures.push('pending draft still exists after Yep send');
  }));

  workflowResults.push(await runWorkflowTest('draft-revise-send', async (chatId, failures) => {
    const turn1 = await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "Nest workflow test C" saying "Please disregard this workflow test email."');
    if (!turn1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('turn1 did not use email_draft');

    const turn2 = await runTurn(chatId, 'Change the subject to "Nest workflow test C revised" and keep the rest the same');
    if (!turn2.trace.toolCalls.some(t => t.name === 'email_draft' || t.name === 'email_update_draft')) failures.push('turn2 did not create a revised draft');

    const turn3 = await runTurn(chatId, 'Looks good, send it');
    if (!turn3.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn3 did not use email_send');
    const pending3 = await getLatestPendingEmailSend(chatId);
    if (pending3) failures.push('pending draft still exists after revised send');
  }));

  workflowResults.push(await runWorkflowTest('draft-and-send-same-turn', async (chatId, failures) => {
    const turn1 = await runTurn(chatId, 'Draft and send an email to tom@lidgett.net with subject "Nest workflow test D" saying "Please disregard this draft-and-send test email."');
    if (!turn1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('turn1 did not use email_draft');
    if (turn1.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn1 should not use email_send');
    const pending1 = await getLatestPendingEmailSend(chatId);
    if (!pending1) failures.push('turn1 should leave a pending draft awaiting confirmation');
  }));

  workflowResults.push(await runWorkflowTest('meeting-prep-send', async (chatId, failures) => {
    const turn1 = await runTurn(chatId, 'Prep me for my next meeting and draft that brief to tom@lidgett.net');
    const expectedPrepAgent = OPTION_A_ROUTING ? 'smart' : 'meeting_prep';
    if (turn1.trace.agentName !== expectedPrepAgent) failures.push(`turn1 routed to ${turn1.trace.agentName}, expected ${expectedPrepAgent}`);
    if (!turn1.text) failures.push('turn1 produced no text');
    const usedDraftTool = turn1.trace.toolCalls.some(t => t.name === 'email_draft');
    const pending1 = await getLatestPendingEmailSend(chatId);

    if (usedDraftTool && pending1) {
      const turn2 = await runTurn(chatId, 'Yes');
      if (!turn2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('turn2 did not use email_send');
    }
  }));

  for (const r of workflowResults) {
    if (r.pass) {
      totalPass++;
      console.log(`  ✓ PASS [${r.id}] | ${r.latencyMs}ms`);
    } else {
      totalFail++;
      console.log(`  ✗ FAIL [${r.id}] | ${r.latencyMs}ms`);
      for (const f of r.failures) {
        console.log(`    ✗ ${f}`);
      }
    }
  }

  // ─── Summary ─────────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total: ${results.length + workflowResults.length} | Pass: ${totalPass} | Fail: ${totalFail}`);
  console.log(`  Pass rate: ${((totalPass / (results.length + workflowResults.length)) * 100).toFixed(1)}%`);

  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const totalTokens = results.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  console.log(`  Avg latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Total tokens: ${totalTokens}`);

  if (totalFail > 0) {
    console.log('\n  FAILURES:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    [${r.id}] ${r.failures.join('; ')}`);
    }
    for (const r of workflowResults.filter(r => !r.pass)) {
      console.log(`    [${r.id}] ${r.failures.join('; ')}`);
    }
  }

  // Per-agent breakdown
  console.log('\n  PER-AGENT:');
  for (const [agentGroup, agentTests] of grouped) {
    const agentResults = results.filter(r => agentTests.some(t => t.id === r.id));
    const agentPass = agentResults.filter(r => r.pass).length;
    const agentAvgLatency = agentResults.reduce((s, r) => s + r.latencyMs, 0) / agentResults.length;
    console.log(`    ${agentGroup.padEnd(15)} ${agentPass}/${agentResults.length} pass | avg ${agentAvgLatency.toFixed(0)}ms`);
  }

  console.log(`\n${'═'.repeat(60)}\n`);

  Deno.exit(totalFail > 0 ? 1 : 0);
}

main();
