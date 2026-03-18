/**
 * Latency stress test — rapid switching between agentic tasks,
 * knowledge, casual, and semantic recall.
 *
 * Measures per-turn latency and flags any turn where a fast-path
 * message (casual/knowledge) gets routed to smart unnecessarily.
 *
 * Run:
 *   deno run --allow-all --env=.env --node-modules-dir=auto supabase/functions/_shared/tests/test-latency-stress.ts
 */

import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const TIMEZONE = 'Australia/Sydney';

let nestUser;
try {
  nestUser = await ensureNestUser(SENDER, BOT);
} catch (err) {
  console.log('FATAL: ensureNestUser threw:', (err as Error).message);
  Deno.exit(1);
}
if (!nestUser.authUserId) { console.log('FATAL: No authUserId, nestUser:', JSON.stringify(nestUser)); Deno.exit(1); }
console.log(`authUserId: ${nestUser.authUserId}\n`);

async function sendMessage(chatId: string, message: string) {
  return handleTurn({
    chatId, userMessage: message, images: [], audio: [],
    senderHandle: SENDER, isGroupChat: false, participantNames: [],
    chatName: null, authUserId: nestUser.authUserId!, isOnboarding: false, timezone: TIMEZONE,
  });
}

interface Turn {
  message: string;
  tag: string;                          // short label for the results table
  expectAgent?: 'chat' | 'smart';      // null = don't assert
  expectLane?: string;
  warnIfSlowerThan?: number;            // ms — yellow flag if exceeded
}

interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
}

