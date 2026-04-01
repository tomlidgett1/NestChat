/**
 * Test script: runs the full inbox summary pipeline for a specific user handle.
 * Usage: cd Nest && deno run --allow-all supabase/functions/_shared/tests/test-inbox-summary.ts
 */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { config } from 'https://deno.land/x/dotenv@v3.2.2/mod.ts';

config({ path: '.env', export: true });

const { getAdminClient } = await import('../supabase.ts');
const { getConnectedAccounts, getUserProfile } = await import('../state.ts');
const { gmailSearchTool } = await import('../gmail-helpers.ts');
const { generateInboxSummary } = await import('../inbox-summary.ts');

const HANDLE = '+61414187820';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(`INBOX SUMMARY TEST — ${HANDLE}`);
  console.log('═══════════════════════════════════════════════════\n');

  const supabase = getAdminClient();

  // 1. Load user profile
  console.log('--- USER PROFILE ---');
  const profile = await getUserProfile(HANDLE);
  if (!profile) {
    console.error('No profile found for handle:', HANDLE);
    Deno.exit(1);
  }
  console.log(`Name: ${profile.name}`);
  console.log(`Handle: ${profile.handle}`);
  console.log(`Deep profile built: ${profile.deepProfileBuiltAt ?? 'never'}`);
  const identity = profile.deepProfileSnapshot?.identity as Record<string, unknown> | undefined;
  if (identity) {
    console.log(`Profile identity name: ${identity.name ?? 'null'}`);
    console.log(`Profile identity company: ${identity.company ?? 'null'}`);
    console.log(`Profile identity role: ${identity.role ?? 'null'}`);
  }

  // 2. Resolve auth_user_id
  const { data: userRow } = await supabase
    .from('user_profiles')
    .select('auth_user_id, bot_number, timezone')
    .eq('handle', HANDLE)
    .maybeSingle();

  if (!userRow?.auth_user_id) {
    console.error('No auth_user_id for handle:', HANDLE);
    Deno.exit(1);
  }
  console.log(`auth_user_id: ${userRow.auth_user_id}`);
  console.log(`bot_number: ${userRow.bot_number}`);
  console.log(`timezone: ${userRow.timezone}`);

  // 3. Connected accounts
  console.log('\n--- CONNECTED ACCOUNTS ---');
  const accounts = await getConnectedAccounts(userRow.auth_user_id);
  if (!accounts.length) {
    console.error('NO CONNECTED ACCOUNTS! This is why it might look empty.');
  }
  for (const acct of accounts) {
    console.log(`  ${acct.provider} | ${acct.email} | name=${acct.name} | primary=${acct.isPrimary} | scopes=${acct.scopes.join(',')}`);
  }

  // 4. Raw email fetch (to see what gmailSearchTool actually returns)
  console.log('\n--- RAW INBOX FETCH (is:unread newer_than:7d) ---');
  const tz = userRow.timezone || 'Australia/Sydney';
  const inboxResult = await gmailSearchTool(userRow.auth_user_id, {
    query: 'in:inbox is:unread newer_than:7d',
    max_results: 18,
    time_zone: tz,
  });
  console.log(`Status: ${inboxResult.status} | Count: ${inboxResult.count} | Accounts checked: ${inboxResult.accounts_checked}`);
  if (inboxResult.account_errors?.length) {
    console.log('Account errors:');
    for (const err of inboxResult.account_errors) {
      console.log(`  ${err.account} (${err.provider}): ${err.error}`);
    }
  }
  for (const row of inboxResult.results.slice(0, 10)) {
    const from = row.from?.split('<')[0]?.trim() || row.from;
    console.log(`  [${row.provider}/${row.account}] "${row.subject}" from ${from} | important=${row.is_important} | date=${row.date}`);
  }
  if (inboxResult.results.length > 10) {
    console.log(`  ... and ${inboxResult.results.length - 10} more`);
  }

  // 5. Raw sent fetch
  console.log('\n--- RAW SENT FETCH (in:sent newer_than:7d) ---');
  const sentResult = await gmailSearchTool(userRow.auth_user_id, {
    query: 'in:sent newer_than:7d',
    max_results: 10,
    time_zone: tz,
  });
  console.log(`Status: ${sentResult.status} | Count: ${sentResult.count}`);
  for (const row of sentResult.results.slice(0, 8)) {
    const to = row.to?.split('<')[0]?.trim() || row.to;
    console.log(`  "${row.subject}" to ${to} | date=${row.date}`);
  }

  // 6. Run the full inbox summary pipeline
  console.log('\n═══════════════════════════════════════════════════');
  console.log('RUNNING FULL INBOX SUMMARY PIPELINE');
  console.log('═══════════════════════════════════════════════════\n');

  const result = await generateInboxSummary({
    authUserId: userRow.auth_user_id,
    handle: HANDLE,
    name: profile.name,
    botNumber: userRow.bot_number || '',
    nextRunAt: new Date().toISOString(),
    config: { timezone: tz },
    deepProfileSnapshot: profile.deepProfileSnapshot,
  }, tz);

  if (!result) {
    console.error('\nPIPELINE RETURNED NULL - no message generated');
    Deno.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('FINAL MESSAGE:');
  console.log('═══════════════════════════════════════════════════');
  console.log(result.message);
  console.log('\n═══════════════════════════════════════════════════');
  console.log('METADATA:');
  console.log('═══════════════════════════════════════════════════');
  console.log(JSON.stringify(result.metadata, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err);
  Deno.exit(1);
});
