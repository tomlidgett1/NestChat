/**
 * Classifier accuracy evaluation for Option A routing.
 * Tests classifyTurn() against 80+ message/expected-result pairs.
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/classifier-eval.ts
 */

import { classifyTurn } from '../orchestrator/classify-turn.ts';
import { emptyWorkingMemory } from '../orchestrator/types.ts';
import type { TurnInput, DomainTag, Capability, ClassifierResult } from '../orchestrator/types.ts';
import type { RouterContext } from '../orchestrator/build-context.ts';

interface EvalCase {
  id: string;
  category: string;
  message: string;
  expectedMode: 'chat' | 'smart';
  expectedDomain?: DomainTag;
  expectedCapabilities?: Capability[];
  expectedMemoryDepth?: 'none' | 'light' | 'full';
  expectedRequiresToolUse?: boolean;
  context?: Partial<RouterContext>;
}

const EVAL_CASES: EvalCase[] = [
  // ─── SINGLE-DOMAIN: EMAIL ──────────────────────────────────
  { id: 'email-1', category: 'single-domain', message: 'Check my latest emails', expectedMode: 'smart', expectedDomain: 'email', expectedCapabilities: ['email.read'], expectedRequiresToolUse: true },
  { id: 'email-2', category: 'single-domain', message: 'Draft an email to tom@example.com about the meeting', expectedMode: 'smart', expectedDomain: 'email', expectedCapabilities: ['email.write'] },
  { id: 'email-3', category: 'single-domain', message: 'Do I have any unread emails?', expectedMode: 'smart', expectedDomain: 'email', expectedCapabilities: ['email.read'], expectedRequiresToolUse: true },
  { id: 'email-4', category: 'single-domain', message: 'Search my emails for anything from Sarah about the project', expectedMode: 'smart', expectedDomain: 'email', expectedCapabilities: ['email.read'] },

  // ─── SINGLE-DOMAIN: CALENDAR ───────────────────────────────
  { id: 'cal-1', category: 'single-domain', message: "What's on my calendar today?", expectedMode: 'smart', expectedDomain: 'calendar', expectedCapabilities: ['calendar.read'], expectedRequiresToolUse: true },
  { id: 'cal-2', category: 'single-domain', message: 'Schedule a meeting with Tom tomorrow at 2pm', expectedMode: 'smart', expectedDomain: 'calendar', expectedCapabilities: ['calendar.write'] },
  { id: 'cal-3', category: 'single-domain', message: 'When am I free this week?', expectedMode: 'smart', expectedDomain: 'calendar', expectedCapabilities: ['calendar.read'], expectedRequiresToolUse: true },
  { id: 'cal-4', category: 'single-domain', message: 'Cancel my 3pm meeting', expectedMode: 'smart', expectedDomain: 'calendar', expectedCapabilities: ['calendar.write'] },

  // ─── SINGLE-DOMAIN: RESEARCH ───────────────────────────────
  { id: 'research-1', category: 'single-domain', message: 'Who is the current president of France?', expectedMode: 'smart', expectedDomain: 'research', expectedCapabilities: ['web.search'] },
  { id: 'research-2', category: 'single-domain', message: "What's the latest news about AI regulation?", expectedMode: 'smart', expectedDomain: 'research', expectedCapabilities: ['web.search'] },
  { id: 'research-3', category: 'single-domain', message: 'Compare Toyota HiLux vs Mazda BT-50 for towing', expectedMode: 'smart', expectedDomain: 'research', expectedCapabilities: ['web.search'] },
  { id: 'research-4', category: 'single-domain', message: "What's the weather in Melbourne?", expectedMode: 'smart', expectedDomain: 'research', expectedCapabilities: ['web.search'] },

  // ─── SINGLE-DOMAIN: RECALL ─────────────────────────────────
  { id: 'recall-1', category: 'single-domain', message: 'What do you know about me?', expectedMode: 'smart', expectedDomain: 'recall', expectedMemoryDepth: 'full' },
  { id: 'recall-2', category: 'single-domain', message: 'What are my food preferences?', expectedMode: 'smart', expectedDomain: 'recall', expectedMemoryDepth: 'light' },
  { id: 'recall-3', category: 'single-domain', message: 'Do you remember what I told you about my trip?', expectedMode: 'smart', expectedDomain: 'recall' },

  // ─── SINGLE-DOMAIN: MEETING PREP ──────────────────────────
  { id: 'meetprep-1', category: 'single-domain', message: 'Prep me for my next meeting', expectedMode: 'smart', expectedDomain: 'meeting_prep', expectedCapabilities: ['calendar.read'] },
  { id: 'meetprep-2', category: 'single-domain', message: 'What did Daniel and I discuss in our 1:1 today?', expectedMode: 'smart', expectedDomain: 'meeting_prep', expectedCapabilities: ['granola.read'] },
  { id: 'meetprep-3', category: 'single-domain', message: 'Brief me for the Q1 review at 2pm', expectedMode: 'smart', expectedDomain: 'meeting_prep' },

  // ─── SINGLE-DOMAIN: CONTACTS ───────────────────────────────
  { id: 'contacts-1', category: 'single-domain', message: 'Who is Daniel Barth?', expectedMode: 'smart', expectedDomain: 'contacts', expectedCapabilities: ['contacts.read'], expectedRequiresToolUse: true },
  { id: 'contacts-2', category: 'single-domain', message: "What's Sarah's email address?", expectedMode: 'smart', expectedDomain: 'contacts', expectedCapabilities: ['contacts.read'] },

  // ─── COMPOUND / MULTI-STEP ─────────────────────────────────
  { id: 'compound-1', category: 'compound', message: "Find Dan's email and book 30 mins next week", expectedMode: 'smart', expectedCapabilities: ['contacts.read', 'calendar.write'] },
  { id: 'compound-2', category: 'compound', message: 'Summarise my emails and send the summary to Tom', expectedMode: 'smart', expectedCapabilities: ['email.read'] },
  { id: 'compound-3', category: 'compound', message: 'Check my calendar for today and draft a summary email to tom@example.com', expectedMode: 'smart', expectedCapabilities: ['calendar.read'] },
  { id: 'compound-4', category: 'compound', message: 'What did Ryan say in our call? Draft a reply to him', expectedMode: 'smart', expectedCapabilities: ['granola.read'] },
  { id: 'compound-5', category: 'compound', message: 'Check my calendar for tomorrow, find any emails related to those meetings, and draft a prep summary', expectedMode: 'smart' },
  { id: 'compound-6', category: 'compound', message: 'Search my emails for anything from Blacklane, summarise it, and send to Tom', expectedMode: 'smart', expectedCapabilities: ['email.read'] },
  { id: 'compound-7', category: 'compound', message: 'Prep me for all my meetings today and email the briefs to tom@example.com', expectedMode: 'smart' },
  { id: 'compound-8', category: 'compound', message: "What's on my calendar today and do I have any unread emails?", expectedMode: 'smart', expectedCapabilities: ['calendar.read', 'email.read'] },
  { id: 'compound-9', category: 'compound', message: 'Find out who emailed me about the project, then schedule a call with them', expectedMode: 'smart', expectedCapabilities: ['email.read'] },
  { id: 'compound-10', category: 'compound', message: 'Look up the latest on AI regulation and draft an email to the team about it', expectedMode: 'smart', expectedCapabilities: ['web.search'] },
  { id: 'compound-11', category: 'compound', message: 'Check what was discussed in my standup, then email action items to the team', expectedMode: 'smart', expectedCapabilities: ['granola.read'] },
  { id: 'compound-12', category: 'compound', message: 'Who emailed me today? Summarise and send to Tom', expectedMode: 'smart', expectedCapabilities: ['email.read'] },
  { id: 'compound-13', category: 'compound', message: "What's Tom's email? Draft him a note about Friday", expectedMode: 'smart', expectedCapabilities: ['contacts.read'] },
  { id: 'compound-14', category: 'compound', message: 'Reschedule my 3pm to 4pm and email the attendees about the change', expectedMode: 'smart', expectedCapabilities: ['calendar.write'] },
  { id: 'compound-15', category: 'compound', message: 'What did we discuss last week? Send a recap to Sarah', expectedMode: 'smart' },

  // ─── FOLLOW-UP / CONTINUATION ──────────────────────────────
  { id: 'followup-1', category: 'followup', message: 'And what about the 7pm meeting?', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Your 3pm is a standup with Tom [calendar_read]' }] } },
  { id: 'followup-2', category: 'followup', message: 'Pull up the full email', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Found 3 emails from Sarah [email_read]' }] } },
  { id: 'followup-3', category: 'followup', message: 'Yeah send it', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Here is the draft [email_draft]' }] } },
  { id: 'followup-4', category: 'followup', message: 'What else did they say?', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'In the standup, Tom mentioned the deadline [granola_read]' }] } },
  { id: 'followup-5', category: 'followup', message: 'And the standup?', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Your 1:1 with Daniel covered the roadmap [granola_read]' }] } },
  { id: 'followup-6', category: 'followup', message: 'Cool, anything else on today?', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'You have a 2pm with Sarah [calendar_read]' }] } },
  { id: 'followup-7', category: 'followup', message: 'Draft a reply', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Sarah emailed about the timeline [email_read]' }] } },
  { id: 'followup-8', category: 'followup', message: 'More detail on that last one', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Found 5 results [web_search]' }] } },
  { id: 'followup-9', category: 'followup', message: 'haha yeah true, can you check my calendar though?', expectedMode: 'smart', expectedCapabilities: ['calendar.read'] },
  { id: 'followup-10', category: 'followup', message: 'Nice one. Now what about tomorrow?', expectedMode: 'smart', context: { recentTurns: [{ role: 'assistant', content: 'Today you have 3 meetings [calendar_read]' }] } },

  // ─── AMBIGUOUS ─────────────────────────────────────────────
  { id: 'ambiguous-1', category: 'ambiguous', message: 'Tell me about that thing with Dubai', expectedMode: 'smart', expectedDomain: 'research' },
  { id: 'ambiguous-2', category: 'ambiguous', message: 'Do you remember that thing I told you about?', expectedMode: 'smart', expectedDomain: 'recall' },
  { id: 'ambiguous-3', category: 'ambiguous', message: 'Can you help me with something?', expectedMode: 'chat' },
  { id: 'ambiguous-4', category: 'ambiguous', message: 'What should I do about this?', expectedMode: 'chat' },
  { id: 'ambiguous-5', category: 'ambiguous', message: 'Hmm not sure about that', expectedMode: 'chat' },
  { id: 'ambiguous-6', category: 'ambiguous', message: 'Is this a bad idea?', expectedMode: 'chat' },
  { id: 'ambiguous-7', category: 'ambiguous', message: 'Thoughts?', expectedMode: 'chat' },
  { id: 'ambiguous-8', category: 'ambiguous', message: 'What do you think about remote work?', expectedMode: 'chat' },
  { id: 'ambiguous-9', category: 'ambiguous', message: 'Help me think through this decision', expectedMode: 'chat' },
  { id: 'ambiguous-10', category: 'ambiguous', message: 'Tell me about North Korea', expectedMode: 'smart', expectedDomain: 'research' },

  // ─── CONFIRMATION / ACKNOWLEDGEMENT ────────────────────────
  { id: 'confirm-1', category: 'confirmation', message: 'Yes', expectedMode: 'chat' },
  { id: 'confirm-2', category: 'confirmation', message: 'Send it', expectedMode: 'smart' },
  { id: 'confirm-3', category: 'confirmation', message: 'Looks good, go ahead', expectedMode: 'chat' },
  { id: 'confirm-4', category: 'confirmation', message: 'Nah cancel that', expectedMode: 'chat' },
  { id: 'confirm-5', category: 'confirmation', message: 'Change the subject to something else', expectedMode: 'smart' },
  { id: 'confirm-6', category: 'confirmation', message: 'Yes', expectedMode: 'smart', context: {
    pendingEmailSends: [{ id: 1, chatId: 'test', to: ['tom@example.com'], subject: 'Test', status: 'pending' } as never],
  } },
  { id: 'confirm-7', category: 'confirmation', message: 'Actually make it more formal', expectedMode: 'smart', context: {
    pendingEmailSends: [{ id: 1, chatId: 'test', to: ['tom@example.com'], subject: 'Test', status: 'pending' } as never],
  } },
  { id: 'confirm-8', category: 'confirmation', message: 'Perfect', expectedMode: 'chat' },
  { id: 'confirm-9', category: 'confirmation', message: 'Thanks', expectedMode: 'chat' },
  { id: 'confirm-10', category: 'confirmation', message: 'Cheers', expectedMode: 'chat' },

  // ─── EDGE CASES ────────────────────────────────────────────
  { id: 'edge-1', category: 'edge', message: '?', expectedMode: 'chat' },
  { id: 'edge-2', category: 'edge', message: '!', expectedMode: 'chat' },
  { id: 'edge-3', category: 'edge', message: 'waht tiem is my nxt meeitng', expectedMode: 'smart', expectedCapabilities: ['calendar.read'] },
  { id: 'edge-4', category: 'edge', message: "What's the weather in Dubai and also check my calendar for tomorrow", expectedMode: 'smart' },
  { id: 'edge-5', category: 'edge', message: "By the way, I'm thinking of getting a Tesla Model 3", expectedMode: 'chat' },
  { id: 'edge-6', category: 'edge', message: 'I need you to help me with something. So basically what happened is that I was at work today and my boss Daniel came up to me and said that we need to restructure the entire Singapore incentive program', expectedMode: 'smart' },
  { id: 'edge-7', category: 'edge', message: 'lol', expectedMode: 'chat' },
  { id: 'edge-8', category: 'edge', message: 'yo', expectedMode: 'chat' },
  { id: 'edge-9', category: 'edge', message: 'good morning', expectedMode: 'chat' },
  { id: 'edge-10', category: 'edge', message: 'ugh mondays', expectedMode: 'chat' },

  // ─── CHAT vs SMART BOUNDARY ────────────────────────────────
  { id: 'boundary-1', category: 'boundary', message: "I'm feeling stressed about work", expectedMode: 'chat' },
  { id: 'boundary-2', category: 'boundary', message: "I'm feeling stressed about work, check my calendar", expectedMode: 'smart', expectedCapabilities: ['calendar.read'] },
  { id: 'boundary-3', category: 'boundary', message: 'How should I think about calendar hygiene?', expectedMode: 'chat' },
  { id: 'boundary-4', category: 'boundary', message: "What's on my calendar?", expectedMode: 'smart', expectedCapabilities: ['calendar.read'] },
  { id: 'boundary-5', category: 'boundary', message: 'Tell me about the history of Japan', expectedMode: 'chat', expectedDomain: 'general' },
  { id: 'boundary-6', category: 'boundary', message: 'Im bored lol', expectedMode: 'chat' },
  { id: 'boundary-7', category: 'boundary', message: 'What are your thoughts on AI?', expectedMode: 'chat' },
  { id: 'boundary-8', category: 'boundary', message: 'Search the web for AI news', expectedMode: 'smart', expectedCapabilities: ['web.search'] },
  { id: 'boundary-9', category: 'boundary', message: 'How does venture capital work?', expectedMode: 'chat' },
  { id: 'boundary-10', category: 'boundary', message: 'Who emailed me today?', expectedMode: 'smart', expectedCapabilities: ['email.read'], expectedRequiresToolUse: true },
];

function makeInput(message: string): TurnInput {
  return {
    chatId: 'EVAL#classifier',
    userMessage: message,
    images: [],
    audio: [],
    senderHandle: '+61414187820',
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId: null,
    isOnboarding: false,
    timezone: 'Australia/Melbourne',
  };
}

function makeContext(overrides?: Partial<RouterContext>): RouterContext {
  return {
    recentTurns: overrides?.recentTurns ?? [],
    workingMemory: emptyWorkingMemory(),
    pendingEmailSend: null,
    pendingEmailSends: overrides?.pendingEmailSends ?? [],
  };
}

interface EvalResult {
  id: string;
  category: string;
  pass: boolean;
  failures: string[];
  result: ClassifierResult;
  latencyMs: number;
}

async function runEvalCase(tc: EvalCase): Promise<EvalResult> {
  const start = Date.now();
  const failures: string[] = [];

  const result = await classifyTurn(makeInput(tc.message), makeContext(tc.context));
  const latencyMs = Date.now() - start;

  if (result.mode !== tc.expectedMode) {
    failures.push(`mode: expected ${tc.expectedMode}, got ${result.mode}`);
  }

  if (tc.expectedDomain && result.primaryDomain !== tc.expectedDomain) {
    failures.push(`domain: expected ${tc.expectedDomain}, got ${result.primaryDomain}`);
  }

  if (tc.expectedCapabilities) {
    for (const cap of tc.expectedCapabilities) {
      const allCaps = [...result.requiredCapabilities, ...(result.preferredCapabilities ?? [])];
      if (!allCaps.includes(cap)) {
        failures.push(`capability ${cap} missing (got: [${allCaps.join(', ')}])`);
      }
    }
  }

  if (tc.expectedMemoryDepth && result.memoryDepth !== tc.expectedMemoryDepth) {
    failures.push(`memoryDepth: expected ${tc.expectedMemoryDepth}, got ${result.memoryDepth}`);
  }

  if (tc.expectedRequiresToolUse !== undefined && result.requiresToolUse !== tc.expectedRequiresToolUse) {
    failures.push(`requiresToolUse: expected ${tc.expectedRequiresToolUse}, got ${result.requiresToolUse}`);
  }

  return { id: tc.id, category: tc.category, pass: failures.length === 0, failures, result, latencyMs };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Classifier Accuracy Evaluation                            ║');
  console.log(`║  ${EVAL_CASES.length} test cases                                              ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: EvalResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  const grouped = new Map<string, EvalCase[]>();
  for (const tc of EVAL_CASES) {
    const group = grouped.get(tc.category) ?? [];
    group.push(tc);
    grouped.set(tc.category, group);
  }

  for (const [category, cases] of grouped) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${category.toUpperCase()} (${cases.length} cases)`);
    console.log(`${'─'.repeat(50)}`);

    for (const tc of cases) {
      const r = await runEvalCase(tc);
      results.push(r);

      if (r.pass) {
        totalPass++;
        console.log(`  ✓ [${r.id}] mode=${r.result.mode}, domain=${r.result.primaryDomain}, caps=[${r.result.requiredCapabilities.join(',')}] (${r.latencyMs}ms)`);
      } else {
        totalFail++;
        console.log(`  ✗ [${r.id}] "${tc.message.substring(0, 60)}"`);
        for (const f of r.failures) {
          console.log(`    ✗ ${f}`);
        }
      }
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total: ${results.length} | Pass: ${totalPass} | Fail: ${totalFail}`);
  console.log(`  Overall accuracy: ${((totalPass / results.length) * 100).toFixed(1)}%`);

  // Mode accuracy
  const modeCorrect = results.filter(r => !r.failures.some(f => f.startsWith('mode:'))).length;
  console.log(`  Mode accuracy: ${((modeCorrect / results.length) * 100).toFixed(1)}%`);

  // Domain accuracy (only for cases with expectedDomain)
  const domainCases = results.filter((_, i) => EVAL_CASES[i].expectedDomain);
  const domainCorrect = domainCases.filter(r => !r.failures.some(f => f.startsWith('domain:'))).length;
  if (domainCases.length > 0) {
    console.log(`  Domain accuracy: ${((domainCorrect / domainCases.length) * 100).toFixed(1)}% (${domainCases.length} cases)`);
  }

  // Capability accuracy
  const capCases = results.filter((_, i) => EVAL_CASES[i].expectedCapabilities);
  const capCorrect = capCases.filter(r => !r.failures.some(f => f.startsWith('capability'))).length;
  if (capCases.length > 0) {
    console.log(`  Capability accuracy: ${((capCorrect / capCases.length) * 100).toFixed(1)}% (${capCases.length} cases)`);
  }

  // Per-category breakdown
  console.log('\n  PER-CATEGORY:');
  for (const [category, cases] of grouped) {
    const catResults = results.filter(r => r.category === category);
    const catPass = catResults.filter(r => r.pass).length;
    const catAvgLatency = catResults.reduce((s, r) => s + r.latencyMs, 0) / catResults.length;
    console.log(`    ${category.padEnd(20)} ${catPass}/${cases.length} pass | avg ${catAvgLatency.toFixed(0)}ms`);
  }

  // Latency stats
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  console.log(`\n  Latency: p50=${p50}ms, p95=${p95}ms, avg=${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);

  if (totalFail > 0) {
    console.log('\n  FAILURES:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    [${r.id}] ${r.failures.join('; ')}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}\n`);

  const modeTarget = 95;
  const domainTarget = 90;
  const capTarget = 85;

  const modeAcc = (modeCorrect / results.length) * 100;
  const domainAcc = domainCases.length > 0 ? (domainCorrect / domainCases.length) * 100 : 100;
  const capAcc = capCases.length > 0 ? (capCorrect / capCases.length) * 100 : 100;

  console.log(`  Targets: mode≥${modeTarget}% (${modeAcc >= modeTarget ? '✓' : '✗'} ${modeAcc.toFixed(1)}%), domain≥${domainTarget}% (${domainAcc >= domainTarget ? '✓' : '✗'} ${domainAcc.toFixed(1)}%), capability≥${capTarget}% (${capAcc >= capTarget ? '✓' : '✗'} ${capAcc.toFixed(1)}%)`);

  Deno.exit(totalFail > 0 ? 1 : 0);
}

main();