const CONVERSATIONS: Conversation[] = [

  // ── 1. Rapid agent ↔ chat ping-pong ───────────────────────
  {
    id: 'latency-pingpong',
    title: '1. Agent ↔ Chat Ping-Pong (rapid switching)',
    turns: [
      { message: 'Hey', tag: 'casual:hey', expectAgent: 'chat', expectLane: '0B-casual', warnIfSlowerThan: 3000 },
      { message: 'Check my emails', tag: 'agentic:email_read', expectAgent: 'smart' },
      { message: 'Thanks', tag: 'casual:thanks', expectAgent: 'chat', warnIfSlowerThan: 4000 },
      { message: 'What is the capital of Thailand', tag: 'knowledge:capital', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
      { message: "What's on my calendar today", tag: 'agentic:cal_read', expectAgent: 'smart' },
      { message: 'Ok cool', tag: 'casual:ok_cool', expectAgent: 'chat', warnIfSlowerThan: 4000 },
      { message: 'Explain how solar panels work', tag: 'knowledge:solar', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
      { message: 'Search the web for Melbourne weather this week', tag: 'agentic:web_search', expectAgent: 'smart' },
      { message: 'Nice', tag: 'casual:nice', expectAgent: 'chat', warnIfSlowerThan: 3000 },
    ],
  },

  // ── 2. Knowledge burst — should all stay on fast path ─────
  {
    id: 'latency-knowledge-burst',
    title: '2. Knowledge Burst (all should be fast-path chat)',
    turns: [
      { message: 'What is quantum computing', tag: 'knowledge:quantum', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
      { message: 'How is it different from classical computing', tag: 'knowledge:classical', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'What companies are leading in this space', tag: 'knowledge:companies', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Interesting', tag: 'casual:interesting', expectAgent: 'chat', expectLane: '0B-casual', warnIfSlowerThan: 3000 },
      { message: 'Write me a haiku about computers', tag: 'knowledge:haiku', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
      { message: 'Haha', tag: 'casual:haha', expectAgent: 'chat', expectLane: '0B-casual', warnIfSlowerThan: 3000 },
    ],
  },

  // ── 3. Agentic workflow then abrupt topic change ──────────
  {
    id: 'latency-agentic-then-switch',
    title: '3. Agentic Workflow → Abrupt Knowledge Switch',
    turns: [
      { message: 'Draft an email to tom@lidgett.net saying hey, latency test run', tag: 'agentic:email_draft', expectAgent: 'smart' },
      { message: 'Actually never mind, tell me about the history of jazz', tag: 'knowledge:jazz', expectAgent: 'chat', warnIfSlowerThan: 6000 },
      { message: 'Who are the most influential jazz musicians', tag: 'knowledge:jazz2', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Cool', tag: 'casual:cool', expectAgent: 'chat', warnIfSlowerThan: 3000 },
    ],
  },

  // ── 4. Semantic/recall mixed with general knowledge ───────
  {
    id: 'latency-recall-mixed',
    title: '4. Personal Recall ↔ General Knowledge',
    turns: [
      { message: 'What do you remember about me', tag: 'recall:about_me', expectAgent: 'smart' },
      { message: 'What is the Pythagorean theorem', tag: 'knowledge:pythagoras', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
      { message: 'Do I have any meetings tomorrow', tag: 'agentic:cal_tomorrow', expectAgent: 'smart' },
      { message: 'Thanks for checking', tag: 'casual:thanks', expectAgent: 'chat', warnIfSlowerThan: 4000 },
      { message: 'How do airplanes fly', tag: 'knowledge:airplanes', expectAgent: 'chat', expectLane: '0B-knowledge', warnIfSlowerThan: 4000 },
    ],
  },

  // ── 5. Web search chain then casual wind-down ─────────────
  {
    id: 'latency-search-winddown',
    title: '5. Web Search Chain → Casual Wind-Down',
    turns: [
      { message: 'Search the web for F1 2026 season schedule', tag: 'agentic:web_f1', expectAgent: 'smart' },
      { message: 'When is the Australian GP', tag: 'followup:aus_gp' },
      { message: 'Awesome', tag: 'casual:awesome', expectAgent: 'chat', warnIfSlowerThan: 4000 },
      { message: 'What are the rules of F1', tag: 'knowledge:f1_rules', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Explain DRS simply', tag: 'knowledge:drs', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Got it', tag: 'casual:got_it', expectAgent: 'chat', warnIfSlowerThan: 3000 },
    ],
  },

  // ── 6. Calendar + email + casual rapid fire ───────────────
  {
    id: 'latency-rapid-agentic',
    title: '6. Rapid Agentic → Casual → Agentic',
    turns: [
      { message: 'Any unread emails', tag: 'agentic:unread', expectAgent: 'smart' },
      { message: 'Ok', tag: 'casual:ok', expectAgent: 'chat', warnIfSlowerThan: 3000 },
      { message: "What's on my calendar this week", tag: 'agentic:cal_week', expectAgent: 'smart' },
      { message: 'Sounds like a busy week', tag: 'casual:busy_week', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Help me brainstorm 5 team building ideas', tag: 'knowledge:brainstorm', expectAgent: 'chat', warnIfSlowerThan: 5000 },
      { message: 'Love it', tag: 'casual:love_it', expectAgent: 'chat', warnIfSlowerThan: 3000 },
    ],
  },

  // ── 7. Short ambiguous messages after tools (the danger zone) ─
  {
    id: 'latency-ambiguous-shorts',
    title: '7. Short Ambiguous Messages After Tools',
    turns: [
      { message: 'Search the web for best cafes in Melbourne', tag: 'agentic:web_cafes', expectAgent: 'smart' },
      { message: 'Hmm', tag: 'casual:hmm', expectAgent: 'chat', warnIfSlowerThan: 4000 },
      { message: 'What about Fitzroy', tag: 'followup:fitzroy' },
      { message: 'Fair enough', tag: 'casual:fair_enough', expectAgent: 'chat', warnIfSlowerThan: 3000 },
      { message: 'Any emails from Google', tag: 'agentic:email_google', expectAgent: 'smart' },
      { message: 'Nah all good', tag: 'casual:nah', expectAgent: 'chat', warnIfSlowerThan: 4000 },
    ],
  },

  // ── 8. Long knowledge question after agentic (no lookback) ─
  {
    id: 'latency-long-after-tools',
    title: '8. Long Knowledge Questions After Tool Use',
    turns: [
      { message: 'Check my emails from the last 24 hours', tag: 'agentic:email_24h', expectAgent: 'smart' },
      { message: 'Can you explain the difference between REST APIs and GraphQL and when you should use each one', tag: 'knowledge:rest_graphql', expectAgent: 'chat', warnIfSlowerThan: 6000 },
      { message: 'Search the web for latest OpenAI announcements', tag: 'agentic:web_openai', expectAgent: 'smart' },
      { message: 'Tell me about the history of artificial intelligence from the 1950s to today', tag: 'knowledge:ai_history', expectAgent: 'chat', warnIfSlowerThan: 6000 },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

interface TurnResult {
  convId: string;
  tag: string;
  message: string;
  agent: string;
  lane: string;
  routeReason: string;
  routeMs: number;
  contextMs: number;
  loopMs: number;
  totalMs: number;
  tools: string[];
  passed: boolean;
  warnings: string[];
  failures: string[];
}

const allResults: TurnResult[] = [];
let passCount = 0;
let failCount = 0;
let warnCount = 0;

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  Latency Stress Test — Agentic ↔ Knowledge ↔ Casual            ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

for (const conv of CONVERSATIONS) {
  const chatId = `test-latency-${conv.id}-${Date.now()}`;
  console.log(`\n━━━ ${conv.title} ━━━`);

  try { await clearConversation(chatId); } catch { /* new */ }

  for (const turn of conv.turns) {
    const t0 = Date.now();
    let result: Awaited<ReturnType<typeof sendMessage>>;
    try {
      result = await sendMessage(chatId, turn.message);
    } catch (err) {
      failCount++;
      const tr: TurnResult = {
        convId: conv.id, tag: turn.tag, message: turn.message,
        agent: 'CRASH', lane: '-', routeReason: '-',
        routeMs: 0, contextMs: 0, loopMs: 0, totalMs: Date.now() - t0,
        tools: [], passed: false, warnings: [], failures: [`CRASH: ${(err as Error).message}`],
      };
      allResults.push(tr);
      console.log(`  ❌ [${turn.tag}] CRASH: ${(err as Error).message}`);
      continue;
    }
    const totalMs = Date.now() - t0;

    const trace = result.trace;
    const agent = trace.agentName ?? '?';
    const lane = trace.routeLayer ?? '?';
    const routeReason = trace.routeReason ?? '?';
    const routeMs = trace.routerLatencyMs ?? 0;
    const contextMs = trace.contextLatencyMs ?? 0;
    const loopMs = trace.agentLoopLatencyMs ?? 0;
    const tools = (trace.toolCalls ?? []).map((t: { name: string }) => t.name);

    const warnings: string[] = [];
    const failures: string[] = [];

    if (turn.expectAgent && agent !== turn.expectAgent) {
      failures.push(`agent: want ${turn.expectAgent}, got ${agent}`);
    }
    if (turn.expectLane && lane !== turn.expectLane) {
      failures.push(`lane: want ${turn.expectLane}, got ${lane}`);
    }
    if (turn.warnIfSlowerThan && totalMs > turn.warnIfSlowerThan) {
      warnings.push(`SLOW: ${totalMs}ms > ${turn.warnIfSlowerThan}ms threshold`);
    }
    // Flag any chat-expected turn that hit the classifier (added latency)
    if (turn.expectAgent === 'chat' && lane === '0C') {
      warnings.push(`hit classifier (${routeMs}ms) — could have been deterministic`);
    }

    const passed = failures.length === 0;
    if (passed) passCount++; else failCount++;
    if (warnings.length > 0) warnCount++;

    const tr: TurnResult = {
      convId: conv.id, tag: turn.tag, message: turn.message,
      agent, lane, routeReason, routeMs, contextMs, loopMs, totalMs,
      tools, passed, warnings, failures,
    };
    allResults.push(tr);

    const icon = !passed ? '❌' : warnings.length > 0 ? '⚠️ ' : '✅';
    const toolStr = tools.length > 0 ? ` tools=[${tools.join(',')}]` : '';
    console.log(`  ${icon} [${turn.tag}] ${agent} | ${lane} | route=${routeMs}ms ctx=${contextMs}ms loop=${loopMs}ms | total=${totalMs}ms${toolStr}`);
    if (failures.length > 0) console.log(`     FAIL: ${failures.join('; ')}`);
    if (warnings.length > 0) console.log(`     WARN: ${warnings.join('; ')}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary Table
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(120)}`);
console.log('LATENCY SUMMARY TABLE');
console.log(`${'═'.repeat(120)}`);
console.log(
  'Tag'.padEnd(28) +
  'Agent'.padEnd(8) +
  'Lane'.padEnd(16) +
  'Route'.padEnd(9) +
  'Ctx'.padEnd(9) +
  'Loop'.padEnd(10) +
  'TOTAL'.padEnd(10) +
  'Tools'.padEnd(20) +
  'Status'
);
console.log('-'.repeat(120));

for (const r of allResults) {
  const status = !r.passed ? '❌ FAIL' : r.warnings.length > 0 ? '⚠️  WARN' : '✅ OK';
  console.log(
    r.tag.padEnd(28) +
    r.agent.padEnd(8) +
    r.lane.padEnd(16) +
    `${r.routeMs}ms`.padEnd(9) +
    `${r.contextMs}ms`.padEnd(9) +
    `${r.loopMs}ms`.padEnd(10) +
    `${r.totalMs}ms`.padEnd(10) +
    (r.tools.length > 0 ? r.tools.join(',') : '-').substring(0, 19).padEnd(20) +
    status
  );
}

// ── Latency Stats ──
const chatTurns = allResults.filter(r => r.agent === 'chat');
const smartTurns = allResults.filter(r => r.agent === 'smart');
const deterministicTurns = allResults.filter(r => r.lane.startsWith('0B'));
const classifierTurns = allResults.filter(r => r.lane === '0C');
const pendingTurns = allResults.filter(r => r.lane === '0A');

function stats(turns: TurnResult[]): string {
  if (turns.length === 0) return 'n/a';
  const totals = turns.map(t => t.totalMs).sort((a, b) => a - b);
  const avg = Math.round(totals.reduce((s, v) => s + v, 0) / totals.length);
  const p50 = totals[Math.floor(totals.length * 0.5)];
  const p90 = totals[Math.floor(totals.length * 0.9)];
  const min = totals[0];
  const max = totals[totals.length - 1];
  return `avg=${avg}ms p50=${p50}ms p90=${p90}ms min=${min}ms max=${max}ms`;
}

console.log(`\n${'═'.repeat(80)}`);
console.log('LATENCY STATISTICS');
console.log(`${'═'.repeat(80)}`);
console.log(`  Chat agent  (${chatTurns.length} turns):  ${stats(chatTurns)}`);
console.log(`  Smart agent (${smartTurns.length} turns):  ${stats(smartTurns)}`);
console.log(`  ──────────────────────────────────────────────`);
console.log(`  Deterministic 0B (${deterministicTurns.length} turns): ${stats(deterministicTurns)}`);
console.log(`  Classifier 0C   (${classifierTurns.length} turns): ${stats(classifierTurns)}`);
console.log(`  Pending 0A      (${pendingTurns.length} turns): ${stats(pendingTurns)}`);

// Chat turns that hit classifier vs deterministic
const chatClassifier = chatTurns.filter(r => r.lane === '0C');
const chatDeterministic = chatTurns.filter(r => r.lane.startsWith('0B'));
console.log(`\n  Chat routing breakdown:`);
console.log(`    Deterministic (fast): ${chatDeterministic.length}/${chatTurns.length} — ${stats(chatDeterministic)}`);
console.log(`    Classifier (slow):    ${chatClassifier.length}/${chatTurns.length} — ${stats(chatClassifier)}`);

// ── Router overhead for classifier vs deterministic ──
const routeLatDet = deterministicTurns.map(r => r.routeMs);
const routeLatCls = classifierTurns.map(r => r.routeMs);
if (routeLatDet.length > 0) {
  const avgDet = Math.round(routeLatDet.reduce((s, v) => s + v, 0) / routeLatDet.length);
  console.log(`\n  Router overhead — deterministic: avg ${avgDet}ms`);
}
if (routeLatCls.length > 0) {
  const avgCls = Math.round(routeLatCls.reduce((s, v) => s + v, 0) / routeLatCls.length);
  console.log(`  Router overhead — classifier:    avg ${avgCls}ms`);
}

console.log(`\n${'═'.repeat(80)}`);
console.log(`Results: ${passCount} passed, ${failCount} failed, ${warnCount} warnings`);
console.log(`Total turns: ${allResults.length} across ${CONVERSATIONS.length} conversations`);

if (failCount > 0) {
  console.log('\n🔴 Failures:');
  for (const r of allResults.filter(r => !r.passed)) {
    console.log(`  • [${r.tag}] "${r.message}" — ${r.failures.join('; ')}`);
  }
}
if (warnCount > 0) {
  console.log('\n🟡 Warnings:');
  for (const r of allResults.filter(r => r.warnings.length > 0)) {
    console.log(`  • [${r.tag}] ${r.totalMs}ms — ${r.warnings.join('; ')}`);
  }
}
