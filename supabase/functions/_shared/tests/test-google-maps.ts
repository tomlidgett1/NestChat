/**
 * Test suite for Google Maps tools: places_search and travel_time.
 * Run: deno run --allow-all --env=.env supabase/functions/_shared/tests/test-google-maps.ts
 */

const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';
const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';
const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(label);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 1: API key is configured
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 1: API Key Configuration ═══');
assert(GOOGLE_MAPS_API_KEY.length > 0, 'GOOGLE_MAPS_API_KEY is set');
assert(GOOGLE_MAPS_API_KEY.startsWith('AIza'), 'API key has correct prefix');

if (!GOOGLE_MAPS_API_KEY) {
  console.error('\n🛑 No API key — cannot continue. Set GOOGLE_MAPS_API_KEY in .env');
  Deno.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// Test 2: Places Text Search — basic query
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 2: Places Text Search — "best coffee in Melbourne CBD" ═══');
{
  const fieldMask = [
    'places.displayName', 'places.formattedAddress', 'places.rating',
    'places.userRatingCount', 'places.googleMapsUri', 'places.id',
    'places.websiteUri', 'places.nationalPhoneNumber', 'places.editorialSummary',
    'places.currentOpeningHours',
  ].join(',');

  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'best coffee in Melbourne CBD', maxResultCount: 5, languageCode: 'en' }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(Array.isArray(data.places), 'Response contains places array');
  assert((data.places?.length ?? 0) > 0, `Found ${data.places?.length ?? 0} places`);

  if (data.places?.length > 0) {
    const p = data.places[0];
    assert(!!p.displayName?.text, `First result has name: "${p.displayName?.text}"`);
    assert(!!p.formattedAddress, 'First result has address');
    assert(typeof p.rating === 'number', `First result has rating: ${p.rating}`);
    assert(!!p.googleMapsUri, 'First result has Google Maps URL');
    assert(!!p.id, `First result has place_id: ${p.id}`);

    // Save place_id for detail test
    globalThis.__testPlaceId = p.id;
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 3: Places Text Search — location-biased query
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 3: Places Text Search — "restaurants near Federation Square" ═══');
{
  const fieldMask = 'places.displayName,places.formattedAddress,places.rating,places.id,places.priceLevel';

  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'restaurants near Federation Square Melbourne', maxResultCount: 3, languageCode: 'en' }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert((data.places?.length ?? 0) > 0, `Found ${data.places?.length ?? 0} restaurants`);

  if (data.places?.length > 0) {
    const names = data.places.map((p: { displayName?: { text?: string } }) => p.displayName?.text).join(', ');
    console.log(`    Results: ${names}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 4: Place Details — full info + reviews
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 4: Place Details ═══');
{
  // deno-lint-ignore no-explicit-any
  const placeId = (globalThis as any).__testPlaceId ?? 'ChIJP3Sa8ziYEmsRUKgyFmh9AQM';
  const fieldMask = [
    'displayName', 'formattedAddress', 'rating', 'userRatingCount',
    'websiteUri', 'nationalPhoneNumber', 'currentOpeningHours',
    'editorialSummary', 'reviews', 'googleMapsUri',
  ].join(',');

  const resp = await fetch(`${PLACES_DETAIL_API}/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(!!data.displayName?.text, `Place name: "${data.displayName?.text}"`);
  assert(!!data.formattedAddress, 'Has address');
  assert(typeof data.rating === 'number', `Rating: ${data.rating}/5`);
  assert(data.currentOpeningHours !== undefined, 'Has opening hours data');
  assert(Array.isArray(data.reviews), `Has ${data.reviews?.length ?? 0} reviews`);

  if (data.reviews?.length > 0) {
    console.log(`    Top review: "${data.reviews[0].text?.text?.slice(0, 80)}..."`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 5: Travel Time — Driving
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 5: Travel Time — Driving (Melbourne CBD → Airport) ═══');
{
  const fieldMask = [
    'routes.duration', 'routes.distanceMeters', 'routes.localizedValues',
    'routes.legs.duration', 'routes.legs.distanceMeters', 'routes.legs.localizedValues',
    'routes.legs.steps.navigationInstruction', 'routes.legs.steps.localizedValues',
  ].join(',');

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { address: 'Melbourne CBD' },
      destination: { address: 'Melbourne Airport' },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(Array.isArray(data.routes) && data.routes.length > 0, 'Has route(s)');

  if (data.routes?.length > 0) {
    const route = data.routes[0];
    const duration = route.localizedValues?.duration?.text ?? route.legs?.[0]?.localizedValues?.duration?.text;
    const distance = route.localizedValues?.distance?.text ?? route.legs?.[0]?.localizedValues?.distance?.text;
    assert(!!duration, `Duration: ${duration}`);
    assert(!!distance, `Distance: ${distance}`);
    console.log(`    Route: ${duration}, ${distance}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 6: Travel Time — Transit
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 6: Travel Time — Transit (Flinders St → Caulfield) ═══');
{
  const fieldMask = [
    'routes.legs.duration', 'routes.legs.steps.transitDetails',
    'routes.legs.steps.travelMode', 'routes.legs.steps.localizedValues',
    'routes.legs.steps.navigationInstruction', 'routes.legs.stepsOverview',
    'routes.localizedValues', 'routes.travelAdvisory', 'routes.legs.localizedValues',
  ].join(',');

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { address: 'Flinders Street Station, Melbourne' },
      destination: { address: 'Caulfield Station, Melbourne' },
      travelMode: 'TRANSIT',
      computeAlternativeRoutes: true,
    }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(Array.isArray(data.routes) && data.routes.length > 0, `Found ${data.routes?.length ?? 0} transit route(s)`);

  if (data.routes?.length > 0) {
    const route = data.routes[0];
    const leg = route.legs?.[0];
    const duration = route.localizedValues?.duration?.text ?? leg?.localizedValues?.duration?.text;
    assert(!!duration, `Duration: ${duration}`);

    const transitSteps = (leg?.steps ?? []).filter((s: { travelMode?: string }) => s.travelMode === 'TRANSIT');
    assert(transitSteps.length > 0, `Found ${transitSteps.length} transit step(s)`);

    if (transitSteps.length > 0) {
      const td = transitSteps[0].transitDetails;
      if (td?.transitLine) {
        console.log(`    Line: ${td.transitLine.nameShort ?? td.transitLine.name}`);
      }
      if (td?.stopDetails) {
        console.log(`    From: ${td.stopDetails.departureStop?.name} → ${td.stopDetails.arrivalStop?.name}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 7: Travel Time — Walking
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 7: Travel Time — Walking (Federation Square → South Yarra) ═══');
{
  const fieldMask = 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.localizedValues';

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { address: 'Federation Square, Melbourne' },
      destination: { address: 'South Yarra Station, Melbourne' },
      travelMode: 'WALK',
    }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(data.routes?.length > 0, 'Has walking route');

  if (data.routes?.length > 0) {
    const route = data.routes[0];
    const duration = route.localizedValues?.duration?.text;
    const distance = route.localizedValues?.distance?.text;
    console.log(`    Walk: ${duration}, ${distance}`);
    assert(!!duration, `Duration: ${duration}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 8: Places Search — specific business lookup
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 8: Places Search — specific business "Higher Ground Melbourne" ═══');
{
  const fieldMask = 'places.displayName,places.formattedAddress,places.rating,places.nationalPhoneNumber,places.websiteUri,places.id';

  const resp = await fetch(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: 'Higher Ground Melbourne', maxResultCount: 1, languageCode: 'en' }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(data.places?.length > 0, 'Found the business');

  if (data.places?.length > 0) {
    const p = data.places[0];
    console.log(`    Name: ${p.displayName?.text}`);
    console.log(`    Address: ${p.formattedAddress}`);
    console.log(`    Phone: ${p.nationalPhoneNumber ?? 'N/A'}`);
    console.log(`    Website: ${p.websiteUri ?? 'N/A'}`);
    assert(!!p.nationalPhoneNumber || !!p.websiteUri, 'Has phone or website');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 9: Travel Time — Bicycling
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 9: Travel Time — Bicycling (St Kilda → Richmond) ═══');
{
  const fieldMask = 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.localizedValues';

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { address: 'St Kilda Beach, Melbourne' },
      destination: { address: 'Richmond Station, Melbourne' },
      travelMode: 'BICYCLE',
    }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(data.routes?.length > 0, 'Has cycling route');

  if (data.routes?.length > 0) {
    const route = data.routes[0];
    const duration = route.localizedValues?.duration?.text;
    const distance = route.localizedValues?.distance?.text;
    console.log(`    Cycle: ${duration}, ${distance}`);
    assert(!!duration, `Duration: ${duration}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 10: Edge case — invalid/empty query
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 10: Edge Case — empty/invalid inputs ═══');
{
  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration',
    },
    body: JSON.stringify({
      origin: { address: '' },
      destination: { address: '' },
      travelMode: 'DRIVE',
    }),
  });

  const data = await resp.json();
  assert(!!data.error || data.routes?.length === 0, 'Empty addresses handled gracefully (error or no routes)');
}

// ═══════════════════════════════════════════════════════════════
// Test 11: Transit with arrival_time
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Test 11: Transit with arrival time ═══');
{
  const tomorrow9am = new Date();
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);

  const fieldMask = [
    'routes.legs.duration', 'routes.legs.steps.transitDetails',
    'routes.legs.steps.travelMode', 'routes.localizedValues',
    'routes.travelAdvisory',
  ].join(',');

  const resp = await fetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { address: 'Southern Cross Station, Melbourne' },
      destination: { address: 'Melbourne Airport' },
      travelMode: 'TRANSIT',
      arrivalTime: tomorrow9am.toISOString(),
      computeAlternativeRoutes: true,
    }),
  });

  assert(resp.ok, `API responded OK (${resp.status})`);
  const data = await resp.json();
  assert(!data.error, 'No API error', data.error?.message);
  assert(data.routes?.length > 0, `Found ${data.routes?.length ?? 0} route(s) with arrival time`);

  if (data.routes?.length > 0) {
    const route = data.routes[0];
    const fare = route.travelAdvisory?.transitFare;
    if (fare) {
      console.log(`    Fare: ${fare.currencyCode} ${fare.units}`);
      assert(true, 'Fare data available');
    } else {
      console.log('    No fare data (may not be available for this route)');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════');
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('═══════════════════════════════════════════════════\n');

Deno.exit(failed > 0 ? 1 : 0);
