/**
 * Debug calendar timezone fetching for a specific Google account.
 * Run: deno run --allow-all --env=.env supabase/functions/_shared/tests/debug-timezone.ts
 */
import { getAdminClient } from '../supabase.ts';
import { getOptionalEnv } from '../env.ts';

const SENDER = '+61414187820';
const TARGET_EMAIL = 'thomas.lidgett@blacklane.com';
const GOOGLE_CLIENT_ID = getOptionalEnv('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = getOptionalEnv('GOOGLE_CLIENT_SECRET') ?? '';

const supabase = getAdminClient();

// Get refresh token
const { data: profile } = await supabase
  .from('user_profiles')
  .select('auth_user_id')
  .eq('handle', SENDER)
  .maybeSingle();

if (!profile?.auth_user_id) {
  console.error('No auth_user_id found');
  Deno.exit(1);
}

const { data: acct } = await supabase
  .from('user_google_accounts')
  .select('refresh_token, scopes')
  .eq('user_id', profile.auth_user_id)
  .eq('google_email', TARGET_EMAIL)
  .maybeSingle();

console.log('=== TIMEZONE DEBUG ===\n');
console.log('Scopes stored:', JSON.stringify(acct?.scopes));

// Refresh token
const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: acct!.refresh_token,
  }),
});

const refreshData = await refreshResp.json();
if (!refreshResp.ok) {
  console.error('Refresh failed:', refreshData);
  Deno.exit(1);
}

const accessToken = refreshData.access_token;
console.log('Access token obtained\n');

// ─── Test 1: Calendar settings/timezone endpoint (what nest-onboard uses) ───
console.log('--- Test 1: GET /users/me/settings/timezone ---');
const tzResp = await fetch('https://www.googleapis.com/calendar/v3/users/me/settings/timezone', {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log(`Status: ${tzResp.status}`);
const tzBody = await tzResp.text();
console.log(`Raw body: ${tzBody}`);
if (tzResp.ok) {
  try {
    const parsed = JSON.parse(tzBody);
    console.log(`Parsed value: "${parsed.value}"`);
  } catch {
    console.log('(could not parse as JSON)');
  }
}

// ─── Test 2: All calendar settings ──────────────────────────────────────────
console.log('\n--- Test 2: GET /users/me/settings (all settings) ---');
const allResp = await fetch('https://www.googleapis.com/calendar/v3/users/me/settings', {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log(`Status: ${allResp.status}`);
if (allResp.ok) {
  const allBody = await allResp.json();
  const tzSetting = allBody.items?.find((i: { id: string }) => i.id === 'timezone');
  console.log(`Timezone setting: ${JSON.stringify(tzSetting)}`);
  const allIds = allBody.items?.map((i: { id: string }) => i.id) ?? [];
  console.log(`All setting IDs: ${allIds.join(', ')}`);
} else {
  const errBody = await allResp.text();
  console.log(`Error: ${errBody.slice(0, 300)}`);
}

// ─── Test 3: Primary calendar metadata ──────────────────────────────────────
console.log('\n--- Test 3: GET /calendars/primary ---');
const calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log(`Status: ${calResp.status}`);
if (calResp.ok) {
  const calBody = await calResp.json();
  console.log(`Calendar timeZone: "${calBody.timeZone}"`);
  console.log(`Calendar summary: "${calBody.summary}"`);
} else {
  const errBody = await calResp.text();
  console.log(`Error: ${errBody.slice(0, 300)}`);
}

// ─── Test 4: CalendarList primary entry ─────────────────────────────────────
console.log('\n--- Test 4: GET /users/me/calendarList/primary ---');
const clResp = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', {
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log(`Status: ${clResp.status}`);
if (clResp.ok) {
  const clBody = await clResp.json();
  console.log(`CalendarList timeZone: "${clBody.timeZone}"`);
} else {
  const errBody = await clResp.text();
  console.log(`Error: ${errBody.slice(0, 300)}`);
}

// ─── Test 5: Check granted scopes on this token ────────────────────────────
console.log('\n--- Test 5: Token info (granted scopes) ---');
const tokenInfoResp = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`);
if (tokenInfoResp.ok) {
  const tokenInfo = await tokenInfoResp.json();
  console.log(`Granted scopes: ${tokenInfo.scope}`);
  const scopes = (tokenInfo.scope ?? '').split(' ');
  const hasCalendar = scopes.some((s: string) => s.includes('calendar'));
  const hasCalendarSettings = scopes.some((s: string) => s.includes('calendar.settings'));
  const hasCalendarReadonly = scopes.some((s: string) => s.includes('calendar.readonly'));
  console.log(`Has calendar scope: ${hasCalendar}`);
  console.log(`Has calendar.readonly: ${hasCalendarReadonly}`);
  console.log(`Has calendar.settings.readonly: ${hasCalendarSettings}`);
} else {
  console.log(`Token info failed: ${tokenInfoResp.status}`);
}

console.log('\n=== DONE ===');
Deno.exit(0);
