/**
 * End-to-end test of Google Maps tool functions used by Nest chat.
 * Run: npx tsx scripts/test-nest-chat.ts
 *
 * Tests executeTravelTime and executePlacesSearch with 30 diverse scenarios
 * covering easy, medium, hard, and edge cases.
 *
 * Requires GOOGLE_MAPS_API_KEY in .env
 */

import 'dotenv/config';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error('❌ GOOGLE_MAPS_API_KEY not set in .env');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// Inline the same API functions used by client.ts
// ═══════════════════════════════════════════════════════════════

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';
const TIMEOUT_MS = 12_000;

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

const MODE_MAP: Record<string, string> = { driving: 'DRIVE', walking: 'WALK', bicycling: 'BICYCLE', transit: 'TRANSIT' };

// Direction simplifier — strips compass directions
const HEAD_TOWARD_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+(on\s+.+?)\s*(toward\s+.+)?$/i;
const HEAD_ON_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+on\s+/i;
const HEAD_COMPASS_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s*/i;

function simplifyDirection(instruction: string): string {
  if (!instruction) return instruction;
  const headToward = instruction.match(HEAD_TOWARD_RE);
  if (headToward) {
    const onPart = headToward[2];
    const towardPart = headToward[3] ?? '';
    return `Start ${onPart}${towardPart ? ' ' + towardPart : ''}`.trim();
  }
  if (HEAD_ON_RE.test(instruction)) return instruction.replace(HEAD_ON_RE, 'Start on ');
  if (HEAD_COMPASS_RE.test(instruction)) return instruction.replace(HEAD_COMPASS_RE, 'Go straight ').trim();
  return instruction;
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTransitRoutes(routes: any[], origin: string, destination: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options = routes.slice(0, 3).map((route: any, idx: number) => {
    const leg = route.legs?.[0];
    if (!leg) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const option: any = {
      option: idx + 1,
      duration: route.localizedValues?.duration?.text ?? leg.localizedValues?.duration?.text,
      duration_seconds: leg.duration ? parseInt(String(leg.duration).replace('s', ''), 10) : undefined,
    };
    const advisory = route.travelAdvisory;
    if (advisory?.transitFare) {
      const fare = advisory.transitFare;
      option.fare = `${fare.currencyCode} ${(parseInt(fare.units ?? '0', 10) + (fare.nanos ?? 0) / 1e9).toFixed(2)}`;
    }
    if (route.localizedValues?.transitFare?.text) option.fare = route.localizedValues.transitFare.text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transitSteps = (leg.steps ?? []).filter((s: any) => s.travelMode === 'TRANSIT' || s.travelMode === 'WALK').slice(0, 10).map((s: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const step: any = { mode: s.travelMode === 'WALK' ? 'walking' : 'transit' };
      if (s.localizedValues) { step.distance = s.localizedValues.distance?.text; step.duration = s.localizedValues.staticDuration?.text; }
      if (s.navigationInstruction?.instructions) step.instruction = simplifyDirection(s.navigationInstruction.instructions);
      if (s.transitDetails) {
        const td = s.transitDetails;
        const line = td.transitLine;
        if (line) { step.line_name = line.nameShort || line.name; step.line_full_name = line.name; if (line.vehicle) { step.vehicle_type = line.vehicle.type?.toLowerCase(); } if (line.agencies?.length) step.agency = line.agencies[0].name; }
        step.num_stops = td.stopCount;
        if (td.stopDetails) {
          step.departure_stop = td.stopDetails.departureStop?.name;
          step.arrival_stop = td.stopDetails.arrivalStop?.name;
          if (td.stopDetails.departureTime) step.departs_at = td.localizedValues?.departureTime?.time?.text ?? td.stopDetails.departureTime;
          if (td.stopDetails.arrivalTime) step.arrives_at = td.localizedValues?.arrivalTime?.time?.text ?? td.stopDetails.arrivalTime;
        }
        if (td.headsign) step.direction = td.headsign;
      }
      return step;
    });
    if (transitSteps.length) option.legs = transitSteps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstTransit = transitSteps.find((s: any) => s.mode === 'transit');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastTransit = [...transitSteps].reverse().find((s: any) => s.mode === 'transit');
    if (firstTransit?.departs_at) option.depart_at = firstTransit.departs_at;
    if (lastTransit?.arrives_at) option.arrive_at = lastTransit.arrives_at;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstWalk = transitSteps.find((s: any) => s.mode === 'walking');
    if (firstWalk) option.walk_to_station = { duration: firstWalk.duration, distance: firstWalk.distance };
    return option;
  }).filter(Boolean);
  return { mode: 'transit', origin, destination, options };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTravelTime(input: Record<string, any>): Promise<any> {
  const origin = input.origin as string;
  const destination = input.destination as string;
  const mode = input.mode ?? 'driving';
  const travelMode = MODE_MAP[mode] ?? 'DRIVE';
  const isTransit = travelMode === 'TRANSIT';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = { origin: { address: origin }, destination: { address: destination }, travelMode };

  if (isTransit) {
    body.computeAlternativeRoutes = true;
    if (input.transit_preference === 'less_walking') body.transitPreferences = { routingPreference: 'LESS_WALKING' };
    if (input.transit_preference === 'fewer_transfers') body.transitPreferences = { routingPreference: 'FEWER_TRANSFERS' };
    if (input.allowed_transit_modes?.length) {
      body.transitPreferences = { ...(body.transitPreferences ?? {}), allowedTravelModes: input.allowed_transit_modes.map((m: string) => m.toUpperCase()) };
    }
  } else if (travelMode === 'DRIVE') {
    body.routingPreference = 'TRAFFIC_AWARE';
  }

  const fieldMask = isTransit ? TRANSIT_FIELD_MASK : DRIVE_FIELD_MASK;
  const resp = await fetchWithTimeout(ROUTES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY!, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await resp.json();
  if (data.error) return { error: data.error.message };
  if (!data.routes?.length) return { error: `No ${mode} routes found.` };
  if (isTransit) return parseTransitRoutes(data.routes, origin, destination);

  const route = data.routes[0];
  const leg = route.legs?.[0];
  const locValues = route.localizedValues ?? leg?.localizedValues;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = { origin, destination, distance: locValues?.distance?.text, duration: locValues?.duration?.text, mode };
  const durationSec = route.duration ? parseInt(String(route.duration).replace('s', ''), 10) : undefined;
  if (durationSec) result.duration_seconds = durationSec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (leg?.steps ?? []).slice(0, 5).map((s: any) => ({ instruction: simplifyDirection(s.navigationInstruction?.instructions ?? ''), distance: s.localizedValues?.distance?.text, duration: s.localizedValues?.staticDuration?.text })).filter((s: any) => s.instruction);
  if (steps.length) result.route_summary = steps;
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executePlacesSearch(input: Record<string, any>): Promise<any> {
  const query = input.query as string | undefined;
  const placeId = input.place_id as string | undefined;

  if (placeId) {
    const fieldMask = ['displayName', 'formattedAddress', 'rating', 'userRatingCount', 'priceLevel', 'types', 'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'currentOpeningHours', 'editorialSummary', 'reviews', 'googleMapsUri', 'adrFormatAddress'].join(',');
    const resp = await fetchWithTimeout(`${PLACES_DETAIL_API}/${placeId}`, { headers: { 'X-Goog-Api-Key': API_KEY!, 'X-Goog-FieldMask': fieldMask } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await resp.json();
    if (p.error) return { error: p.error.message };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = { name: p.displayName?.text, address: p.formattedAddress, google_maps_url: p.googleMapsUri };
    if (p.rating) result.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
    if (p.nationalPhoneNumber) result.phone = p.nationalPhoneNumber;
    if (p.internationalPhoneNumber) result.international_phone = p.internationalPhoneNumber;
    if (p.websiteUri) result.website = p.websiteUri;
    if (p.editorialSummary?.text) result.summary = p.editorialSummary.text;
    if (p.currentOpeningHours) { result.open_now = p.currentOpeningHours.openNow; if (p.currentOpeningHours.weekdayDescriptions?.length) result.hours = p.currentOpeningHours.weekdayDescriptions; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (p.reviews?.length) result.top_reviews = p.reviews.slice(0, 3).map((r: any) => ({ rating: r.rating, text: r.text?.text?.slice(0, 200), time: r.relativePublishTimeDescription }));
    return result;
  }

  const maxResults = Math.min(input.max_results ?? 5, 10);
  const locationBias = input.location as string | undefined;
  const textQuery = locationBias ? `${query} near ${locationBias}` : query!;
  const fieldMask = ['places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.types', 'places.websiteUri', 'places.nationalPhoneNumber', 'places.currentOpeningHours', 'places.editorialSummary', 'places.googleMapsUri', 'places.id'].join(',');
  const resp = await fetchWithTimeout(PLACES_TEXT_SEARCH_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY!, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify({ textQuery, maxResultCount: maxResults, languageCode: 'en' }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await resp.json();
  if (data.error) return { error: data.error.message };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const places = (data.places ?? []).map((p: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = { name: p.displayName?.text, address: p.formattedAddress, place_id: p.id, google_maps_url: p.googleMapsUri };
    if (p.rating) r.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
    if (p.priceLevel) r.price_level = p.priceLevel;
    if (p.nationalPhoneNumber) r.phone = p.nationalPhoneNumber;
    if (p.websiteUri) r.website = p.websiteUri;
    if (p.editorialSummary?.text) r.summary = p.editorialSummary.text;
    if (p.currentOpeningHours?.openNow !== undefined) r.open_now = p.currentOpeningHours.openNow;
    return r;
  });
  return { results: places, count: places.length };
}

// ═══════════════════════════════════════════════════════════════
// Test definitions
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  id: number;
  category: string;
  description: string;
  tool: 'travel_time' | 'places_search';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate: (result: any) => string | null; // returns null on pass, error message on fail
}

const TESTS: TestCase[] = [
  // ═══════════════════════════════════════════════════════════════
  // EASY (1-6) — Basic driving, walking, simple place searches
  // ═══════════════════════════════════════════════════════════════
  {
    id: 1, category: 'EASY', description: 'Driving: Melbourne CBD → Airport',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'Melbourne Airport', mode: 'driving' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : (!r.distance ? 'No distance' : null)),
  },
  {
    id: 2, category: 'EASY', description: 'Walking: Flinders St → Southern Cross',
    tool: 'travel_time',
    input: { origin: 'Flinders Street Station Melbourne', destination: 'Southern Cross Station Melbourne', mode: 'walking' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : null),
  },
  {
    id: 3, category: 'EASY', description: 'Places: coffee in Melbourne CBD',
    tool: 'places_search',
    input: { query: 'best coffee in Melbourne CBD', max_results: 3 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : (!r.results[0].name ? 'No name' : null)),
  },
  {
    id: 4, category: 'EASY', description: 'Places: restaurants near Federation Square',
    tool: 'places_search',
    input: { query: 'restaurants near Federation Square Melbourne', max_results: 3 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 5, category: 'EASY', description: 'Bicycling: Fed Square → St Kilda Beach',
    tool: 'travel_time',
    input: { origin: 'Federation Square Melbourne', destination: 'St Kilda Beach Melbourne', mode: 'bicycling' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : null),
  },
  {
    id: 6, category: 'EASY', description: 'Places: pharmacies Melbourne CBD',
    tool: 'places_search',
    input: { query: 'pharmacy in Melbourne CBD', max_results: 3 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },

  // ═══════════════════════════════════════════════════════════════
  // MEDIUM (7-12) — Transit, location-biased, specific places
  // ═══════════════════════════════════════════════════════════════
  {
    id: 7, category: 'MEDIUM', description: 'Transit: Flinders St → Caulfield',
    tool: 'travel_time',
    input: { origin: 'Flinders Street Station Melbourne', destination: 'Caulfield Station Melbourne', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : (!r.options[0].duration ? 'No duration in option' : null)),
  },
  {
    id: 8, category: 'MEDIUM', description: 'Transit: CBD → St Kilda (tram)',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'St Kilda Melbourne', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },
  {
    id: 9, category: 'MEDIUM', description: 'Places: italian restaurants South Yarra',
    tool: 'places_search',
    input: { query: 'italian restaurants', location: 'South Yarra Melbourne', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 10, category: 'MEDIUM', description: 'Places: Lune Croissanterie (specific)',
    tool: 'places_search',
    input: { query: 'Lune Croissanterie Melbourne' },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : (!r.results[0].name?.toLowerCase().includes('lune') ? 'Wrong place' : null)),
  },
  {
    id: 11, category: 'MEDIUM', description: 'Driving: Melbourne → Geelong',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'Geelong Victoria', mode: 'driving' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : (r.duration_seconds < 2400 ? 'Suspiciously fast' : null)),
  },
  {
    id: 12, category: 'MEDIUM', description: 'Places: brunch spots Fitzroy',
    tool: 'places_search',
    input: { query: 'best brunch in Fitzroy Melbourne', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },

  // ═══════════════════════════════════════════════════════════════
  // MEDIUM-HARD (13-18) — Longer routes, transit details, place details
  // ═══════════════════════════════════════════════════════════════
  {
    id: 13, category: 'MEDIUM-HARD', description: 'Walking: Melbourne Museum → Botanic Gardens',
    tool: 'travel_time',
    input: { origin: 'Melbourne Museum', destination: 'Royal Botanic Gardens Melbourne', mode: 'walking' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : null),
  },
  {
    id: 14, category: 'MEDIUM-HARD', description: 'Transit: CBD → Chadstone',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'Chadstone Shopping Centre Melbourne', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },
  {
    id: 15, category: 'MEDIUM-HARD', description: 'Places: thai restaurants Richmond',
    tool: 'places_search',
    input: { query: 'thai restaurant in Richmond Melbourne', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 16, category: 'MEDIUM-HARD', description: 'Transit: Airport → St Kilda',
    tool: 'travel_time',
    input: { origin: 'Melbourne Airport', destination: 'St Kilda Melbourne', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },
  {
    id: 17, category: 'MEDIUM-HARD', description: 'Places: japanese restaurant CBD',
    tool: 'places_search',
    input: { query: 'highly rated japanese restaurant Melbourne CBD', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 18, category: 'MEDIUM-HARD', description: 'Driving: Melbourne → Ballarat',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'Ballarat Victoria', mode: 'driving' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : (r.duration_seconds < 3600 ? 'Suspiciously fast for Ballarat' : null)),
  },

  // ═══════════════════════════════════════════════════════════════
  // HARD (19-24) — Complex transit, place details with reviews
  // ═══════════════════════════════════════════════════════════════
  {
    id: 19, category: 'HARD', description: 'Transit: Southern Cross → Monash Clayton',
    tool: 'travel_time',
    input: { origin: 'Southern Cross Station Melbourne', destination: 'Monash University Clayton Campus', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },
  {
    id: 20, category: 'HARD', description: 'Places: bars Collingwood (detailed)',
    tool: 'places_search',
    input: { query: 'best bars in Collingwood Melbourne', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : (!r.results[0].rating ? 'No rating' : null)),
  },
  {
    id: 21, category: 'HARD', description: 'Walking: Richmond → MCG (short walk)',
    tool: 'travel_time',
    input: { origin: 'Richmond Station Melbourne', destination: 'Melbourne Cricket Ground', mode: 'walking' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : (r.duration_seconds > 3600 ? 'Too long for this walk' : null)),
  },
  {
    id: 22, category: 'HARD', description: 'Places: barber Chapel St (niche)',
    tool: 'places_search',
    input: { query: 'barber shop near Chapel Street South Yarra', max_results: 3 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 23, category: 'HARD', description: 'Bicycling: Brunswick → St Kilda',
    tool: 'travel_time',
    input: { origin: 'Brunswick Melbourne', destination: 'St Kilda Beach Melbourne', mode: 'bicycling' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : null),
  },
  {
    id: 24, category: 'HARD', description: 'Transit: Werribee → City (long commute)',
    tool: 'travel_time',
    input: { origin: 'Werribee Station', destination: 'Flinders Street Station Melbourne', mode: 'transit' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },

  // ═══════════════════════════════════════════════════════════════
  // EDGE CASES (25-30) — Long distance, ambiguous, details lookup
  // ═══════════════════════════════════════════════════════════════
  {
    id: 25, category: 'EDGE', description: 'Driving: Sydney → Melbourne (long)',
    tool: 'travel_time',
    input: { origin: 'Sydney NSW', destination: 'Melbourne VIC', mode: 'driving' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : (r.duration_seconds < 18000 ? 'Suspiciously fast Syd→Melb' : null)),
  },
  {
    id: 26, category: 'EDGE', description: 'Places: gym near Flinders St',
    tool: 'places_search',
    input: { query: 'gym near Flinders Street Station Melbourne', max_results: 3 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 27, category: 'EDGE', description: 'Driving: Melbourne → Great Ocean Road',
    tool: 'travel_time',
    input: { origin: 'Melbourne CBD', destination: 'Great Ocean Road Victoria', mode: 'driving' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.duration ? 'No duration' : null),
  },
  {
    id: 28, category: 'EDGE', description: 'Places: pizza Carlton',
    tool: 'places_search',
    input: { query: 'best pizza in Carlton Melbourne', max_results: 5 },
    validate: r => r.error ? `Error: ${r.error}` : (r.count < 1 ? 'No results' : null),
  },
  {
    id: 29, category: 'EDGE', description: 'Transit: fewer transfers preference',
    tool: 'travel_time',
    input: { origin: 'Melbourne Airport', destination: 'Caulfield Station Melbourne', mode: 'transit', transit_preference: 'fewer_transfers' },
    validate: r => r.error ? `Error: ${r.error}` : (!r.options?.length ? 'No transit options' : null),
  },
  {
    id: 30, category: 'EDGE', description: 'Place detail by ID (from prior search)',
    tool: 'places_search',
    input: { place_id: '__DYNAMIC__' }, // Will be filled from test #3 results
    validate: r => r.error ? `Error: ${r.error}` : (!r.name ? 'No name in detail' : (!r.rating ? 'No rating in detail' : null)),
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
let savedPlaceId: string | null = null;

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  NEST — Google Maps Tool Tests (${TESTS.length} tests)`);
  console.log(`${'═'.repeat(70)}\n`);

  for (const test of TESTS) {
    const start = Date.now();
    let input = test.input;

    // Dynamic place_id for test 30
    if (test.id === 30 && input.place_id === '__DYNAMIC__') {
      if (savedPlaceId) {
        input = { ...input, place_id: savedPlaceId };
      } else {
        input = { ...input, place_id: 'ChIJP3Sa8ziYEmsRUKgyFmh9AQM' }; // Melbourne fallback
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      if (test.tool === 'travel_time') {
        result = await executeTravelTime(input);
      } else {
        result = await executePlacesSearch(input);
      }

      // Save a place_id for later use
      if (test.id === 3 && result.results?.length) {
        savedPlaceId = result.results[0].place_id;
      }

      const elapsed = Date.now() - start;
      const error = test.validate(result);
      const json = JSON.stringify(result);
      const preview = json.length > 200 ? json.substring(0, 200) + '...' : json;

      if (error) {
        failed++;
        console.log(`❌ #${test.id} [${test.category}] ${test.description} (${elapsed}ms)`);
        console.log(`   FAIL: ${error}`);
        console.log(`   Data: ${preview}`);
      } else {
        passed++;
        console.log(`✅ #${test.id} [${test.category}] ${test.description} (${elapsed}ms)`);
        // Print key data points
        if (test.tool === 'travel_time') {
          if (result.mode === 'transit') {
            const opt = result.options?.[0];
            console.log(`   ${result.options.length} option(s) — ${opt?.duration ?? '?'}`);
            const transitLeg = opt?.legs?.find((l: any) => l.mode === 'transit');
            if (transitLeg) console.log(`   Line: ${transitLeg.line_name ?? '?'}, Stops: ${transitLeg.num_stops ?? '?'}`);
          } else {
            console.log(`   ${result.distance ?? '?'}, ${result.duration ?? '?'}`);
            if (result.route_summary?.length) {
              for (const step of result.route_summary.slice(0, 3)) {
                console.log(`   → ${step.instruction} (${step.distance ?? '?'})`);
              }
            }
          }
        } else {
          if (result.results) {
            for (const p of result.results.slice(0, 2)) {
              console.log(`   ${p.name} — ${p.rating ?? 'no rating'}${p.open_now !== undefined ? (p.open_now ? ' (open)' : ' (closed)') : ''}`);
            }
          } else if (result.name) {
            console.log(`   ${result.name} — ${result.rating ?? 'no rating'}`);
            if (result.phone) console.log(`   Phone: ${result.phone}`);
            if (result.top_reviews?.length) console.log(`   Reviews: ${result.top_reviews.length}`);
          }
        }
      }
    } catch (e) {
      const elapsed = Date.now() - start;
      failed++;
      console.log(`❌ #${test.id} [${test.category}] ${test.description} (${elapsed}ms)`);
      console.log(`   ERROR: ${(e as Error).message}`);
    }

    console.log('');
  }

  // Summary
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed out of ${TESTS.length}`);
  console.log(`${'═'.repeat(70)}`);

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
