/**
 * Test script for Google Maps API integration (Routes API v2 + Places API New).
 * Run: npx tsx scripts/test-maps.ts
 *
 * Requires GOOGLE_MAPS_API_KEY in .env
 */

import 'dotenv/config';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error('❌ GOOGLE_MAPS_API_KEY not set in .env');
  process.exit(1);
}

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';

const TRANSIT_FIELD_MASK = [
  'routes.legs.duration', 'routes.legs.steps.transitDetails',
  'routes.legs.steps.startLocation', 'routes.legs.steps.endLocation',
  'routes.legs.steps.travelMode', 'routes.legs.steps.localizedValues',
  'routes.legs.steps.navigationInstruction', 'routes.legs.stepsOverview',
  'routes.localizedValues', 'routes.travelAdvisory', 'routes.legs.localizedValues',
].join(',');

const DRIVE_FIELD_MASK = [
  'routes.duration', 'routes.distanceMeters', 'routes.localizedValues',
  'routes.legs.duration', 'routes.legs.distanceMeters', 'routes.legs.localizedValues',
  'routes.legs.steps.navigationInstruction', 'routes.legs.steps.localizedValues',
].join(',');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`❌ ${name}: ${(e as Error).message}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function routesRequest(travelMode: string, origin: string, destination: string, extra: Record<string, unknown> = {}) {
  const isTransit = travelMode === 'TRANSIT';
  const isDrive = travelMode === 'DRIVE';
  const body: Record<string, unknown> = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode,
    ...extra,
  };
  if (isDrive) body.routingPreference = 'TRAFFIC_AWARE';
  if (isTransit) body.computeAlternativeRoutes = true;

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': isTransit ? TRANSIT_FIELD_MASK : DRIVE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function main() {

// ═══════════════════════════════════════════════════════════════
// Routes API v2 — all travel modes
// ═══════════════════════════════════════════════════════════════

await test('Driving (Routes API): Melbourne CBD → Melbourne Airport', async () => {
  const data = await routesRequest('DRIVE', 'Melbourne CBD', 'Melbourne Airport');
  assert(!data.error, `API error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  assert(data.routes?.length > 0, 'No routes returned');
  const loc = data.routes[0].localizedValues;
  console.log(`   ${loc?.distance?.text}, ${loc?.duration?.text}`);
});

await test('Walking (Routes API): Melbourne CBD → South Yarra', async () => {
  const data = await routesRequest('WALK', 'Melbourne CBD', 'South Yarra');
  assert(!data.error, `API error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  assert(data.routes?.length > 0, 'No routes returned');
  const loc = data.routes[0].localizedValues;
  console.log(`   ${loc?.distance?.text}, ${loc?.duration?.text}`);
});

await test('Bicycling (Routes API): Federation Square → St Kilda Beach', async () => {
  const data = await routesRequest('BICYCLE', 'Federation Square Melbourne', 'St Kilda Beach Melbourne');
  assert(!data.error, `API error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  assert(data.routes?.length > 0, 'No routes returned');
  const loc = data.routes[0].localizedValues;
  console.log(`   ${loc?.distance?.text}, ${loc?.duration?.text}`);
});

await test('Transit (Routes API): Flinders Street → Caulfield', async () => {
  const data = await routesRequest('TRANSIT', 'Flinders Street Station, Melbourne', 'Caulfield Station, Melbourne');
  assert(!data.error, `API error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  assert(data.routes?.length > 0, 'No transit routes');
  console.log(`   ${data.routes.length} route option(s)`);
  const leg = data.routes[0].legs?.[0];
  if (leg) {
    const duration = data.routes[0].localizedValues?.duration?.text ?? leg.localizedValues?.duration?.text;
    console.log(`   Duration: ${duration}`);
    const transitSteps = (leg.steps ?? []).filter((s: any) => s.travelMode === 'TRANSIT');
    for (const s of transitSteps) {
      const line = s.transitDetails?.transitLine;
      console.log(`   Line: ${line?.nameShort || line?.name}, Stops: ${s.transitDetails?.stopCount}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Places Search tests
// ═══════════════════════════════════════════════════════════════

let savedPlaceId: string | null = null;

await test('Text Search: best coffee in Melbourne CBD', async () => {
  const fieldMask = [
    'places.displayName', 'places.formattedAddress', 'places.rating',
    'places.userRatingCount', 'places.nationalPhoneNumber',
    'places.currentOpeningHours', 'places.editorialSummary',
    'places.googleMapsUri', 'places.id',
  ].join(',');

  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'best coffee in Melbourne CBD', maxResultCount: 3, languageCode: 'en' }),
  });
  const data = await resp.json();
  assert(!data.error, `API error: ${data.error?.message}`);
  assert(data.places?.length > 0, 'No places returned');
  for (const p of data.places) {
    console.log(`   ${p.displayName?.text} — ${p.rating}/5 (${p.userRatingCount} reviews)`);
    if (!savedPlaceId && p.id) savedPlaceId = p.id;
  }
});

await test('Text Search: restaurants near Federation Square', async () => {
  const fieldMask = 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.id';
  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'restaurants near Federation Square Melbourne', maxResultCount: 3, languageCode: 'en' }),
  });
  const data = await resp.json();
  assert(!data.error, `API error: ${data.error?.message}`);
  assert(data.places?.length > 0, 'No places returned');
  console.log(`   ${data.places.length} result(s)`);
});

await test('Place Details: reviews, phone, hours', async () => {
  const placeId = savedPlaceId ?? 'ChIJP3Sa8ziYEmsRUKgyFmh9AQM';
  const fieldMask = [
    'displayName', 'formattedAddress', 'rating', 'userRatingCount',
    'nationalPhoneNumber', 'internationalPhoneNumber',
    'currentOpeningHours', 'editorialSummary', 'reviews', 'googleMapsUri',
  ].join(',');
  const resp = await fetch(`${PLACES_DETAIL_API}/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': fieldMask,
    },
  });
  const p = await resp.json();
  assert(!p.error, `API error: ${p.error?.message}`);
  console.log(`   ${p.displayName?.text} — ${p.rating}/5`);
  if (p.nationalPhoneNumber) console.log(`   Phone: ${p.nationalPhoneNumber}`);
  if (p.currentOpeningHours?.openNow !== undefined) console.log(`   Open now: ${p.currentOpeningHours.openNow}`);
  if (p.reviews?.length) {
    console.log(`   Reviews: ${p.reviews.length}`);
    const review = p.reviews[0];
    console.log(`   Top review (${review.rating}/5): "${review.text?.text?.slice(0, 80)}..."`);
  }
});

await test('Text Search: best rated coffee shop in Melbourne', async () => {
  const fieldMask = 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.id';
  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'best rated coffee shop in Melbourne', maxResultCount: 5, languageCode: 'en' }),
  });
  const data = await resp.json();
  assert(!data.error, `API error: ${data.error?.message}`);
  assert(data.places?.length > 0, 'No places returned');
  for (const p of data.places) {
    console.log(`   ${p.displayName?.text} — ${p.rating}/5 (${p.userRatingCount} reviews)`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end main

main().catch(e => { console.error(e); process.exit(1); });
