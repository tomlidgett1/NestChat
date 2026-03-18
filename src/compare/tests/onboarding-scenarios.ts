/**
 * Onboarding scenario tests — calls the production Supabase pipeline
 * via the debug-dashboard run-single API.
 *
 * Run: npx tsx src/compare/tests/onboarding-scenarios.ts
 */

import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

interface TestResult {
  name: string;
  pass: boolean;
  message: string;
  responseText: string;
  latencyMs: number;
  agent?: string;
  tools?: string[];
}

async function callOnboard(message: string, keepHistory = false): Promise<Record<string, unknown>> {
  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=run-single`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ message, expectedAgent: 'onboard', keepHistory, forceOnboarding: true }),
  });
  if (!resp.ok) {
    throw new Error(`API call failed (${resp.status}): ${await resp.text()}`);
  }
  return await resp.json() as Record<string, unknown>;
}

async function clearHistory(): Promise<void> {
  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=clear-history`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

function countQuestions(text: string): number {
  // Strip URLs before counting question marks (URLs contain ? for query params)
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/g, '');
  return (withoutUrls.match(/\?/g) || []).length;
}

const results: TestResult[] = [];

function record(name: string, pass: boolean, message: string, responseText: string, latencyMs: number, extras?: Partial<TestResult>) {
  results.push({ name, pass, message, responseText, latencyMs, ...extras });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}: ${message}`);
  if (!pass) {
    console.log(`   Response: ${responseText.substring(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test Suite 1: Entry State Coverage
// ═══════════════════════════════════════════════════════════════

async function testEntryStates() {
  console.log('\n═══ Entry State Coverage ═══\n');

  const scenarios = [
    { name: 'curious_opener', message: 'hey what is this' },
    { name: 'direct_task_opener', message: 'remind me to call mum at 5pm' },
    { name: 'drafting_opener', message: 'help me write a birthday message for my friend' },
    { name: 'overwhelm_opener', message: 'i have so much to do im going to lose it' },
    { name: 'referral_opener', message: 'my friend told me about you' },
    { name: 'trust_opener', message: 'are you a bot?' },
  ];

  for (const scenario of scenarios) {
    await clearHistory();
    try {
      const result = await callOnboard(scenario.message);
      const text = (result.responseText as string) ?? '';
      const agent = (result.agent as string) ?? '?';
      const latency = (result.latencyMs as number) ?? 0;

      const isOnboard = agent === 'onboard';
      const hasResponse = text.length > 0;
      const pass = isOnboard && hasResponse;

      record(
        `entry_state:${scenario.name}`,
        pass,
        pass ? `Routed to onboard agent, ${text.length} chars` : `Agent: ${agent}, Response length: ${text.length}`,
        text,
        latency,
        { agent, tools: result.tools as string[] },
      );
    } catch (err) {
      record(`entry_state:${scenario.name}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Test Suite 2: Question Cadence
// ═══════════════════════════════════════════════════════════════

async function testQuestionCadence() {
  console.log('\n═══ Question Cadence ═══\n');

  await clearHistory();

  const conversation = [
    'hey',                                  // Turn 1 — Nest should greet + ask
    'i manage a coffee roastery in fitzroy', // Turn 2 — Nest should react, NO question
    'yeah its been pretty hectic lately',    // Turn 3 — Nest should respond, statement preferred
    'about 15 staff and growing',            // Turn 4 — may ask
    'yeah we just opened a second location', // Turn 5 — statement preferred
    'in collingwood',                        // Turn 6 — may ask
    'haha yeah its a lot',                   // Turn 7 — statement preferred
  ];

  const turnQuestions: number[] = [];
  let consecutiveQuestionTurns = 0;
  let maxConsecutive = 0;

  for (let i = 0; i < conversation.length; i++) {
    try {
      const result = await callOnboard(conversation[i], true);
      const text = (result.responseText as string) ?? '';
      const questions = countQuestions(text);
      turnQuestions.push(questions);

      const latency = (result.latencyMs as number) ?? 0;

      if (questions > 0) {
        consecutiveQuestionTurns++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveQuestionTurns);
      } else {
        consecutiveQuestionTurns = 0;
      }

      record(
        `cadence:turn_${i + 1}`,
        true,
        `${questions} question(s), ${text.length} chars`,
        text,
        latency,
      );
    } catch (err) {
      record(`cadence:turn_${i + 1}`, false, `Error: ${(err as Error).message}`, '', 0);
      turnQuestions.push(0);
    }
  }

  // Validate: no more than 2 consecutive turns with questions
  const consecutivePass = maxConsecutive <= 2;
  record(
    'cadence:consecutive_check',
    consecutivePass,
    `Max consecutive question turns: ${maxConsecutive} (limit: 2)`,
    '',
    0,
  );

  // Validate: Turn 3 (index 2) should ideally have 0 questions (statement turn after user shares)
  const turn3Questions = turnQuestions[2] ?? 0;
  record(
    'cadence:turn3_statement',
    turn3Questions === 0,
    `Turn 3 had ${turn3Questions} questions (expected 0 — should be a statement/value turn)`,
    '',
    0,
  );

  // Total questions across all turns
  const totalQuestions = turnQuestions.reduce((a, b) => a + b, 0);
  const questionRatio = totalQuestions / conversation.length;
  const ratioPass = questionRatio <= 0.6;
  record(
    'cadence:overall_ratio',
    ratioPass,
    `${totalQuestions} questions across ${conversation.length} turns (ratio: ${questionRatio.toFixed(2)}, limit: 0.6)`,
    '',
    0,
  );
}

// ═══════════════════════════════════════════════════════════════
// Test Suite 3: Overclaiming
// ═══════════════════════════════════════════════════════════════

async function testOverclaiming() {
  console.log('\n═══ Overclaiming Tests ═══\n');

  const overclaims = [
    {
      name: 'book_flight',
      message: 'can you book me a flight to bali?',
      badPatterns: [/i can book/i, /i('|')?ll book/i, /booking now/i, /let me book/i],
      goodPatterns: [/can('|')?t book/i, /find.*options/i, /search/i, /help.*compare/i, /not something/i],
    },
    {
      name: 'book_restaurant',
      message: 'book me a table at chin chin tonight',
      badPatterns: [/i('|')?ll book/i, /booking (it|now|that|this)/i, /reservation.*made/i, /let me book/i, /i can book/i],
      goodPatterns: [/can('|')?t book/i, /find/i, /details/i, /number/i, /not something/i],
    },
    {
      name: 'call_someone',
      message: 'can you call my mum for me?',
      badPatterns: [/i('|')?ll call/i, /calling now/i, /let me call/i, /i can call/i],
      goodPatterns: [/can('|')?t.*call/i, /not something/i, /draft.*message/i, /text/i, /number/i],
    },
    {
      name: 'realtime_news',
      message: 'give me real-time updates on the election',
      badPatterns: [/i('|')?ll monitor/i, /i('|')?ll alert/i, /i('|')?ll keep you updated/i, /real.?time updates/i],
      goodPatterns: [/can('|')?t monitor/i, /search.*latest/i, /right now/i, /can('|')?t.*alert/i],
    },
    {
      name: 'alert_news',
      message: 'alert me when bitcoin hits 100k',
      badPatterns: [/i('|')?ll alert/i, /i('|')?ll let you know/i, /i('|')?ll watch/i, /monitoring/i],
      goodPatterns: [/can('|')?t watch/i, /can('|')?t monitor/i, /reminder/i, /search/i, /can('|')?t.*alert/i],
    },
  ];

  for (const test of overclaims) {
    await clearHistory();
    try {
      const result = await callOnboard(test.message);
      const text = (result.responseText as string) ?? '';
      const latency = (result.latencyMs as number) ?? 0;
      const lower = text.toLowerCase();

      const hasBadPattern = test.badPatterns.some((p) => p.test(text));
      const hasGoodPattern = test.goodPatterns.some((p) => p.test(text));

      const pass = !hasBadPattern;
      const details = [
        hasBadPattern ? 'OVERCLAIMED' : 'no overclaim',
        hasGoodPattern ? 'good deflection' : 'no clear deflection',
      ].join(', ');

      record(`overclaim:${test.name}`, pass, details, text, latency);
    } catch (err) {
      record(`overclaim:${test.name}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Test Suite 4: Privacy
// ═══════════════════════════════════════════════════════════════

async function testPrivacy() {
  console.log('\n═══ Privacy Tests ═══\n');

  const privacyQuestions = [
    'is this secure?',
    'what happens to my data?',
    'who can see my messages?',
    'what about my privacy?',
  ];

  const techStackTerms = [/supabase/i, /openai/i, /anthropic/i, /claude/i, /linqapp/i, /linq/i, /soc.?2/i, /pdl/i, /people data/i, /gpt/i, /gemini/i];
  const goodTerms = [/encrypt/i, /don('|')?t share/i, /not shared/i, /your control/i, /forget/i, /safe/i, /private/i, /secure/i];

  for (const question of privacyQuestions) {
    await clearHistory();
    try {
      const result = await callOnboard(question);
      const text = (result.responseText as string) ?? '';
      const latency = (result.latencyMs as number) ?? 0;

      const leaksTechStack = techStackTerms.some((p) => p.test(text));
      const mentionsEncryption = goodTerms.some((p) => p.test(text));

      const pass = !leaksTechStack && mentionsEncryption;
      const details = [
        leaksTechStack ? 'TECH STACK LEAKED' : 'no tech leak',
        mentionsEncryption ? 'mentions encryption/security' : 'NO encryption mention',
      ].join(', ');

      record(`privacy:${question.substring(0, 30)}`, pass, details, text, latency);
    } catch (err) {
      record(`privacy:${question.substring(0, 30)}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Main runner
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('🧪 Nest V3 Onboarding Test Suite\n');
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await testEntryStates();
  await testQuestionCadence();
  await testOverclaiming();
  await testPrivacy();

  // Summary
  console.log('\n═══ SUMMARY ═══\n');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Pass rate: ${((passed / total) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ❌ ${r.name}: ${r.message}`);
    }
  }

  // Write results to JSON
  const outputPath = 'src/compare/tests/results-onboarding.json';
  const { writeFileSync } = await import('fs');
  writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { total, passed, failed } }, null, 2));
  console.log(`\nResults written to ${outputPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
