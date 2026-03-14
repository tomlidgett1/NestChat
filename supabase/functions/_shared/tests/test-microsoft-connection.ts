/**
 * Microsoft connection test for Tom Lidgett.
 * Tests: DB accounts, token refresh, Outlook email/calendar/contacts, routing fix.
 *
 * Run with:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-microsoft-connection.ts
 */

import { ensureNestUser } from '../state.ts';
import { getMicrosoftAccessToken } from '../token-broker.ts';
import { getAdminClient } from '../supabase.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';

console.log('=== MICROSOFT CONNECTION TEST FOR TOM LIDGETT ===\n');

// 1. Resolve user
console.log('1. Resolving Nest user...');
const nestUser = await ensureNestUser(SENDER, BOT);
console.log(`   authUserId: ${nestUser.authUserId}`);
console.log(`   displayName: ${nestUser.displayName}`);

if (!nestUser.authUserId) {
  console.log('\n   FATAL: No authUserId — cannot proceed.');
  Deno.exit(1);
}

// 2. Check Microsoft accounts in DB
console.log('\n2. Checking user_microsoft_accounts table...');
const supabase = getAdminClient();
const { data: msAccounts, error: msErr } = await supabase
  .from('user_microsoft_accounts')
  .select('id, microsoft_email, microsoft_name, created_at')
  .eq('user_id', nestUser.authUserId);

if (msErr) {
  console.log(`   ERROR: ${msErr.message}`);
  Deno.exit(1);
} else if (!msAccounts || msAccounts.length === 0) {
  console.log('   NO Microsoft accounts found!');
  Deno.exit(1);
} else {
  for (const acct of msAccounts) {
    console.log(`   OK ${acct.microsoft_email} (${acct.microsoft_name}) — id=${acct.id}, created=${acct.created_at}`);
  }
}

// 3. Test token refresh
console.log('\n3. Testing Microsoft token refresh...');
let tokenForTests: string | null = null;
let emailForTests: string | null = null;

for (const acct of msAccounts) {
  try {
    const token = await getMicrosoftAccessToken(nestUser.authUserId, { email: acct.microsoft_email });
    tokenForTests = token.accessToken;
    emailForTests = token.email;
    console.log(`   OK Token for ${token.email}: ${token.accessToken.slice(0, 40)}...`);
  } catch (e) {
    console.log(`   FAIL Token refresh FAILED for ${acct.microsoft_email}: ${(e as Error).message}`);
  }
}

if (!tokenForTests) {
  console.log('\n   FATAL: No valid Microsoft token — cannot proceed.');
  Deno.exit(1);
}

// 4. Test Outlook email search
console.log('\n4. Testing Outlook email search (latest 5)...');
try {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$top=5&$orderby=receivedDateTime desc&$select=id,from,subject,receivedDateTime,bodyPreview`,
    { headers: { Authorization: `Bearer ${tokenForTests}` } },
  );
  if (!resp.ok) {
    const detail = await resp.text();
    console.log(`   FAIL Outlook messages API (${resp.status}): ${detail.slice(0, 300)}`);
  } else {
    const data = await resp.json();
    const msgs = data.value ?? [];
    console.log(`   OK Found ${msgs.length} emails in ${emailForTests}:`);
    for (const m of msgs) {
      const from = m.from?.emailAddress?.address ?? '?';
      console.log(`     - [${m.receivedDateTime?.slice(0, 16)}] From: ${from} | Subject: ${m.subject}`);
    }
  }
} catch (e) {
  console.log(`   FAIL Error: ${(e as Error).message}`);
}

// 5. Test Outlook calendar
console.log('\n5. Testing Outlook calendar (next 7 days)...');
try {
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: weekLater.toISOString(),
    '$top': '10',
    '$select': 'subject,start,end,organizer,location',
    '$orderby': 'start/dateTime',
  });
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
    { headers: { Authorization: `Bearer ${tokenForTests}`, Prefer: 'outlook.timezone="Australia/Sydney"' } },
  );
  if (!resp.ok) {
    const detail = await resp.text();
    console.log(`   FAIL Calendar API (${resp.status}): ${detail.slice(0, 300)}`);
  } else {
    const data = await resp.json();
    const events = data.value ?? [];
    console.log(`   OK Found ${events.length} calendar events in ${emailForTests}:`);
    for (const evt of events) {
      console.log(`     - ${evt.subject} | ${evt.start?.dateTime} → ${evt.end?.dateTime}`);
    }
    if (events.length === 0) console.log('     (empty calendar — that is fine)');
  }
} catch (e) {
  console.log(`   FAIL Error: ${(e as Error).message}`);
}

// 6. Test Outlook contacts
console.log('\n6. Testing Outlook contacts search (query: "tom")...');
try {
  const params = new URLSearchParams({
    '$search': '"tom"',
    '$top': '5',
    '$select': 'displayName,emailAddresses,businessPhones',
  });
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/contacts?${params}`,
    { headers: { Authorization: `Bearer ${tokenForTests}`, ConsistencyLevel: 'eventual' } },
  );
  if (!resp.ok) {
    const detail = await resp.text();
    console.log(`   FAIL Contacts API (${resp.status}): ${detail.slice(0, 300)}`);
  } else {
    const data = await resp.json();
    const contacts = data.value ?? [];
    console.log(`   OK Found ${contacts.length} contacts matching "tom" in ${emailForTests}:`);
    for (const c of contacts) {
      const emails = (c.emailAddresses ?? []).map((e: any) => e.address).join(', ');
      console.log(`     - ${c.displayName} | ${emails}`);
    }
    if (contacts.length === 0) console.log('     (no contacts — that is fine for a new account)');
  }
} catch (e) {
  console.log(`   FAIL Error: ${(e as Error).message}`);
}

