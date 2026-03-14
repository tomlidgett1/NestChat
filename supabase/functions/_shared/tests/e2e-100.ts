/**
 * Comprehensive 100-case end-to-end test suite for Option A orchestration.
 *
 * Tests TWO dimensions:
 *   1. ORCHESTRATION — correct routing, correct tools called
 *   2. OUTPUT QUALITY — response is helpful, grounded, appropriate tone/length
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/e2e-100.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation, cancelPendingEmailSends, getLatestPendingEmailSend } from '../state.ts';
import type { TurnInput, TurnResult } from '../orchestrator/types.ts';

const SENDER_HANDLE = '+61414187820';
const BOT_NUMBER = '+13466215973';
const CHAT_ID = `E2E#${BOT_NUMBER}#${SENDER_HANDLE}`;
const TIMEZONE = 'Australia/Melbourne';

// ═══════════════════════════════════════════════════════════════
// Quality criteria — applied to EVERY response
// ═══════════════════════════════════════════════════════════════

const BROKEN_PHRASES = [
  'i can\'t access', 'i don\'t have access', 'i\'m unable to',
  'i cannot access', 'no email accounts connected',
  'connection hiccup', 'not seeing any mail',
  'i\'m not able to', 'i don\'t have the ability',
  'as an ai', 'as a language model',
];

const FILLER_PHRASES = [
  'certainly!', 'absolutely!', 'of course!', 'sure thing!',
  'great question!', 'that\'s a great question',
  'i\'d be happy to help', 'i\'d be glad to',
];

function checkOutputQuality(text: string | null, tc: E2ECase): string[] {
  const qf: string[] = [];
  if (!text) return qf;
  const lower = text.toLowerCase();

  if (tc.expect.toolsUsed && tc.expect.toolsUsed.length > 0) {
    for (const phrase of BROKEN_PHRASES) {
      if (lower.includes(phrase)) {
        qf.push(`QUALITY: broken-phrase "${phrase}" — tool data should have been used`);
      }
    }
  }

  for (const phrase of FILLER_PHRASES) {
    if (lower.startsWith(phrase)) {
      qf.push(`QUALITY: filler-opener "${phrase}" — response should feel natural, not performative`);
    }
  }

  if (tc.expect.maxTextLength && text.length > tc.expect.maxTextLength) {
    qf.push(`QUALITY: too verbose (${text.length} > ${tc.expect.maxTextLength})`);
  }

  if (tc.expect.textNotContains) {
    for (const s of tc.expect.textNotContains) {
      if (lower.includes(s.toLowerCase())) qf.push(`QUALITY: should NOT contain "${s}"`);
    }
  }

  if (tc.expect.textContains) {
    for (const s of tc.expect.textContains) {
      if (!lower.includes(s.toLowerCase())) qf.push(`QUALITY: missing expected content "${s}"`);
    }
  }

  if (tc.expect.multiPartCheck) {
    const parts = tc.expect.multiPartCheck;
    let found = 0;
    for (const part of parts) {
      if (lower.includes(part.toLowerCase())) found++;
    }
    if (found < parts.length) {
      qf.push(`QUALITY: multi-part incomplete — found ${found}/${parts.length} expected sections (${parts.filter(p => !lower.includes(p.toLowerCase())).join(', ')})`);
    }
  }

  return qf;
}

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface E2ECase {
  id: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'extreme' | 'edge';
  message: string;
  expect: {
    routeAgent?: 'chat' | 'smart';
    hasText: boolean;
    minTextLength?: number;
    maxTextLength?: number;
    toolsUsed?: string[];
    toolsNotUsed?: string[];
    textContains?: string[];
    textNotContains?: string[];
    multiPartCheck?: string[];
  };
}

interface E2EResult {
  id: string;
  category: string;
  difficulty: string;
  pass: boolean;
  orchPass: boolean;
  qualityPass: boolean;
  failures: string[];
  qualityFailures: string[];
  routedTo: string;
  toolsUsed: string[];
  latencyMs: number;
  responsePreview: string;
  inputTokens: number;
  outputTokens: number;
}

interface WorkflowResult {
  id: string;
  category: string;
  difficulty: string;
  pass: boolean;
  failures: string[];
  latencyMs: number;
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

async function runCase(tc: E2ECase): Promise<E2EResult> {
  const start = Date.now();
  const failures: string[] = [];

  try {
    await clearConversation(CHAT_ID);
    await cancelPendingEmailSends(CHAT_ID, 'e2e_reset');
  } catch { /* best effort */ }

  let result: TurnResult;
  try {
    result = await handleTurn(makeTurnInput(tc.message));
  } catch (err) {
    return {
      id: tc.id, category: tc.category, difficulty: tc.difficulty,
      pass: false, orchPass: false, qualityPass: false,
      failures: [`THREW: ${(err as Error).message}`], qualityFailures: [],
      routedTo: 'ERROR', toolsUsed: [], latencyMs: Date.now() - start,
      responsePreview: '', inputTokens: 0, outputTokens: 0,
    };
  }

  const latencyMs = Date.now() - start;
  const trace = result.trace;
  const toolNames = trace.toolCalls.map(t => t.name);

  // --- Orchestration checks ---
  if (tc.expect.routeAgent && trace.agentName !== tc.expect.routeAgent) {
    failures.push(`route: expected ${tc.expect.routeAgent}, got ${trace.agentName}`);
  }
  if (tc.expect.hasText && !result.text) {
    failures.push('expected text response, got null');
  }
  if (result.text && tc.expect.minTextLength && result.text.length < tc.expect.minTextLength) {
    failures.push(`text too short: ${result.text.length} < ${tc.expect.minTextLength}`);
  }
  if (tc.expect.toolsUsed) {
    for (const t of tc.expect.toolsUsed) {
      if (!toolNames.includes(t)) failures.push(`expected tool ${t} not used (used: ${toolNames.join(', ')})`);
    }
  }
  if (tc.expect.toolsNotUsed) {
    for (const t of tc.expect.toolsNotUsed) {
      if (toolNames.includes(t)) failures.push(`tool ${t} should NOT have been used`);
    }
  }

  // --- Quality checks ---
  const qualityFailures = checkOutputQuality(result.text, tc);

  const orchPass = failures.length === 0;
  const qualityPass = qualityFailures.length === 0;

  return {
    id: tc.id, category: tc.category, difficulty: tc.difficulty,
    pass: orchPass && qualityPass, orchPass, qualityPass,
    failures, qualityFailures,
    routedTo: trace.agentName, toolsUsed: toolNames,
    latencyMs, responsePreview: result.text?.substring(0, 200) ?? '(null)',
    inputTokens: trace.inputTokens, outputTokens: trace.outputTokens,
  };
}

