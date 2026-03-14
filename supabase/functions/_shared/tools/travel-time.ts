import type { ToolContract } from './types.ts';
import { getOptionalEnv } from '../env.ts';

// ═══════════════════════════════════════════════════════════════
// Constants — Routes API v2 only
// ═══════════════════════════════════════════════════════════════

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FETCH_TIMEOUT_MS = 10_000;

const TRANSIT_FIELD_MASK = [
  'routes.legs.duration',
  'routes.legs.steps.transitDetails',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.polyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.localizedValues',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.stepsOverview',
  'routes.localizedValues',
  'routes.travelAdvisory',
  'routes.legs.localizedValues',
].join(',');

const DRIVE_FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.localizedValues',
  'routes.legs.duration',
  'routes.legs.distanceMeters',
  'routes.legs.localizedValues',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.localizedValues',
].join(',');

// Maps our mode names to Routes API travelMode values
const MODE_MAP: Record<string, string> = {
  driving: 'DRIVE',
  walking: 'WALK',
  bicycling: 'BICYCLE',
  transit: 'TRANSIT',
};

// ═══════════════════════════════════════════════════════════════
// Fetch helpers
// ═══════════════════════════════════════════════════════════════

function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function retryFetch(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
        return resp;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[travel_time] ${resp.status} on attempt ${attempt + 1}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[travel_time] Error on attempt ${attempt + 1}: ${lastError.message}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError ?? new Error('retryFetch: max attempts exceeded');
}

// ═══════════════════════════════════════════════════════════════
// Direction simplifier — strips compass directions so a 5-year-old can follow
// ═══════════════════════════════════════════════════════════════

const COMPASS_RE = /\b(north|south|east|west|northeast|northwest|southeast|southwest|NE|NW|SE|SW|N|S|E|W)\b/gi;
const HEAD_COMPASS_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s*/i;
const HEAD_TOWARD_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+(on\s+.+?)\s*(toward\s+.+)?$/i;
const HEAD_ON_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+on\s+/i;

function simplifyDirection(instruction: string): string {
  if (!instruction) return instruction;

  // "Head north on X toward Y" → "Start on X toward Y"
  const headToward = instruction.match(HEAD_TOWARD_RE);
  if (headToward) {
    const onPart = headToward[2]; // "on Some St"
    const towardPart = headToward[3] ?? ''; // "toward Other St"
    return `Start ${onPart}${towardPart ? ' ' + towardPart : ''}`.trim();
  }

  // "Head north on X" → "Start on X"
  if (HEAD_ON_RE.test(instruction)) {
    return instruction.replace(HEAD_ON_RE, 'Start on ');
  }

  // "Head north" (bare) → "Go straight"
  if (HEAD_COMPASS_RE.test(instruction)) {
    return instruction.replace(HEAD_COMPASS_RE, 'Go straight ').trim();
  }

  // For other instructions, remove stray compass references like "Turn left to go north"
  // but keep street names containing compass words (e.g. "North Rd")
  // Only strip standalone compass words not preceded by a capital letter (part of a name)
  return instruction;
}

// ═══════════════════════════════════════════════════════════════
// Transit route parser
// ═══════════════════════════════════════════════════════════════

