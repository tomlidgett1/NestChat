/**
 * Latency & Routing focused tests.
 * Tests fast-path coverage, context path selection, RAG gating, model tier.
 * 
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/latency-routing-tests.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, cancelPendingEmailSends, createPendingEmailSend, clearConversation } from '../state.ts';
import type { TurnInput, TurnResult, TurnTrace } from '../orchestrator/types.ts';

const SENDER_HANDLE = '+61414187820';
const BOT_NUMBER = '+13466215973';
const CHAT_ID = `DM#${BOT_NUMBER}#${SENDER_HANDLE}`;
const TIMEZONE = 'Australia/Melbourne';

interface LatencyTest {
  id: string;
  category: string;
  message: string;
  chatId?: string;
  setup?: () => Promise<void>;
  expect: {
    routeAgent: string;
    fastPath: boolean;
    contextPath?: 'light' | 'full';
    ragSkipped?: boolean;
    model?: string;
    maxLatencyMs: number;
  };
}

interface LatencyResult {
  id: string;
  category: string;
  message: string;
  pass: boolean;
  failures: string[];
  routedTo: string;
  fastPath: boolean;
  contextPath: string;
  ragSkipped: boolean;
  model: string;
  latencyMs: number;
  routeMs: number;
  contextMs: number;
  agentLoopMs: number;
  ragMs: number;
  memoryMs: number;
  inputTokens: number;
  outputTokens: number;
  promptLength: number;
  memoryItems: number;
  summaries: number;
  ragBlocks: number;
  responsePreview: string;
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

const tests: LatencyTest[] = [
  // ─── CASUAL / ACKNOWLEDGEMENT (target: <3s) ──────────────
  { id: 'ack-hey', category: 'Acknowledgement', message: 'Hey', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-hi', category: 'Acknowledgement', message: 'Hi', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-thanks', category: 'Acknowledgement', message: 'Thanks', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-ok', category: 'Acknowledgement', message: 'Ok', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-nice', category: 'Acknowledgement', message: 'Nice', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-cool', category: 'Acknowledgement', message: 'Cool', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-morning', category: 'Acknowledgement', message: 'Good morning', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-lol', category: 'Acknowledgement', message: 'Lol', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-question-mark', category: 'Acknowledgement', message: '?', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-yep', category: 'Acknowledgement', message: 'Yep', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  { id: 'ack-cheers', category: 'Acknowledgement', message: 'Cheers', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', ragSkipped: true, maxLatencyMs: 3000 } },
  {
    id: 'confirm-yep-pending',
    category: 'Confirmation',
    message: 'Yep',
    chatId: 'TEST#latency-confirm-yep',
    setup: async () => {
      await clearConversation('TEST#latency-confirm-yep');
      await cancelPendingEmailSends('TEST#latency-confirm-yep', 'test_reset');
      await createPendingEmailSend({
        chatId: 'TEST#latency-confirm-yep',
        draftId: 'draft-latency-yep',
        account: 'tom@lidgett.net',
        to: ['tom@lidgett.net'],
        subject: 'Latency confirmation test',
      });
    },
    expect: { routeAgent: 'productivity', fastPath: true, contextPath: 'light', ragSkipped: true, model: 'gemini-3.1-flash-lite-preview', maxLatencyMs: 6000 },
  },

  // ─── CASUAL CHAT (target: <5s) ───────────────────────────
  { id: 'chat-how-are-you', category: 'Casual Chat', message: 'Hey, how are you?', expect: { routeAgent: 'casual', fastPath: true, maxLatencyMs: 5000 } },
  { id: 'chat-stressed', category: 'Casual Chat', message: "I'm feeling a bit stressed about work lately", expect: { routeAgent: 'casual', fastPath: false, maxLatencyMs: 8000 } },
  { id: 'chat-whats-up', category: 'Casual Chat', message: "What's up?", expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', maxLatencyMs: 3000 } },

  // ─── RESEARCH (target: <8s for fast-path, <12s for LLM-routed) ─
  { id: 'res-history', category: 'Research', message: 'Give me some history on Australia', expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 8000 } },
  { id: 'res-president', category: 'Research', message: 'Who is the president of France?', expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 10000 } },
  { id: 'res-weather', category: 'Research', message: "What's the weather in Melbourne?", expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 10000 } },
  { id: 'res-explain', category: 'Research', message: 'Explain how solar panels work', expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 8000 } },
  { id: 'res-compare', category: 'Research', message: 'Compare Tesla Model 3 vs BMW i4', expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 12000 } },

  // ─── CALENDAR (target: <10s) ─────────────────────────────
  { id: 'cal-today', category: 'Calendar', message: "What's on my calendar today?", expect: { routeAgent: 'productivity', fastPath: true, ragSkipped: true, maxLatencyMs: 12000 } },
  { id: 'cal-week', category: 'Calendar', message: "What meetings do I have this week?", expect: { routeAgent: 'productivity', fastPath: true, maxLatencyMs: 15000 } },

  // ─── EMAIL (target: <12s) ────────────────────────────────
  { id: 'email-check', category: 'Email', message: 'Check my latest emails', expect: { routeAgent: 'productivity', fastPath: true, maxLatencyMs: 15000 } },

  // ─── RECALL (target: <8s) ────────────────────────────────
  { id: 'recall-know', category: 'Recall', message: 'What do you know about me?', expect: { routeAgent: 'recall', fastPath: true, maxLatencyMs: 8000 } },
  { id: 'recall-food', category: 'Recall', message: 'What are my food preferences?', expect: { routeAgent: 'recall', fastPath: true, maxLatencyMs: 8000 } },

  // ─── ROUTING EDGE CASES ──────────────────────────────────
  { id: 'route-hello-question', category: 'Routing Edge', message: 'Hello?', expect: { routeAgent: 'casual', fastPath: true, contextPath: 'light', maxLatencyMs: 3000 } },
  { id: 'route-hey-whats-up', category: 'Routing Edge', message: 'Hey whats up', expect: { routeAgent: 'casual', fastPath: true, maxLatencyMs: 5000 } },
  { id: 'route-tell-me-about', category: 'Routing Edge', message: 'Tell me about the history of Japan', expect: { routeAgent: 'research', fastPath: true, ragSkipped: true, maxLatencyMs: 8000 } },
  { id: 'route-who-is', category: 'Routing Edge', message: 'Who is Elon Musk?', expect: { routeAgent: 'research', fastPath: true, maxLatencyMs: 10000 } },
  { id: 'route-look-up', category: 'Routing Edge', message: 'Look up the latest F1 results', expect: { routeAgent: 'research', fastPath: true, maxLatencyMs: 10000 } },
];

async function runTest(tc: LatencyTest): Promise<LatencyResult> {
  const start = Date.now();
  const failures: string[] = [];

  let result: TurnResult;
  try {
    if (tc.setup) await tc.setup();
    result = await handleTurn(makeTurnInput(tc.message, tc.chatId ?? CHAT_ID));
  } catch (err) {
    return {
      id: tc.id, category: tc.category, message: tc.message, pass: false,
      failures: [`THREW: ${(err as Error).message}`],
      routedTo: 'ERROR', fastPath: false, contextPath: 'unknown', ragSkipped: false,
      model: 'unknown', latencyMs: Date.now() - start, routeMs: 0, contextMs: 0,
      agentLoopMs: 0, ragMs: 0, memoryMs: 0, inputTokens: 0, outputTokens: 0,
      promptLength: 0, memoryItems: 0, summaries: 0, ragBlocks: 0, responsePreview: '',
    };
  }

  const latencyMs = Date.now() - start;
  const t = result.trace;
  const subTimings = t.contextSubTimings as Record<string, number> | null;

  if (t.agentName !== tc.expect.routeAgent) {
    failures.push(`route: expected ${tc.expect.routeAgent}, got ${t.agentName}`);
  }
  if (t.routeDecision.fastPathUsed !== tc.expect.fastPath) {
    failures.push(`fastPath: expected ${tc.expect.fastPath}, got ${t.routeDecision.fastPathUsed}`);
  }
  if (tc.expect.contextPath && t.contextPath !== tc.expect.contextPath) {
    failures.push(`contextPath: expected ${tc.expect.contextPath}, got ${t.contextPath}`);
  }

  const ragMs = subTimings?.ragMs ?? 0;
  const ragSkipped = ragMs === 0 || t.ragEvidenceBlocks === 0;
  if (tc.expect.ragSkipped === true && !ragSkipped) {
    failures.push(`RAG should be skipped but ran (${ragMs}ms, ${t.ragEvidenceBlocks} blocks)`);
  }

  if (tc.expect.model && t.modelUsed !== tc.expect.model) {
    failures.push(`model: expected ${tc.expect.model}, got ${t.modelUsed}`);
  }

  if (latencyMs > tc.expect.maxLatencyMs) {
    failures.push(`LATENCY: ${latencyMs}ms > ${tc.expect.maxLatencyMs}ms target`);
  }

  if (!result.text) {
    failures.push('no text response');
  }

  return {
    id: tc.id,
    category: tc.category,
    message: tc.message,
    pass: failures.length === 0,
    failures,
    routedTo: t.agentName,
    fastPath: t.routeDecision.fastPathUsed,
    contextPath: t.contextPath ?? 'unknown',
    ragSkipped,
    model: t.modelUsed,
    latencyMs,
    routeMs: t.routeDecision.routerLatencyMs,
    contextMs: t.contextBuildLatencyMs,
    agentLoopMs: t.agentLoopLatencyMs,
    ragMs,
    memoryMs: subTimings?.memoryMs ?? 0,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    promptLength: t.systemPromptLength,
    memoryItems: t.memoryItemsLoaded,
    summaries: t.summariesLoaded,
    ragBlocks: t.ragEvidenceBlocks,
    responsePreview: result.text?.substring(0, 120) ?? '(null)',
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Nest V3 — Latency & Routing Tests                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  try {
    const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
    authUserId = nestUser.authUserId ?? null;
    console.log(`authUserId: ${authUserId}\n`);
  } catch (err) {
    console.error('Failed to resolve nest user:', (err as Error).message);
    Deno.exit(1);
  }

  const results: LatencyResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  const grouped = new Map<string, LatencyTest[]>();
  for (const tc of tests) {
    const group = grouped.get(tc.category) ?? [];
    group.push(tc);
    grouped.set(tc.category, group);
  }

  for (const [category, catTests] of grouped) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${category.toUpperCase()}`);
    console.log(`${'═'.repeat(70)}`);

    for (const tc of catTests) {
      console.log(`\n  [${tc.id}] "${tc.message}"`);
      const r = await runTest(tc);
      results.push(r);

      const status = r.pass ? '✓' : '✗';
      const latencyColor = r.latencyMs <= tc.expect.maxLatencyMs ? '' : ' ⚠️';
      
      console.log(`  ${status} ${r.latencyMs}ms${latencyColor} | route=${r.routedTo}(${r.fastPath ? 'fast' : 'llm'}) | ctx=${r.contextPath} | model=${r.model}`);
      console.log(`    breakdown: route=${r.routeMs}ms ctx=${r.contextMs}ms(rag=${r.ragMs}ms mem=${r.memoryMs}ms) loop=${r.agentLoopMs}ms`);
      console.log(`    prompt=${r.promptLength}chars | mem=${r.memoryItems} sum=${r.summaries} rag=${r.ragBlocks} | ${r.inputTokens}in/${r.outputTokens}out`);
      
      if (!r.pass) {
        totalFail++;
        for (const f of r.failures) console.log(`    ✗ ${f}`);
      } else {
        totalPass++;
      }
      console.log(`    "${r.responsePreview}"`);
    }
  }

  // Summary
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total: ${results.length} | Pass: ${totalPass} | Fail: ${totalFail} | Rate: ${((totalPass / results.length) * 100).toFixed(1)}%`);

  // Per-category latency
  console.log('\n  PER-CATEGORY LATENCY:');
  for (const [category] of grouped) {
    const catResults = results.filter(r => r.category === category);
    const avg = catResults.reduce((s, r) => s + r.latencyMs, 0) / catResults.length;
    const max = Math.max(...catResults.map(r => r.latencyMs));
    const min = Math.min(...catResults.map(r => r.latencyMs));
    const passes = catResults.filter(r => r.pass).length;
    console.log(`    ${category.padEnd(20)} avg=${avg.toFixed(0)}ms min=${min}ms max=${max}ms | ${passes}/${catResults.length} pass`);
  }

  // Latency distribution
  console.log('\n  LATENCY BUCKETS:');
  const buckets = [
    { label: '< 2s', max: 2000 },
    { label: '2-3s', max: 3000 },
    { label: '3-5s', max: 5000 },
    { label: '5-8s', max: 8000 },
    { label: '8-12s', max: 12000 },
    { label: '12-20s', max: 20000 },
    { label: '> 20s', max: Infinity },
  ];
  let prevMax = 0;
  for (const b of buckets) {
    const count = results.filter(r => r.latencyMs >= prevMax && r.latencyMs < b.max).length;
    if (count > 0) {
      const ids = results.filter(r => r.latencyMs >= prevMax && r.latencyMs < b.max).map(r => r.id);
      console.log(`    ${b.label.padEnd(8)} ${count} tests: ${ids.join(', ')}`);
    }
    prevMax = b.max;
  }

  // Routing accuracy
  console.log('\n  ROUTING:');
  const fastPathCount = results.filter(r => r.fastPath).length;
  const llmRouteCount = results.filter(r => !r.fastPath).length;
  console.log(`    Fast-path: ${fastPathCount}/${results.length} (${((fastPathCount / results.length) * 100).toFixed(0)}%)`);
  console.log(`    LLM router: ${llmRouteCount}/${results.length}`);
  if (llmRouteCount > 0) {
    const llmRouted = results.filter(r => !r.fastPath);
    console.log(`    LLM-routed queries:`);
    for (const r of llmRouted) {
      console.log(`      [${r.id}] "${r.message}" → ${r.routedTo} (${r.routeMs}ms)`);
    }
  }

  // RAG waste
  console.log('\n  RAG:');
  const ragRan = results.filter(r => !r.ragSkipped);
  const ragSkipped = results.filter(r => r.ragSkipped);
  console.log(`    Skipped: ${ragSkipped.length}/${results.length}`);
  if (ragRan.length > 0) {
    console.log(`    Ran RAG:`);
    for (const r of ragRan) {
      console.log(`      [${r.id}] "${r.message}" → ${r.ragMs}ms, ${r.ragBlocks} blocks`);
    }
  }

  // Context path
  console.log('\n  CONTEXT PATH:');
  const lightCount = results.filter(r => r.contextPath === 'light').length;
  const fullCount = results.filter(r => r.contextPath === 'full').length;
  console.log(`    Light: ${lightCount} | Full: ${fullCount}`);

  // Worst latency offenders
  const sorted = [...results].sort((a, b) => b.latencyMs - a.latencyMs);
  console.log('\n  WORST LATENCY (top 5):');
  for (const r of sorted.slice(0, 5)) {
    console.log(`    [${r.id}] ${r.latencyMs}ms — route=${r.routeMs}ms ctx=${r.contextMs}ms loop=${r.agentLoopMs}ms | "${r.message}"`);
  }

  console.log(`\n${'═'.repeat(70)}\n`);
  Deno.exit(totalFail > 0 ? 1 : 0);
}

main();
