// ═══════════════════════════════════════════════════════════════
// Safety Net Write-Tool Exemption Test Suite
//
// Validates that the safety net override (chat→smart when low
// confidence) ONLY fires for write/draft/commit tools, NOT for
// read-only tools like web_search, email_read, etc.
//
// Run: deno run --allow-all --node-modules-dir=auto supabase/functions/_shared/tests/test-safety-net-write-tools.ts
// ═══════════════════════════════════════════════════════════════

// ── Replicate the regex patterns from route-turn-v2.ts ────────
const ALL_TOOL_TAG = /\[(email_read|email_draft|email_send|calendar_read|calendar_write|contacts_read|travel_time|places_search|semantic_search|granola_read|web_search|plan_steps)\]/;
const WRITE_TOOL_TAG = /\[(email_draft|email_send|calendar_write|plan_steps)\]/;

interface Turn { role: string; content: string; }

function lastAssistantUsedTools(recentTurns: Turn[], userMessage: string): boolean {
  const assistants = recentTurns.filter((t) => t.role === 'assistant');
  const last = assistants.slice(-1)[0]?.content ?? '';
  if (ALL_TOOL_TAG.test(last)) return true;
  if (userMessage.length <= 30) {
    return assistants.slice(-3).some((t) => ALL_TOOL_TAG.test(t.content));
  }
  return false;
}

function lastAssistantUsedWriteTools(recentTurns: Turn[], userMessage: string): boolean {
  const assistants = recentTurns.filter((t) => t.role === 'assistant');
  const last = assistants.slice(-1)[0]?.content ?? '';
  if (WRITE_TOOL_TAG.test(last)) return true;
  if (userMessage.length <= 30) {
    return assistants.slice(-3).some((t) => WRITE_TOOL_TAG.test(t.content));
  }
  return false;
}

// ── Test infrastructure ──────────────────────────────────────