// deno-lint-ignore no-explicit-any
function parseTransitRoutesV2(routes: any[], origin: string, destination: string): unknown {
  const options = routes.slice(0, 3).map((route: Record<string, unknown>, idx: number) => {
    // deno-lint-ignore no-explicit-any
    const leg = (route.legs as any[])?.[0];
    if (!leg) return null;

    const option: Record<string, unknown> = {
      option: idx + 1,
      duration: route.localizedValues
        // deno-lint-ignore no-explicit-any
        ? (route.localizedValues as any).duration?.text
        : leg.localizedValues?.duration?.text,
      duration_seconds: leg.duration ? parseInt(String(leg.duration).replace('s', ''), 10) : undefined,
    };

    // Transit fare from travel advisory
    // deno-lint-ignore no-explicit-any
    const advisory = route.travelAdvisory as any;
    if (advisory?.transitFare) {
      const fare = advisory.transitFare;
      option.fare = `${fare.currencyCode} ${(parseInt(fare.units ?? '0', 10) + (fare.nanos ?? 0) / 1e9).toFixed(2)}`;
      option.fare_currency = fare.currencyCode;
    }
    // deno-lint-ignore no-explicit-any
    const locValues = route.localizedValues as any;
    if (locValues?.transitFare?.text) {
      option.fare = locValues.transitFare.text;
    }

    // deno-lint-ignore no-explicit-any
    const transitSteps = (leg.steps ?? [])
      // deno-lint-ignore no-explicit-any
      .filter((s: any) => s.travelMode === 'TRANSIT' || s.travelMode === 'WALK')
      .slice(0, 10)
      // deno-lint-ignore no-explicit-any
      .map((s: any) => {
        const step: Record<string, unknown> = {
          mode: s.travelMode === 'WALK' ? 'walking' : 'transit',
        };

        if (s.localizedValues) {
          step.distance = s.localizedValues.distance?.text;
          step.duration = s.localizedValues.staticDuration?.text;
        }

        if (s.navigationInstruction?.instructions) {
          step.instruction = simplifyDirection(s.navigationInstruction.instructions);
        }

        if (s.travelMode === 'WALK') {
          if (s.startLocation?.latLng) step.start_location = s.startLocation.latLng;
          if (s.endLocation?.latLng) step.end_location = s.endLocation.latLng;
        }

        if (s.transitDetails) {
          const td = s.transitDetails;
          const line = td.transitLine;
          if (line) {
            step.line_name = line.nameShort || line.name;
            step.line_full_name = line.name;
            step.line_color = line.color;
            if (line.vehicle) {
              step.vehicle_type = line.vehicle.type?.toLowerCase();
              step.vehicle_name = line.vehicle.name?.text;
            }
            if (line.agencies?.length) {
              step.agency = line.agencies[0].name;
            }
          }
          step.num_stops = td.stopCount;
          if (td.stopDetails) {
            step.departure_stop = td.stopDetails.departureStop?.name;
            step.arrival_stop = td.stopDetails.arrivalStop?.name;
            if (td.stopDetails.departureTime) {
              step.departs_at = td.localizedValues?.departureTime?.time?.text ?? td.stopDetails.departureTime;
            }
            if (td.stopDetails.arrivalTime) {
              step.arrives_at = td.localizedValues?.arrivalTime?.time?.text ?? td.stopDetails.arrivalTime;
            }
          }
          if (td.headsign) step.direction = td.headsign;
        }
        return step;
      });

    if (transitSteps.length) option.legs = transitSteps;

    // Extract departure/arrival from first and last transit steps
    // deno-lint-ignore no-explicit-any
    const firstTransit = transitSteps.find((s: any) => s.mode === 'transit');
    // deno-lint-ignore no-explicit-any
    const lastTransit = [...transitSteps].reverse().find((s: any) => s.mode === 'transit');
    if (firstTransit?.departs_at) option.depart_at = firstTransit.departs_at;
    if (lastTransit?.arrives_at) option.arrive_at = lastTransit.arrives_at;

    // deno-lint-ignore no-explicit-any
    const firstWalk = transitSteps.find((s: any) => s.mode === 'walking');
    if (firstWalk) {
      option.walk_to_station = {
        duration: firstWalk.duration,
        distance: firstWalk.distance,
      };
    }

    // Steps overview
    if (leg.stepsOverview?.multiModalSegments) {
      // deno-lint-ignore no-explicit-any
      option.segments_overview = leg.stepsOverview.multiModalSegments.map((seg: any) => ({
        mode: seg.travelMode?.toLowerCase(),
        navigation: seg.navigationInstruction?.instructions,
        steps: seg.stepStartIndex !== undefined ? `steps ${seg.stepStartIndex}-${seg.stepEndIndex}` : undefined,
      }));
    }

    return option;
  }).filter(Boolean);

  return {
    mode: 'transit',
    origin,
    destination,
    options,
  };
}

// ═══════════════════════════════════════════════════════════════
// Routes API v2 — all modes
// ═══════════════════════════════════════════════════════════════

