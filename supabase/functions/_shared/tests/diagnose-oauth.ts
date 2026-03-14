/**
 * Diagnose OAuth token and Gmail API connectivity.
 * Run: deno run --allow-all --env=.env supabase/functions/_shared/tests/diagnose-oauth.ts
 */
import { getAdminClient } from '../supabase.ts';
import { getOptionalEnv } from '../env.ts';
import { ensureNestUser } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';

const GOOGLE_CLIENT_ID = getOptionalEnv('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = getOptionalEnv('GOOGLE_CLIENT_SECRET') ?? '';

console.log('=== OAUTH DIAGNOSTIC ===\n');

// Step 1: Resolve user
const nestUser = await ensureNestUser(SENDER, BOT);
const userId = nestUser.authUserId;
console.log(`1. User ID: ${userId}`);

if (!userId) {
  console.error('   FAIL: No authUserId found');
  Deno.exit(1);
}

// Step 2: Check Google accounts in DB
const supabase = getAdminClient();
const { data: accounts, error: acctErr } = await supabase
  .from('user_google_accounts')
  .select('id, google_email, refresh_token, is_primary, scopes, updated_at')
  .eq('user_id', userId);

if (acctErr) {
  console.error(`2. DB query error: ${acctErr.message}`);
  Deno.exit(1);
}

console.log(`2. Google accounts found: ${accounts?.length ?? 0}`);
if (!accounts || accounts.length === 0) {
  console.error('   FAIL: No Google accounts linked to this user');
  Deno.exit(1);
}

for (const acct of accounts) {
  console.log(`\n   --- Account: ${acct.google_email} ---`);
  console.log(`   ID: ${acct.id}`);
  console.log(`   Primary: ${acct.is_primary}`);
  console.log(`   Scopes: ${acct.scopes ?? '(null)'}`);
  console.log(`   Updated: ${acct.updated_at}`);
  console.log(`   Refresh token: ${acct.refresh_token ? acct.refresh_token.substring(0, 20) + '...' : '(null)'}`);

  if (!acct.refresh_token) {
    console.error('   FAIL: No refresh_token stored');
    continue;
  }

  // Step 3: Try to refresh the token
  console.log('\n3. Attempting token refresh...');
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error('   FAIL: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set');
    continue;
  }

  const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: acct.refresh_token,
    }),
  });

  const refreshData = await refreshResp.json();

  if (!refreshResp.ok) {
    console.error(`   FAIL: Token refresh returned ${refreshResp.status}`);
    console.error(`   Error: ${refreshData.error}`);
    console.error(`   Description: ${refreshData.error_description}`);
    console.error('\n   >>> This is the root cause. The refresh token is invalid/revoked.');
    console.error('   >>> User needs to re-authenticate via the onboarding OAuth flow.');
    continue;
  }

  const accessToken = refreshData.access_token;
  console.log(`   OK: Got access token (${accessToken.substring(0, 20)}...)`);
  console.log(`   Expires in: ${refreshData.expires_in}s`);
  if (refreshData.refresh_token) {
    console.log(`   New refresh token issued (rotating)`);
  }

  // Step 4: Try Gmail API call
  console.log('\n4. Testing Gmail API...');
  const gmailResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!gmailResp.ok) {
    const gmailErr = await gmailResp.text();
    console.error(`   FAIL: Gmail API returned ${gmailResp.status}`);
    console.error(`   Body: ${gmailErr.substring(0, 500)}`);
    continue;
  }

  const gmailData = await gmailResp.json();
  const messageCount = gmailData.messages?.length ?? 0;
  console.log(`   OK: Gmail API returned ${messageCount} messages`);
  console.log(`   Result size estimate: ${gmailData.resultSizeEstimate}`);

  if (messageCount > 0) {
    console.log(`   First message ID: ${gmailData.messages[0].id}`);
  }

  // Step 5: Try Gmail search with query
  console.log('\n5. Testing Gmail search (newer_than:7d)...');
  const searchResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than%3A7d&maxResults=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!searchResp.ok) {
    const searchErr = await searchResp.text();
    console.error(`   FAIL: Gmail search returned ${searchResp.status}`);
    console.error(`   Body: ${searchErr.substring(0, 500)}`);
    continue;
  }

  const searchData = await searchResp.json();
  const searchCount = searchData.messages?.length ?? 0;
  console.log(`   OK: Search returned ${searchCount} messages`);

  // Step 6: Try Calendar API
  console.log('\n6. Testing Calendar API...');
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
  const calResp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${todayStart}&timeMax=${todayEnd}&maxResults=10&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!calResp.ok) {
    const calErr = await calResp.text();
    console.error(`   FAIL: Calendar API returned ${calResp.status}`);
    console.error(`   Body: ${calErr.substring(0, 500)}`);
    continue;
  }

  const calData = await calResp.json();
  const eventCount = calData.items?.length ?? 0;
  console.log(`   OK: Calendar returned ${eventCount} events today`);
}

console.log('\n=== DIAGNOSTIC COMPLETE ===');
Deno.exit(0);
