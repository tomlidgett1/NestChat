/**
 * Test: morning briefing pipeline — location resolution + weather + message generation.
 * Usage: cd Nest && deno run --allow-all supabase/functions/_shared/tests/test-morning-briefing.ts
 */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { config } from 'https://deno.land/x/dotenv@v3.2.2/mod.ts';

config({ path: '.env', export: true });

const HANDLE = '+61414187820';

const { getAdminClient } = await import('../supabase.ts');
const { getActiveMemoryItems } = await import('../state.ts');
const { weatherTool } = await import('../tools/weather.ts');

const WEATHER_CTX = {
  chatId: '', senderHandle: HANDLE, authUserId: null, timezone: null,
  pendingEmailSend: null, pendingEmailSends: [],
};

// ── Helpers (mirrors user-automations.ts) ────────────────────────────────────

function timezoneToCity(timezone: string | null): string | null {
  if (!timezone?.includes('/')) return null;
  const parts = timezone.split('/');
  const city = parts[parts.length - 1]?.replace(/_/g, ' ').trim();
  if (!city) return null;
  const regionMap: Record<string, string> = {
    Australia: 'Australia', America: 'USA', Europe: 'Europe', Asia: 'Asia', Pacific: 'Pacific',
  };
  const country = regionMap[parts[0]];
  return country ? `${city}, ${country}` : city;
}

async function resolveWeatherLocation(handle: string, tz: string | null): Promise<string | null> {
  const mems = await getActiveMemoryItems(handle, 20);
  const loc = mems.find(m =>
    (m.category === 'location' || m.category.includes('location') || m.category === 'city') &&
    m.status === 'active'
  );
  if (loc?.valueText) {
    const raw = loc.valueText.replace(/^(lives in|home:|current location:|located in)\s*/i, '').trim();
    if (raw) return raw;
  }
  return timezoneToCity(tz);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`MORNING BRIEFING TEST — ${HANDLE}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const supabase = getAdminClient();

  // 1. User profile
  console.log('── 1. USER PROFILE ──────────────────────────────────────────');
  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('handle, name, timezone, context_profile, deep_profile_snapshot')
    .eq('handle', HANDLE)
    .maybeSingle();

  if (profileErr || !profile) {
    console.error('No profile found:', profileErr?.message);
    Deno.exit(1);
  }
  console.log(`Name: ${profile.name}`);
  console.log(`Timezone: ${profile.timezone}`);

  // Show context_profile location fields
  const ctx = profile.context_profile as Record<string, unknown> | null;
  console.log(`context_profile.currentLocation: ${JSON.stringify(ctx?.currentLocation ?? null)}`);
  console.log(`context_profile.homeLocation:    ${JSON.stringify(ctx?.homeLocation ?? null)}`);
  console.log(`context_profile.workLocation:    ${JSON.stringify(ctx?.workLocation ?? null)}`);

  // 2. Memory items — location categories
  console.log('\n── 2. LOCATION MEMORY ITEMS ─────────────────────────────────');
  const mems = await getActiveMemoryItems(HANDLE, 30);
  const locMems = mems.filter(m =>
    m.category === 'location' || m.category.includes('location') || m.category === 'city'
  );
  if (locMems.length === 0) {
    console.log('(none found)');
  } else {
    for (const m of locMems) {
      console.log(`  [${m.category}] (${m.status}) "${m.valueText}"`);
    }
  }

  // 3. Resolved weather location
  console.log('\n── 3. RESOLVED WEATHER LOCATION ─────────────────────────────');
  const weatherLocation = await resolveWeatherLocation(HANDLE, profile.timezone);
  console.log(`Result: "${weatherLocation}"`);
  if (!weatherLocation) {
    console.log('⚠️  No location resolved — weather will be skipped.');
  }

  // 4. Weather API call
  console.log('\n── 4. WEATHER API RESPONSE ──────────────────────────────────');
  if (weatherLocation) {
    const out = await weatherTool.handler(
      { location: weatherLocation, type: 'daily_forecast', days: 1 },
      WEATHER_CTX,
    );
    // deno-lint-ignore no-explicit-any
    const raw = (out.structuredData ?? JSON.parse(typeof out.content === 'string' ? out.content : '{}')) as any;
    console.log(JSON.stringify(raw, null, 2));

    if (!raw?.error) {
      const today = raw?.days?.[0];
      if (today) {
        const parts: string[] = [];
        if (today.max_temp_c !== undefined) parts.push(`${Math.round(today.max_temp_c)}°C`);
        const cond = today.daytime?.condition || today.nighttime?.condition;
        if (cond) parts.push(cond.toLowerCase());
        const rain = today.daytime?.rain_probability_percent ?? today.nighttime?.rain_probability_percent;
        if (rain !== undefined && rain > 20) parts.push(`${Math.round(rain)}% chance of rain`);
        const uv = today.daytime?.uv_index;
        if (uv !== undefined && uv >= 6) parts.push(`UV ${Math.round(uv)}`);
        console.log(`\n✅ Formatted weather summary: "${parts.join(', ')}"`);
      }
    } else {
      console.log(`\n❌ Weather API error: ${raw.error}`);
    }
  } else {
    console.log('(skipped — no location)');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('DONE');
}

main().catch(console.error);