async function runTurn(chatId: string, message: string): Promise<TurnResult> {
  return handleTurn(makeTurnInput(message, chatId));
}

async function resetChat(chatId: string): Promise<void> {
  await clearConversation(chatId);
  await cancelPendingEmailSends(chatId, 'e2e_workflow_reset');
}

async function runWorkflow(
  id: string, category: string, difficulty: string,
  fn: (chatId: string, failures: string[]) => Promise<void>,
): Promise<WorkflowResult> {
  const chatId = `E2E#workflow#${id}`;
  const failures: string[] = [];
  const start = Date.now();
  try {
    await resetChat(chatId);
    await fn(chatId, failures);
  } catch (err) {
    failures.push(`THREW: ${(err as Error).message}`);
  }
  return { id, category, difficulty, pass: failures.length === 0, failures, latencyMs: Date.now() - start };
}

// ═══════════════════════════════════════════════════════════════
// 80 SINGLE-TURN TEST CASES
// ═══════════════════════════════════════════════════════════════

const SINGLE_TURN_CASES: E2ECase[] = [
  // ─── CASUAL / CHAT (10 cases) ────────────────────────────────
  { id: 'chat-1', category: 'casual', difficulty: 'easy', message: 'Hey!',
    expect: { routeAgent: 'chat', hasText: true, maxTextLength: 300, toolsNotUsed: ['email_read', 'calendar_read'] } },
  { id: 'chat-2', category: 'casual', difficulty: 'easy', message: 'Good morning',
    expect: { routeAgent: 'chat', hasText: true, maxTextLength: 300 } },
  { id: 'chat-3', category: 'casual', difficulty: 'easy', message: 'lol',
    expect: { routeAgent: 'chat', hasText: true, maxTextLength: 200 } },
  { id: 'chat-4', category: 'casual', difficulty: 'medium', message: "I'm feeling stressed about work, any tips?",
    expect: { routeAgent: 'chat', hasText: true, minTextLength: 30, textNotContains: ['as an ai'] } },
  { id: 'chat-5', category: 'casual', difficulty: 'medium', message: 'What are your thoughts on remote work vs office?',
    expect: { routeAgent: 'chat', hasText: true, minTextLength: 30 } },
  { id: 'chat-6', category: 'casual', difficulty: 'medium', message: 'Tell me a joke',
    expect: { routeAgent: 'chat', hasText: true } },
  { id: 'chat-7', category: 'casual', difficulty: 'hard', message: 'Help me think through whether I should take this new job offer. The pay is 20% more but the commute is 1.5 hours each way.',
    expect: { routeAgent: 'chat', hasText: true, minTextLength: 50 } },
  { id: 'chat-8', category: 'casual', difficulty: 'hard', message: 'Explain quantum computing to me like I\'m 10',
    expect: { hasText: true, minTextLength: 50 } },
  { id: 'chat-9', category: 'casual', difficulty: 'extreme', message: 'Write me a short poem about Monday mornings in the style of Shakespeare',
    expect: { hasText: true, minTextLength: 30 } },
  { id: 'chat-10', category: 'casual', difficulty: 'extreme', message: 'I need to give a best man speech at my mate\'s wedding next week. Help me brainstorm — he loves surfing, craft beer, and terrible puns.',
    expect: { hasText: true, minTextLength: 80 } },

  // ─── EMAIL (10 cases) ─────────────────────────────────────────
  { id: 'email-1', category: 'email', difficulty: 'easy', message: 'Check my latest emails',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], minTextLength: 50,
      textNotContains: ['no email accounts', 'connection hiccup', 'not seeing any mail'] } },
  { id: 'email-2', category: 'email', difficulty: 'easy', message: 'Do I have any unread emails?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'] } },
  { id: 'email-3', category: 'email', difficulty: 'medium', message: 'Search my emails for anything from Blacklane',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], textContains: ['blacklane'] } },
  { id: 'email-4', category: 'email', difficulty: 'medium', message: 'Draft an email to tom@lidgett.net with subject "E2E Test" saying "Please disregard this test."',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_draft'], textContains: ['draft'] } },
  { id: 'email-5', category: 'email', difficulty: 'hard', message: 'Search my emails for anything about invoices or payments in the last week and summarise the key points',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], minTextLength: 20 } },
  { id: 'email-6', category: 'email', difficulty: 'hard', message: 'Find the most recent email from OpenAI and tell me what it says',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], textContains: ['openai'] } },
  { id: 'email-7', category: 'email', difficulty: 'extreme', message: 'Search my emails for anything about the Singapore project, summarise the timeline, and draft an update email to tom@lidgett.net with the summary',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], minTextLength: 30 } },
  { id: 'email-8', category: 'email', difficulty: 'easy', message: 'Any new emails?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'] } },
  { id: 'email-9', category: 'email', difficulty: 'medium', message: 'What emails did I get today?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'] } },
  { id: 'email-10', category: 'email', difficulty: 'hard', message: 'Find all emails from Origin Energy and tell me what they\'re about',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], textContains: ['origin'] } },

  // ─── CALENDAR (10 cases) ──────────────────────────────────────
  { id: 'cal-1', category: 'calendar', difficulty: 'easy', message: "What's on my calendar today?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-2', category: 'calendar', difficulty: 'easy', message: "What's my next meeting?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-3', category: 'calendar', difficulty: 'medium', message: 'What meetings do I have this week?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-4', category: 'calendar', difficulty: 'medium', message: 'When am I free tomorrow afternoon?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-5', category: 'calendar', difficulty: 'hard', message: "What's my schedule for the rest of the week? Any gaps where I could fit a 30 min call?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 30 } },
  { id: 'cal-6', category: 'calendar', difficulty: 'hard', message: 'Am I double-booked at all this week?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-7', category: 'calendar', difficulty: 'extreme', message: "Look at my calendar for the next 2 weeks and tell me which days are the busiest and which have the most free time",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 50 } },
  { id: 'cal-8', category: 'calendar', difficulty: 'easy', message: 'Do I have anything on tomorrow?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-9', category: 'calendar', difficulty: 'medium', message: 'What time does my first meeting start tomorrow?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'cal-10', category: 'calendar', difficulty: 'extreme', message: 'Analyse my calendar for this week — how much time am I spending in meetings vs free time? Give me a breakdown.',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 50 } },

  // ─── RESEARCH / WEB (8 cases) ─────────────────────────────────
  { id: 'research-1', category: 'research', difficulty: 'easy', message: "What's the weather in Melbourne?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], textContains: ['melbourne'] } },
  { id: 'research-2', category: 'research', difficulty: 'easy', message: "What's the latest news about AI?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 30 } },
  { id: 'research-3', category: 'research', difficulty: 'medium', message: 'Compare Toyota HiLux vs Mazda BT-50 for towing capacity',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 50, multiPartCheck: ['hilux', 'bt-50'] } },
  { id: 'research-4', category: 'research', difficulty: 'medium', message: 'Who won the latest F1 race?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'] } },
  { id: 'research-5', category: 'research', difficulty: 'hard', message: 'Give me a detailed breakdown of the Iran situation in 2026 — key events, diplomatic responses, and current status',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 100 } },
  { id: 'research-6', category: 'research', difficulty: 'hard', message: 'What are the best noise-cancelling headphones in 2026? Compare the top 3 with pros and cons.',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 50 } },
  { id: 'research-7', category: 'research', difficulty: 'extreme', message: 'Research the current state of nuclear fusion energy — latest breakthroughs, key companies, timeline to commercialisation, and investment landscape',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 100 } },
  { id: 'research-8', category: 'research', difficulty: 'extreme', message: 'What are the geopolitical implications of the BRICS expansion? Cover economic, military, and diplomatic angles.',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search'], minTextLength: 100 } },

  // ─── RECALL / MEMORY (6 cases) ────────────────────────────────
  { id: 'recall-1', category: 'recall', difficulty: 'easy', message: 'What do you know about me?',
    expect: { routeAgent: 'smart', hasText: true, minTextLength: 20 } },
  { id: 'recall-2', category: 'recall', difficulty: 'medium', message: 'What are my food preferences?',
    expect: { routeAgent: 'smart', hasText: true } },
  { id: 'recall-3', category: 'recall', difficulty: 'medium', message: 'Do you remember what I told you about my travel plans?',
    expect: { routeAgent: 'smart', hasText: true } },
  { id: 'recall-4', category: 'recall', difficulty: 'hard', message: 'What have I discussed with you about my career goals?',
    expect: { routeAgent: 'smart', hasText: true } },
  { id: 'recall-5', category: 'recall', difficulty: 'hard', message: 'What did I discuss with Azupay?',
    expect: { routeAgent: 'smart', hasText: true } },
  { id: 'recall-6', category: 'recall', difficulty: 'extreme', message: 'Give me a comprehensive summary of everything you know about me — interests, preferences, work, goals',
    expect: { routeAgent: 'smart', hasText: true, minTextLength: 80 } },

  // ─── CONTACTS (4 cases) ───────────────────────────────────────
  { id: 'contacts-1', category: 'contacts', difficulty: 'easy', message: "What's Tom's email address?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },
  { id: 'contacts-2', category: 'contacts', difficulty: 'medium', message: 'Who is Daniel Barth?',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },
  { id: 'contacts-3', category: 'contacts', difficulty: 'hard', message: "Find Sarah's contact details and tell me when I last emailed her",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },
  { id: 'contacts-4', category: 'contacts', difficulty: 'easy', message: "Do I have a contact called James?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },

  // ─── COMPOUND / MULTI-DOMAIN (12 cases) ───────────────────────
  { id: 'compound-1', category: 'compound', difficulty: 'medium', message: "What's on my calendar today and do I have any unread emails?",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read', 'email_read'], multiPartCheck: ['calendar', 'email'] } },
  { id: 'compound-2', category: 'compound', difficulty: 'medium', message: "Find Dan's email and book 30 mins next week",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },
  { id: 'compound-3', category: 'compound', difficulty: 'hard', message: 'Check my calendar for tomorrow, find any emails related to those meetings, and summarise everything',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 30 } },
  { id: 'compound-4', category: 'compound', difficulty: 'hard', message: 'Search my emails for anything from Blacklane, summarise it, and draft a reply to the sender',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'], minTextLength: 20, textContains: ['blacklane'] } },
  { id: 'compound-5', category: 'compound', difficulty: 'hard', message: "What's the weather in Dubai and also check my calendar for tomorrow",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search', 'calendar_read'], multiPartCheck: ['dubai', 'calendar'] } },
  { id: 'compound-6', category: 'compound', difficulty: 'extreme', message: 'Check my calendar for tomorrow, find any emails related to those meetings, and draft a prep summary email to tom@lidgett.net',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'], minTextLength: 20 } },
  { id: 'compound-7', category: 'compound', difficulty: 'extreme', message: 'Look up the latest AI regulation news, then draft an email to tom@lidgett.net summarising the key points',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['web_search', 'email_draft'], minTextLength: 20 } },
  { id: 'compound-8', category: 'compound', difficulty: 'extreme', message: 'Prep me for my next meeting and draft that brief to tom@lidgett.net',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'compound-9', category: 'compound', difficulty: 'hard', message: 'Who emailed me today? Summarise and send to Tom',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read'] } },
  { id: 'compound-10', category: 'compound', difficulty: 'medium', message: "What's Tom's email? Draft him a note about Friday",
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['contacts_read'] } },
  { id: 'compound-11', category: 'compound', difficulty: 'extreme', message: 'Check my emails and calendar for today, then give me a morning briefing',
    expect: { routeAgent: 'smart', hasText: true, toolsUsed: ['email_read', 'calendar_read'], minTextLength: 50, multiPartCheck: ['email', 'calendar'] } },
  { id: 'compound-12', category: 'compound', difficulty: 'extreme', message: 'What did we discuss last week? Send a recap to tom@lidgett.net',
    expect: { routeAgent: 'smart', hasText: true } },

  // ─── EDGE CASES (10 cases) ────────────────────────────────────
  { id: 'edge-1', category: 'edge', difficulty: 'edge', message: '?',
    expect: { hasText: true, maxTextLength: 300 } },
  { id: 'edge-2', category: 'edge', difficulty: 'edge', message: 'Thanks',
    expect: { routeAgent: 'chat', hasText: true, maxTextLength: 300 } },
  { id: 'edge-3', category: 'edge', difficulty: 'edge', message: 'waht tiem is my nxt meeitng',
    expect: { hasText: true, toolsUsed: ['calendar_read'] } },
  { id: 'edge-4', category: 'edge', difficulty: 'edge', message: 'haha yeah true',
    expect: { hasText: true, maxTextLength: 300 } },
  { id: 'edge-5', category: 'edge', difficulty: 'edge', message: 'Im bored lol',
    expect: { routeAgent: 'chat', hasText: true } },
  { id: 'edge-6', category: 'edge', difficulty: 'edge', message: 'yo',
    expect: { routeAgent: 'chat', hasText: true, maxTextLength: 200 } },
  { id: 'edge-7', category: 'edge', difficulty: 'edge', message: 'Tell me about the history of Japan',
    expect: { hasText: true, minTextLength: 50 } },
  { id: 'edge-8', category: 'edge', difficulty: 'edge', message: 'How does venture capital work?',
    expect: { hasText: true, minTextLength: 30 } },
  { id: 'edge-9', category: 'edge', difficulty: 'edge', message: 'Can you help me with something?',
    expect: { hasText: true, maxTextLength: 400 } },
  { id: 'edge-10', category: 'edge', difficulty: 'edge', message: 'I need you to help me with something. So basically what happened is that I was at work today and my boss Daniel came up to me and said that we need to restructure the entire Singapore incentive program because the current metrics are not aligned with our Q2 targets.',
    expect: { hasText: true, minTextLength: 30 } },
];

// ═══════════════════════════════════════════════════════════════
// 20 MULTI-TURN WORKFLOW CASES
// ═══════════════════════════════════════════════════════════════

async function defineWorkflows(): Promise<WorkflowResult[]> {
  const results: WorkflowResult[] = [];

  results.push(await runWorkflow('wf-draft-send', 'workflow', 'easy', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "E2E WF1" saying "Test email, please disregard."');
    if (!t1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('t1: no email_draft');
    if (t1.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t1: should not send yet');
    if (!t1.text?.toLowerCase().includes('draft')) failures.push('t1: response should mention the draft');
    const t2 = await runTurn(chatId, 'Send it');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t2: no email_send');
  }));

  results.push(await runWorkflow('wf-draft-yep', 'workflow', 'easy', async (chatId, failures) => {
    await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "E2E WF2" saying "Test email, please disregard."');
    const t2 = await runTurn(chatId, 'Yep');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t2: no email_send after Yep');
  }));

  results.push(await runWorkflow('wf-draft-revise-send', 'workflow', 'medium', async (chatId, failures) => {
    await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "E2E WF3" saying "Test email."');
    const t2 = await runTurn(chatId, 'Change the subject to "E2E WF3 revised"');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_draft' || t.name === 'email_update_draft')) failures.push('t2: no draft revision');
    const t3 = await runTurn(chatId, 'Looks good, send it');
    if (!t3.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t3: no email_send');
  }));

  results.push(await runWorkflow('wf-draft-cancel', 'workflow', 'medium', async (chatId, failures) => {
    await runTurn(chatId, 'Draft an email to tom@lidgett.net with subject "E2E WF4" saying "Test email."');
    const t2 = await runTurn(chatId, 'Actually nah, cancel that');
    if (!t2.text) failures.push('t2: no response');
  }));

  results.push(await runWorkflow('wf-casual-to-task', 'workflow', 'medium', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Hey, how are you?');
    if (!t1.text) failures.push('t1: no response');
    const t2 = await runTurn(chatId, "What's on my calendar today?");
    if (!t2.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t2: no calendar_read after pivot');
  }));

  results.push(await runWorkflow('wf-task-to-casual', 'workflow', 'medium', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Check my latest emails');
    if (!t1.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t1: no email_read');
    if (t1.text && BROKEN_PHRASES.some(p => t1.text!.toLowerCase().includes(p))) failures.push('t1: broken phrase in email response');
    const t2 = await runTurn(chatId, 'Cool thanks, how are you doing?');
    if (!t2.text) failures.push('t2: no response');
  }));

  results.push(await runWorkflow('wf-cal-followup', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's on my calendar today?");
    if (!t1.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t1: no calendar_read');
    const t2 = await runTurn(chatId, 'And what about tomorrow?');
    if (!t2.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t2: no calendar_read for follow-up');
  }));

  results.push(await runWorkflow('wf-email-search-reply', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Search my emails for anything from Blacklane');
    if (!t1.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t1: no email_read');
    if (t1.text && !t1.text.toLowerCase().includes('blacklane')) failures.push('t1: response should mention Blacklane');
    const t2 = await runTurn(chatId, 'Draft a reply to the latest one saying thanks');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('t2: no email_draft');
  }));

  results.push(await runWorkflow('wf-meetprep-draft-send', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Prep me for my next meeting and draft that brief to tom@lidgett.net');
    if (!t1.text) failures.push('t1: no response');
    const usedDraft = t1.trace.toolCalls.some(t => t.name === 'email_draft');
    const pending = await getLatestPendingEmailSend(chatId);
    if (usedDraft && pending) {
      const t2 = await runTurn(chatId, 'Yes');
      if (!t2.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t2: no email_send');
    }
  }));

  results.push(await runWorkflow('wf-research-draft', 'workflow', 'extreme', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's the latest news about AI regulation?");
    if (!t1.trace.toolCalls.some(t => t.name === 'web_search')) failures.push('t1: no web_search');
    if (t1.text && t1.text.length < 50) failures.push('t1: research response too short');
    const t2 = await runTurn(chatId, 'Draft an email to tom@lidgett.net summarising that');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('t2: no email_draft');
  }));

  results.push(await runWorkflow('wf-double-greeting-task', 'workflow', 'hard', async (chatId, failures) => {
    await runTurn(chatId, 'Hey!');
    await runTurn(chatId, 'How are you?');
    const t3 = await runTurn(chatId, 'Check my emails');
    if (!t3.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t3: no email_read after double greeting');
  }));

  results.push(await runWorkflow('wf-domain-switch', 'workflow', 'extreme', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's on my calendar today?");
    if (!t1.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t1: no calendar_read');
    const t2 = await runTurn(chatId, 'Check my latest emails');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t2: no email_read');
    const t3 = await runTurn(chatId, 'And what about my calendar tomorrow?');
    if (!t3.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t3: no calendar_read on switch back');
  }));

  results.push(await runWorkflow('wf-draft-edit-send', 'workflow', 'hard', async (chatId, failures) => {
    await runTurn(chatId, 'Draft an email to tom@lidgett.net saying "Hey mate, just checking in about the project."');
    const t2 = await runTurn(chatId, 'Make it more formal');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_draft' || t.name === 'email_update_draft')) failures.push('t2: no draft update');
    const t3 = await runTurn(chatId, 'Perfect, send it');
    if (!t3.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t3: no email_send');
  }));

  results.push(await runWorkflow('wf-ambiguous-clarify', 'workflow', 'medium', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Can you help me with something?');
    if (!t1.text) failures.push('t1: no response');
    const t2 = await runTurn(chatId, 'Yeah, check my calendar for today');
    if (!t2.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t2: no calendar_read');
  }));

  results.push(await runWorkflow('wf-recall-followup', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'What do you know about me?');
    if (!t1.text || t1.text.length < 20) failures.push('t1: recall response too short');
    const t2 = await runTurn(chatId, 'What about my work interests?');
    if (!t2.text) failures.push('t2: no response');
  }));

  results.push(await runWorkflow('wf-research-followup', 'workflow', 'medium', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's the weather in Melbourne?");
    if (!t1.trace.toolCalls.some(t => t.name === 'web_search')) failures.push('t1: no web_search');
    if (t1.text && !t1.text.toLowerCase().includes('melbourne')) failures.push('t1: should mention Melbourne');
    const t2 = await runTurn(chatId, 'And what about Sydney?');
    if (!t2.trace.toolCalls.some(t => t.name === 'web_search')) failures.push('t2: no web_search for follow-up');
    if (t2.text && !t2.text.toLowerCase().includes('sydney')) failures.push('t2: should mention Sydney');
  }));

  results.push(await runWorkflow('wf-contact-then-email', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's Tom's email address?");
    if (!t1.trace.toolCalls.some(t => t.name === 'contacts_read')) failures.push('t1: no contacts_read');
    const t2 = await runTurn(chatId, 'Draft him an email saying "Hey, let\'s catch up this week"');
    if (!t2.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('t2: no email_draft');
  }));

  results.push(await runWorkflow('wf-long-casual', 'workflow', 'extreme', async (chatId, failures) => {
    await runTurn(chatId, 'Hey!');
    await runTurn(chatId, 'How was your weekend?');
    await runTurn(chatId, 'Mine was good, went surfing');
    const t4 = await runTurn(chatId, 'Oh btw, check my emails');
    if (!t4.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t4: no email_read after casual chain');
    if (t4.text && BROKEN_PHRASES.some(p => t4.text!.toLowerCase().includes(p))) failures.push('t4: broken phrase in email response');
  }));

  results.push(await runWorkflow('wf-draft-send-same-turn', 'workflow', 'hard', async (chatId, failures) => {
    const t1 = await runTurn(chatId, 'Draft and send an email to tom@lidgett.net with subject "E2E WF19" saying "Please disregard."');
    if (!t1.trace.toolCalls.some(t => t.name === 'email_draft')) failures.push('t1: no email_draft');
    if (t1.trace.toolCalls.some(t => t.name === 'email_send')) failures.push('t1: should NOT send without confirmation');
  }));

  results.push(await runWorkflow('wf-compound-followup', 'workflow', 'extreme', async (chatId, failures) => {
    const t1 = await runTurn(chatId, "What's on my calendar today and check my emails?");
    if (!t1.trace.toolCalls.some(t => t.name === 'calendar_read')) failures.push('t1: no calendar_read');
    if (!t1.trace.toolCalls.some(t => t.name === 'email_read')) failures.push('t1: no email_read');
    if (t1.text && BROKEN_PHRASES.some(p => t1.text!.toLowerCase().includes(p))) failures.push('t1: broken phrase');
    const t2 = await runTurn(chatId, 'Tell me more about that first email');
    if (!t2.text) failures.push('t2: no response for follow-up');
  }));

  return results;
}

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Nest V3 — 100-Case E2E Test Suite (v2)                    ║');
  console.log('║  Orchestration + Output Quality — Live Data                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Resolving authUserId...');
  try {
    const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
    authUserId = nestUser.authUserId ?? null;
    console.log(`  authUserId: ${authUserId}\n`);
  } catch (err) {
    console.error('Failed to resolve nest user:', (err as Error).message);
    Deno.exit(1);
  }

  const singleResults: E2EResult[] = [];
  let totalPass = 0;
  let totalFail = 0;
  let totalOrchFail = 0;
  let totalQualityFail = 0;

  const grouped = new Map<string, E2ECase[]>();
  for (const tc of SINGLE_TURN_CASES) {
    const group = grouped.get(tc.category) ?? [];
    group.push(tc);
    grouped.set(tc.category, group);
  }

  console.log(`${'═'.repeat(60)}`);
  console.log('  SINGLE-TURN TESTS (80 cases)');
  console.log(`${'═'.repeat(60)}`);

  for (const [cat, cases] of grouped) {
    console.log(`\n  ── ${cat.toUpperCase()} (${cases.length} cases) ──`);
    for (const tc of cases) {
      const label = `[${tc.id}] ${tc.difficulty} — "${tc.message.substring(0, 70)}${tc.message.length > 70 ? '...' : ''}"`;
      console.log(`\n  ${label}`);

      const r = await runCase(tc);
      singleResults.push(r);

      if (r.pass) {
        totalPass++;
        console.log(`  ✓ PASS | agent=${r.routedTo} | tools=[${r.toolsUsed.join(', ')}] | ${r.latencyMs}ms | ${r.inputTokens}in/${r.outputTokens}out`);
        console.log(`    "${r.responsePreview}"`);
      } else {
        totalFail++;
        if (!r.orchPass) totalOrchFail++;
        if (!r.qualityPass) totalQualityFail++;
        const tag = !r.orchPass && !r.qualityPass ? 'ORCH+QUALITY' : !r.orchPass ? 'ORCH' : 'QUALITY';
        console.log(`  ✗ FAIL [${tag}] | agent=${r.routedTo} | tools=[${r.toolsUsed.join(', ')}] | ${r.latencyMs}ms`);
        for (const f of r.failures) console.log(`    ✗ ${f}`);
        for (const f of r.qualityFailures) console.log(`    ✗ ${f}`);
        console.log(`    "${r.responsePreview}"`);
      }
    }
  }

  // Workflow tests
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  MULTI-TURN WORKFLOW TESTS (20 cases)');
  console.log(`${'═'.repeat(60)}`);

  const workflowResults = await defineWorkflows();
  for (const r of workflowResults) {
    if (r.pass) {
      totalPass++;
      console.log(`  ✓ PASS [${r.id}] ${r.difficulty} | ${r.latencyMs}ms`);
    } else {
      totalFail++;
      totalOrchFail++;
      console.log(`  ✗ FAIL [${r.id}] ${r.difficulty} | ${r.latencyMs}ms`);
      for (const f of r.failures) console.log(`    ✗ ${f}`);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────
  const total = singleResults.length + workflowResults.length;
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('  FINAL SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total: ${total} | Pass: ${totalPass} | Fail: ${totalFail}`);
  console.log(`  Pass rate: ${((totalPass / total) * 100).toFixed(1)}%`);
  console.log(`  Orchestration failures: ${totalOrchFail}`);
  console.log(`  Quality failures: ${totalQualityFail}`);

  const avgLatency = singleResults.reduce((s, r) => s + r.latencyMs, 0) / singleResults.length;
  const totalTokens = singleResults.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  console.log(`  Avg single-turn latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Total tokens: ${totalTokens}`);

  console.log('\n  PER-CATEGORY:');
  for (const [cat, cases] of grouped) {
    const catResults = singleResults.filter(r => r.category === cat);
    const catPass = catResults.filter(r => r.pass).length;
    const catOrch = catResults.filter(r => r.orchPass).length;
    const catQual = catResults.filter(r => r.qualityPass).length;
    const catAvg = catResults.reduce((s, r) => s + r.latencyMs, 0) / catResults.length;
    console.log(`    ${cat.padEnd(15)} ${catPass}/${catResults.length} pass (orch=${catOrch} qual=${catQual}) | avg ${catAvg.toFixed(0)}ms`);
  }
  const wfPass = workflowResults.filter(r => r.pass).length;
  const wfAvg = workflowResults.reduce((s, r) => s + r.latencyMs, 0) / workflowResults.length;
  console.log(`    ${'workflow'.padEnd(15)} ${wfPass}/${workflowResults.length} pass | avg ${wfAvg.toFixed(0)}ms`);

  console.log('\n  PER-DIFFICULTY:');
  for (const diff of ['easy', 'medium', 'hard', 'extreme', 'edge']) {
    const diffSingle = singleResults.filter(r => r.difficulty === diff);
    const diffWf = workflowResults.filter(r => r.difficulty === diff);
    const diffPass = diffSingle.filter(r => r.pass).length + diffWf.filter(r => r.pass).length;
    const diffTotal = diffSingle.length + diffWf.length;
    if (diffTotal > 0) console.log(`    ${diff.padEnd(15)} ${diffPass}/${diffTotal} pass`);
  }

  if (totalFail > 0) {
    console.log('\n  ALL FAILURES:');
    for (const r of singleResults.filter(r => !r.pass)) {
      const allF = [...r.failures, ...r.qualityFailures];
      console.log(`    [${r.id}] ${allF.join('; ')}`);
    }
    for (const r of workflowResults.filter(r => !r.pass)) {
      console.log(`    [${r.id}] ${r.failures.join('; ')}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}\n`);
  Deno.exit(totalFail > 0 ? 1 : 0);
}

main();