// 7. Test Outlook timezone
console.log('\n7. Testing Outlook timezone detection...');
try {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailboxSettings`,
    { headers: { Authorization: `Bearer ${tokenForTests}` } },
  );
  if (!resp.ok) {
    const detail = await resp.text();
    console.log(`   FAIL Mailbox settings API (${resp.status}): ${detail.slice(0, 300)}`);
  } else {
    const data = await resp.json();
    console.log(`   OK Timezone: ${data.timeZone ?? 'not set'}`);
    console.log(`   OK Date format: ${data.dateFormat ?? 'not set'}`);
    console.log(`   OK Time format: ${data.timeFormat ?? 'not set'}`);
  }
} catch (e) {
  console.log(`   FAIL Error: ${(e as Error).message}`);
}

// 8. Test routing fix
console.log('\n8. Testing routing: "What\'s in my Microsoft inbox"...');
try {
  const { routeTurnV2 } = await import('../orchestrator/route-turn-v2.ts');
  const { buildRouterContext } = await import('../orchestrator/build-context.ts');

  const turnInput = {
    chatId: 'TEST#msft#routing',
    userMessage: "What's in my Microsoft inbox",
    images: [] as string[],
    audio: [] as string[],
    senderHandle: SENDER,
    isGroupChat: false,
    participantNames: [] as string[],
    chatName: null,
    authUserId: nestUser.authUserId,
    isOnboarding: false,
    timezone: 'Australia/Sydney',
  };

  const routerCtx = await buildRouterContext(turnInput);
  const route = await routeTurnV2(turnInput, routerCtx);
  console.log(`   Agent: ${route.agent}`);
  console.log(`   Fast path: ${route.fastPathUsed}`);
  console.log(`   Layer: ${(route as any).routeLayer ?? 'unknown'}`);
  console.log(`   Namespaces: ${route.allowedNamespaces.join(', ')}`);

  const hasEmailRead = route.allowedNamespaces.includes('email.read');
  if (route.agent === 'smart' && hasEmailRead) {
    console.log(`   OK Correctly routed to smart with email.read`);
  } else {
    console.log(`   FAIL Should be smart with email.read, got agent=${route.agent}, hasEmailRead=${hasEmailRead}`);
  }
} catch (e) {
  console.log(`   FAIL Routing test error: ${(e as Error).message}`);
}

// 9. End-to-end: handleTurn with Microsoft inbox query
console.log('\n9. End-to-end: handleTurn("What\'s in my Microsoft inbox")...');
try {
  const { handleTurn } = await import('../orchestrator/handle-turn.ts');
  const { clearConversation } = await import('../state.ts');

  const chatId = 'TEST#msft#e2e';
  await clearConversation(chatId).catch(() => {});

  const result = await handleTurn({
    chatId,
    userMessage: "What's in my Microsoft inbox",
    images: [],
    audio: [],
    senderHandle: SENDER,
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId: nestUser.authUserId,
    isOnboarding: false,
    timezone: 'Australia/Sydney',
  });

  console.log(`   Agent: ${result.trace.agentName}`);
  console.log(`   Model: ${result.trace.modelUsed}`);
  console.log(`   Tools: ${result.trace.toolCalls.map((t: any) => t.name).join(', ') || '(none)'}`);
  console.log(`   Latency: ${result.trace.totalMs}ms`);
  console.log(`   Response:\n${result.text.split('\n').map((l: string) => '     ' + l).join('\n')}`);

  const usedEmailRead = result.trace.toolCalls.some((t: any) => t.name === 'email_read');
  if (usedEmailRead) {
    console.log(`   OK email_read tool was called — real data, no hallucination`);
  } else {
    console.log(`   WARN email_read was NOT called — check if response is hallucinated`);
  }
} catch (e) {
  console.log(`   FAIL E2E error: ${(e as Error).message}`);
}

console.log('\n=== ALL MICROSOFT TESTS COMPLETE ===');
Deno.exit(0);
