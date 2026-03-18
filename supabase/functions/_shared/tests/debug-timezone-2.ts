/**
 * Try alternative ways to get timezone with only calendar.events scope.
 * Run: deno run --allow-all --env=.env supabase/functions/_shared/tests/debug-timezone-2.ts
 */
import { getAdminClient } from '../supabase.ts';
import { getOptionalEnv } from '../env.ts';

const SENDER = '+61414187820';
const TARGET_EMAIL = 'thomas.lidgett@blacklane.com';
const GOOGLE_CLIENT_ID = getOptionalEnv('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = getOptionalEnv('GOOGLE_CLIENT_SECRET') ?? '';

const supabase = getAdminClient();
const { data: profile } = await supabase.from('user_profiles').select('auth_user_id').eq('handle', SENDER).maybeSingle();
const { data: acct } = await supabase.from('user_google_accounts').select('refresh_token').eq('user_id', profile!.auth_user_id).eq('google_email', TARGET_EMAIL).maybeSingle();

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
const { access_token: accessToken } = await refreshResp.json();
console.log('=== TIMEZONE ALTERNATIVES ===\n');

// Method 1: Get upcoming events and check their timezone
console.log('--- Method 1: Upcoming events timezone ---');
const now = new Date().toISOString();
const eventsResp = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&maxResults=5&singleEvents=true&orderBy=startTime`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
console.log(`Status: ${eventsResp.status}`);
if (eventsResp.ok) {
  const eventsBody = await eventsResp.json();
  console.log(`Calendar timeZone from events response: "${eventsBody.timeZone}"`);
  console.log(`Events found: ${eventsBody.items?.length ?? 0}`);
  for (const event of (eventsBody.items ?? []).slice(0, 3)) {
    console.log(`  Event: "${event.summary}" — start.timeZone="${event.start?.timeZone}", end.timeZone="${event.end?.timeZone}"`);
  }
} else {
  const errBody = await eventsResp.text();
  console.log(`Error: ${errBody.slice(0, 300)}`);
}

// Method 2: Get recent past events
console.log('\n--- Method 2: Recent past events ---');
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const pastResp = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${weekAgo}&timeMax=${now}&maxResults=5&singleEvents=true&orderBy=startTime`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
console.log(`Status: ${pastResp.status}`);
if (pastResp.ok) {
  const pastBody = await pastResp.json();
  console.log(`Calendar timeZone from past events response: "${pastBody.timeZone}"`);
  console.log(`Events found: ${pastBody.items?.length ?? 0}`);
  for (const event of (pastBody.items ?? []).slice(0, 3)) {
    console.log(`  Event: "${event.summary}" — start.timeZone="${event.start?.timeZone}"`);
  }
}

// Method 3: CalendarList (might work with events scope)
console.log('\n--- Method 3: CalendarList ---');
const clResp = await fetch(
  'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
console.log(`Status: ${clResp.status}`);
if (clResp.ok) {
  const clBody = await clResp.json();
  for (const cal of (clBody.items ?? []).slice(0, 5)) {
    console.log(`  Calendar: "${cal.summary}" — timeZone="${cal.timeZone}", primary=${cal.primary ?? false}`);
  }
}

console.log('\n=== DONE ===');
Deno.exit(0);