interface TestCase {
  name: string;
  userMessage: string;
  recentTurns: Turn[];
  expectToolsInLastTurn: boolean;
  expectWriteToolsInLastTurn: boolean;
  // The critical assertion: should safety net fire?
  expectSafetyNetFires: boolean;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(tc: TestCase): void {
  const toolsResult = lastAssistantUsedTools(tc.recentTurns, tc.userMessage);
  const writeResult = lastAssistantUsedWriteTools(tc.recentTurns, tc.userMessage);

  const errors: string[] = [];

  if (toolsResult !== tc.expectToolsInLastTurn) {
    errors.push(`toolsInLastTurn: expected=${tc.expectToolsInLastTurn}, got=${toolsResult}`);
  }
  if (writeResult !== tc.expectWriteToolsInLastTurn) {
    errors.push(`writeToolsInLastTurn: expected=${tc.expectWriteToolsInLastTurn}, got=${writeResult}`);
  }
  // Safety net fires when: writeToolsInLastTurn=true (+ low confidence + chat, but we test the write part)
  if (writeResult !== tc.expectSafetyNetFires) {
    errors.push(`safetyNetFires: expected=${tc.expectSafetyNetFires}, got=${writeResult}`);
  }

  if (errors.length === 0) {
    passed++;
    const safetyLabel = tc.expectSafetyNetFires ? '🔒 FIRES' : '✅ SKIPS';
    console.log(`  ✅ ${tc.name} → tools=${toolsResult}, write=${writeResult} [safety net ${safetyLabel}]`);
  } else {
    failed++;
    const detail = errors.join('; ');
    failures.push(`${tc.name}: ${detail}`);
    console.log(`  ❌ ${tc.name} → ${detail}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  Safety Net Write-Tool Exemption Test Suite                      ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// ── Section 1: Read-only tools → safety net should NOT fire ──
console.log('── Read-Only Tools (safety net should NOT fire) ──');

assert({
  name: 'web_search → casual follow-up "Interesting"',
  userMessage: 'Interesting',
  recentTurns: [
    { role: 'assistant', content: 'Here is what I found about the weather in Melbourne [web_search]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'web_search → casual follow-up "Intereinstg" (typo)',
  userMessage: 'Intereinstg',
  recentTurns: [
    { role: 'assistant', content: 'The latest on Tesla earnings [web_search]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'email_read → "nice"',
  userMessage: 'nice',
  recentTurns: [
    { role: 'assistant', content: 'You have 3 new emails from today [email_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'calendar_read → "ok thanks"',
  userMessage: 'ok thanks',
  recentTurns: [
    { role: 'assistant', content: 'Your schedule today: 10am standup, 2pm design review [calendar_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'semantic_search → "cool"',
  userMessage: 'cool',
  recentTurns: [
    { role: 'assistant', content: 'Based on your notes, you discussed this topic last week [semantic_search]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'contacts_read → "got it"',
  userMessage: 'got it',
  recentTurns: [
    { role: 'assistant', content: 'I found Sarah Jones in your contacts [contacts_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'travel_time → "thanks"',
  userMessage: 'thanks',
  recentTurns: [
    { role: 'assistant', content: 'It takes about 35 minutes by car [travel_time]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'places_search → "haha nice"',
  userMessage: 'haha nice',
  recentTurns: [
    { role: 'assistant', content: 'Ashburton Cycles — 4.8 stars, open until 5pm [places_search]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'granola_read → "ah right"',
  userMessage: 'ah right',
  recentTurns: [
    { role: 'assistant', content: 'From your meeting notes: the team agreed to ship by Friday [granola_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 2: Write tools → safety net SHOULD fire ──────────
console.log('\n── Write/Action Tools (safety net SHOULD fire) ──');

assert({
  name: 'email_draft → "looks good"',
  userMessage: 'looks good',
  recentTurns: [
    { role: 'assistant', content: 'I\'ve drafted the email to Tom about the project update [email_draft]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'email_send → "ok"',
  userMessage: 'ok',
  recentTurns: [
    { role: 'assistant', content: 'Email sent to tom@lidgett.net [email_send]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'calendar_write → "perfect"',
  userMessage: 'perfect',
  recentTurns: [
    { role: 'assistant', content: 'I\'ve created the meeting for Friday at 3pm [calendar_write]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'plan_steps → "yes"',
  userMessage: 'yes',
  recentTurns: [
    { role: 'assistant', content: 'Here is the plan for your trip to Tokyo [plan_steps]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

// ── Section 3: Mixed tools → safety net should fire if ANY write tool present ──
console.log('\n── Mixed Read + Write Tools ──');

assert({
  name: 'email_read + email_draft in same turn → fires',
  userMessage: 'nice',
  recentTurns: [
    { role: 'assistant', content: 'I read the email [email_read] and drafted a reply [email_draft]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'web_search + plan_steps → fires',
  userMessage: 'cool',
  recentTurns: [
    { role: 'assistant', content: 'I searched for flights [web_search] and created a plan [plan_steps]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'semantic_search + calendar_write → fires',
  userMessage: 'thanks',
  recentTurns: [
    { role: 'assistant', content: 'Found your preferences [semantic_search] and booked the slot [calendar_write]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

// ── Section 4: Lookback (short messages, 3-turn window) ──────
console.log('\n── 3-Turn Lookback for Short Messages ──');

assert({
  name: 'web_search 2 turns ago + short msg → tools=true, write=false',
  userMessage: 'ok',
  recentTurns: [
    { role: 'assistant', content: 'Here are the results [web_search]' },
    { role: 'user', content: 'tell me more' },
    { role: 'assistant', content: 'Sure, here is more detail about that topic.' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'email_draft 2 turns ago + short msg → tools=true, write=true',
  userMessage: 'ok',
  recentTurns: [
    { role: 'assistant', content: 'I\'ve drafted the email [email_draft]' },
    { role: 'user', content: 'change the subject' },
    { role: 'assistant', content: 'Done, I updated the subject line.' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'email_send 3 turns ago + short msg → still within window',
  userMessage: 'nice',
  recentTurns: [
    { role: 'assistant', content: 'Email sent [email_send]' },
    { role: 'user', content: 'what about the other one' },
    { role: 'assistant', content: 'Let me check on that.' },
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'That one was already handled.' },
  ],
  expectToolsInLastTurn: true,  // 3rd-to-last assistant has email_send
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'web_search 3 turns ago + short msg → lookback finds it, but no write',
  userMessage: 'ok',
  recentTurns: [
    { role: 'assistant', content: 'Found some info [web_search]' },
    { role: 'user', content: 'what does it mean' },
    { role: 'assistant', content: 'It means X.' },
    { role: 'user', content: 'and the other part' },
    { role: 'assistant', content: 'That part means Y.' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 5: Long message bypasses lookback ────────────────
console.log('\n── Long Messages (>30 chars, no lookback) ──');

assert({
  name: 'web_search 2 turns ago + LONG new question → no lookback',
  userMessage: 'Tell me everything about quantum computing and how it works in detail',
  recentTurns: [
    { role: 'assistant', content: 'Here are the results [web_search]' },
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'Sure thing.' },
  ],
  expectToolsInLastTurn: false,  // long message, no lookback, last turn has no tag
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'email_draft 2 turns ago + LONG new question → no lookback',
  userMessage: 'Can you explain the difference between REST and GraphQL APIs in detail',
  recentTurns: [
    { role: 'assistant', content: 'Drafted the email [email_draft]' },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'You\'re welcome!' },
  ],
  expectToolsInLastTurn: false,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 6: No tools at all ──────────────────────────────
console.log('\n── No Tools (safety net should NOT fire) ──');

assert({
  name: 'pure chat, no tools ever → no fire',
  userMessage: 'haha',
  recentTurns: [
    { role: 'assistant', content: 'That reminds me of a funny story.' },
  ],
  expectToolsInLastTurn: false,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'empty history → no fire',
  userMessage: 'hey',
  recentTurns: [],
  expectToolsInLastTurn: false,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 7: THE ORIGINAL BUG CASES ───────────────────────
console.log('\n── Original Bug Cases (turns 2055 & 2056) ──');

assert({
  name: 'BUG CASE: "Intereinstg" after web_search → should NOT fire safety net',
  userMessage: 'Intereinstg',
  recentTurns: [
    { role: 'assistant', content: 'Here is what I found about the weather in Melbourne. The forecast shows... [web_search]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'BUG CASE: "Interesting" after web_search → should NOT fire safety net',
  userMessage: 'Interesting',
  recentTurns: [
    { role: 'assistant', content: 'I searched for the latest news on that topic [web_search] and here is a summary.' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 8: Edge cases — multiple read tools ─────────────
console.log('\n── Multiple Read Tools in One Turn ──');

assert({
  name: 'email_read + calendar_read + contacts_read → all read, no fire',
  userMessage: 'thanks',
  recentTurns: [
    { role: 'assistant', content: 'Checked your email [email_read], calendar [calendar_read], and contacts [contacts_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'web_search + semantic_search + granola_read → all read, no fire',
  userMessage: 'cool',
  recentTurns: [
    { role: 'assistant', content: 'Searched the web [web_search], your knowledge base [semantic_search], and meeting notes [granola_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 9: Edge case — tool tag in user message (should not match) ──
console.log('\n── Tool Tags in User Messages (should not match) ──');

assert({
  name: 'user says "[email_draft]" literally → no assistant tool usage',
  userMessage: 'I typed [email_draft] by accident',
  recentTurns: [
    { role: 'assistant', content: 'No problem, how can I help?' },
  ],
  expectToolsInLastTurn: false,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

// ── Section 10: Realistic multi-turn scenarios ──────────────
console.log('\n── Realistic Multi-Turn Scenarios ──');

assert({
  name: 'Research flow: search → "tell me more" → search again → "nice" → no fire',
  userMessage: 'nice',
  recentTurns: [
    { role: 'assistant', content: 'Found some articles about AI [web_search]' },
    { role: 'user', content: 'tell me more about GPT-5' },
    { role: 'assistant', content: 'Here is more detail on GPT-5 capabilities [web_search]' },
  ],
  // Last turn has web_search (read-only)
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'Draft flow: search → draft → user tweak → re-draft → "looks good" → fires',
  userMessage: 'looks good',
  recentTurns: [
    { role: 'assistant', content: 'Found the info [web_search]' },
    { role: 'user', content: 'draft an email to Tom about this' },
    { role: 'assistant', content: 'Here is the draft [email_draft]' },
    { role: 'user', content: 'make it more formal' },
    { role: 'assistant', content: 'Updated the draft with a more formal tone [email_draft]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'Calendar check → book → "perfect" → fires (calendar_write in last turn)',
  userMessage: 'perfect',
  recentTurns: [
    { role: 'assistant', content: 'Your Friday is open from 2-5pm [calendar_read]' },
    { role: 'user', content: 'book 3pm for team sync' },
    { role: 'assistant', content: 'Created "Team Sync" at 3pm Friday [calendar_write]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

assert({
  name: 'Calendar check → "all good" → no fire (only calendar_read)',
  userMessage: 'all good',
  recentTurns: [
    { role: 'assistant', content: 'Your Friday is open from 2-5pm [calendar_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'Email read → "thanks for checking" → no fire',
  userMessage: 'thanks for checking',
  recentTurns: [
    { role: 'assistant', content: 'You have 5 new emails. The most important is from Sarah about the proposal [email_read]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: false,
  expectSafetyNetFires: false,
});

assert({
  name: 'Plan created → "yes do it" → fires (plan_steps is write)',
  userMessage: 'yes do it',
  recentTurns: [
    { role: 'assistant', content: 'I\'ve outlined a plan for your trip:\n1. Book flights\n2. Reserve hotel\n3. Schedule tours [plan_steps]' },
  ],
  expectToolsInLastTurn: true,
  expectWriteToolsInLastTurn: true,
  expectSafetyNetFires: true,
});

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(66)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failures.length > 0) {
  console.log('\n🔴 Failures:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  Deno.exit(1);
} else {
  console.log('\n🟢 All tests passed!');
}