async function routesAPI(
  apiKey: string,
  origin: string,
  destination: string,
  mode: string,
  departureTime: string | undefined,
  arrivalTime: string | undefined,
  transitPreference: string | undefined,
  allowedModes: string[] | undefined,
): Promise<unknown> {
  const travelMode = MODE_MAP[mode] ?? 'DRIVE';
  const isTransit = travelMode === 'TRANSIT';

  const body: Record<string, unknown> = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode,
  };

  if (isTransit) {
    body.computeAlternativeRoutes = true;

    if (arrivalTime && arrivalTime !== 'now') {
      body.arrivalTime = new Date(arrivalTime).toISOString();
    } else if (departureTime && departureTime !== 'now') {
      const depDate = new Date(departureTime);
      if (!isNaN(depDate.getTime()) && depDate.getTime() > Date.now()) {
        body.departureTime = depDate.toISOString();
      }
    }

    const transitPreferences: Record<string, unknown> = {};
    if (transitPreference === 'less_walking' || transitPreference === 'LESS_WALKING') {
      transitPreferences.routingPreference = 'LESS_WALKING';
    } else if (transitPreference === 'fewer_transfers' || transitPreference === 'FEWER_TRANSFERS') {
      transitPreferences.routingPreference = 'FEWER_TRANSFERS';
    }
    if (allowedModes?.length) {
      transitPreferences.allowedTravelModes = allowedModes.map((m: string) => m.toUpperCase());
    }
    if (Object.keys(transitPreferences).length) {
      body.transitPreferences = transitPreferences;
    }
  } else if (travelMode === 'DRIVE') {
    body.routingPreference = 'TRAFFIC_AWARE';

    if (departureTime && departureTime !== 'now') {
      const depDate = new Date(departureTime);
      if (!isNaN(depDate.getTime()) && depDate.getTime() > Date.now()) {
        body.departureTime = depDate.toISOString();
      }
    }
  }

  const fieldMask = isTransit ? TRANSIT_FIELD_MASK : DRIVE_FIELD_MASK;

  console.log(`[travel_time] Routes API ${mode}: ${origin} → ${destination}`);

  const resp = await retryFetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });

  // deno-lint-ignore no-explicit-any
  const data: any = await resp.json();

  if (data.error) {
    return {
      error: data.error.message ?? `Routes API error: ${data.error.status}`,
      fallback_query: `${origin} to ${destination} by ${mode}`,
    };
  }

  if (!data.routes?.length) {
    return {
      error: `No ${mode} routes found.`,
      fallback_query: `${origin} to ${destination} by ${mode}`,
    };
  }

  // Transit gets special multi-option parsing
  if (isTransit) {
    return parseTransitRoutesV2(data.routes, origin, destination);
  }

  // Non-transit: simpler response
  const route = data.routes[0];
  const leg = route.legs?.[0];
  const locValues = route.localizedValues ?? leg?.localizedValues;

  const result: Record<string, unknown> = {
    origin,
    destination,
    distance: locValues?.distance?.text,
    duration: locValues?.duration?.text,
    mode,
  };

  // Static duration (without traffic) vs actual duration
  if (locValues?.staticDuration?.text && locValues.staticDuration.text !== locValues.duration?.text) {
    result.duration_without_traffic = locValues.staticDuration.text;
  }

  const durationSec = route.duration ? parseInt(String(route.duration).replace('s', ''), 10) : undefined;
  if (durationSec) result.duration_seconds = durationSec;

  if (departureTime && departureTime !== 'now') {
    result.departure_time = departureTime;
    const depMs = new Date(departureTime).getTime();
    if (!isNaN(depMs) && durationSec) {
      result.estimated_arrival = new Date(depMs + durationSec * 1000).toISOString();
    }
  }

  // Route summary from steps — simplified for humans
  // deno-lint-ignore no-explicit-any
  const steps = (leg?.steps ?? []).slice(0, 5).map((s: any) => ({
    instruction: simplifyDirection(s.navigationInstruction?.instructions ?? ''),
    distance: s.localizedValues?.distance?.text,
    duration: s.localizedValues?.staticDuration?.text,
  })).filter((s: Record<string, unknown>) => s.instruction);
  if (steps.length) result.route_summary = steps;

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const travelTimeTool: ToolContract = {
  name: 'travel_time',
  description:
    'Get travel time and directions between two locations. Supports driving, transit (bus, train, tram), walking, and bicycling. Use for "how long to get to X", "next bus/train to X", "can I drive there in 30 mins", walking times, and transit schedules.',
  namespace: 'travel.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      origin: {
        type: 'string',
        description: 'Starting location (address, place name, or landmark). For "next train/bus", use nearest station as origin.',
      },
      destination: {
        type: 'string',
        description: 'Destination location (address, place name, or landmark).',
      },
      mode: {
        type: 'string',
        enum: ['driving', 'transit', 'walking', 'bicycling'],
        description: "Travel mode. Default 'driving'. Use 'transit' for all public transport (bus, train, tram).",
      },
      departure_time: {
        type: 'string',
        description: "ISO 8601 datetime or 'now'. Default 'now'.",
      },
      arrival_time: {
        type: 'string',
        description: 'ISO 8601 datetime. Transit only. Cannot combine with departure_time.',
      },
      transit_preference: {
        type: 'string',
        enum: ['less_walking', 'fewer_transfers'],
        description: 'Transit routing preference.',
      },
      allowed_transit_modes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'],
        },
        description: 'Filter transit to specific vehicle types.',
      },
    },
    required: ['origin', 'destination'],
  },
  inputExamples: [
    { origin: 'Melbourne CBD', destination: 'Melbourne Airport', mode: 'driving' },
    { origin: 'Flinders Street Station', destination: 'Caulfield Station', mode: 'transit' },
    { origin: 'Federation Square', destination: 'South Yarra', mode: 'walking' },
  ],

  handler: async (input) => {
    const origin = input.origin as string | undefined;
    const destination = input.destination as string | undefined;

    if (!origin || !destination) {
      return { content: JSON.stringify({ error: "Both 'origin' and 'destination' are required." }) };
    }

    const apiKey = getOptionalEnv('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      const query = `travel time from ${origin} to ${destination} by ${(input.mode as string) ?? 'driving'}`;
      return { content: JSON.stringify({ error: 'Google Maps not configured. Use web_search as fallback.', fallback_query: query }) };
    }

    const mode = (input.mode as string) ?? 'driving';
    const departureTime = input.departure_time as string | undefined;
    const arrivalTime = input.arrival_time as string | undefined;
    const transitPreference = input.transit_preference as string | undefined;
    const allowedModes = input.allowed_transit_modes as string[] | undefined;

    try {
      const result = await routesAPI(apiKey, origin, destination, mode, departureTime, arrivalTime, transitPreference, allowedModes);
      return { content: JSON.stringify(result) };
    } catch (e) {
      console.error('[travel_time] error:', (e as Error).message);
      const query = `travel time from ${origin} to ${destination} by ${mode}`;
      return { content: JSON.stringify({ error: (e as Error).message, fallback_query: query }) };
    }
  },
};
