import type { ToolContract } from './types.ts';
import { getOptionalEnv } from '../env.ts';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';
const FETCH_TIMEOUT_MS = 10_000;

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

// ═══════════════════════════════════════════════════════════════
// Text Search (Places API New)
// ═══════════════════════════════════════════════════════════════

async function placesTextSearch(
  apiKey: string,
  query: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const maxResults = Math.min((args.max_results as number) ?? 5, 10);
  const locationBias = args.location as string | undefined;

  const body: Record<string, unknown> = {
    textQuery: locationBias ? `${query} near ${locationBias}` : query,
    maxResultCount: maxResults,
    languageCode: 'en',
  };

  const fieldMask = [
    'places.displayName',
    'places.formattedAddress',
    'places.rating',
    'places.userRatingCount',
    'places.priceLevel',
    'places.types',
    'places.websiteUri',
    'places.nationalPhoneNumber',
    'places.currentOpeningHours',
    'places.editorialSummary',
    'places.googleMapsUri',
    'places.id',
  ].join(',');

  console.log(`[places_search] Text search: "${body.textQuery}"`);

  const resp = await fetchWithTimeout(PLACES_TEXT_SEARCH_API, {
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
    return { error: data.error.message ?? 'Places API error', status: data.error.status };
  }

  // deno-lint-ignore no-explicit-any
  const places = (data.places ?? []).map((p: any) => {
    const result: Record<string, unknown> = {
      name: p.displayName?.text,
      address: p.formattedAddress,
      place_id: p.id,
      google_maps_url: p.googleMapsUri,
    };
    if (p.rating) result.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
    if (p.priceLevel) result.price_level = p.priceLevel;
    if (p.nationalPhoneNumber) result.phone = p.nationalPhoneNumber;
    if (p.websiteUri) result.website = p.websiteUri;
    if (p.editorialSummary?.text) result.summary = p.editorialSummary.text;
    if (p.currentOpeningHours?.openNow !== undefined) {
      result.open_now = p.currentOpeningHours.openNow;
    }
    const types = (p.types ?? [])
      .filter((t: string) => !t.startsWith('point_of_interest') && !t.startsWith('establishment'))
      .slice(0, 3);
    if (types.length) result.types = types;
    return result;
  });

  return { results: places, count: places.length };
}

// ═══════════════════════════════════════════════════════════════
// Place Details (Places API New)
// ═══════════════════════════════════════════════════════════════

async function placesDetail(apiKey: string, placeId: string): Promise<unknown> {
  const fieldMask = [
    'displayName',
    'formattedAddress',
    'rating',
    'userRatingCount',
    'priceLevel',
    'types',
    'websiteUri',
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'currentOpeningHours',
    'editorialSummary',
    'reviews',
    'googleMapsUri',
    'adrFormatAddress',
  ].join(',');

  console.log(`[places_search] Detail lookup: ${placeId}`);

  const resp = await fetchWithTimeout(`${PLACES_DETAIL_API}/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
  });

  // deno-lint-ignore no-explicit-any
  const p: any = await resp.json();

  if (p.error) {
    return { error: p.error.message ?? 'Places API error', status: p.error.status };
  }

  const result: Record<string, unknown> = {
    name: p.displayName?.text,
    address: p.formattedAddress,
    google_maps_url: p.googleMapsUri,
  };
  if (p.rating) result.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
  if (p.priceLevel) result.price_level = p.priceLevel;
  if (p.nationalPhoneNumber) result.phone = p.nationalPhoneNumber;
  if (p.internationalPhoneNumber) result.international_phone = p.internationalPhoneNumber;
  if (p.websiteUri) result.website = p.websiteUri;
  if (p.editorialSummary?.text) result.summary = p.editorialSummary.text;
  if (p.currentOpeningHours) {
    result.open_now = p.currentOpeningHours.openNow;
    const weekday = p.currentOpeningHours.weekdayDescriptions;
    if (weekday?.length) result.hours = weekday;
  }
  if (p.reviews?.length) {
    // deno-lint-ignore no-explicit-any
    result.top_reviews = p.reviews.slice(0, 3).map((r: any) => ({
      rating: r.rating,
      text: r.text?.text?.slice(0, 200),
      time: r.relativePublishTimeDescription,
    }));
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const placesSearchTool: ToolContract = {
  name: 'places_search',
  description:
    'Search for places, restaurants, cafes, bars, attractions, and businesses. Get details like phone numbers, hours, ratings, and reviews. Provide a query for search, or a place_id from a previous result for full details including reviews.',
  namespace: 'travel.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 10000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g. "best coffee in Melbourne CBD", "restaurants near Federation Square").',
      },
      place_id: {
        type: 'string',
        description: 'Google Place ID from a previous search result. Returns full details including reviews, hours, and phone numbers.',
      },
      location: {
        type: 'string',
        description: 'Location to bias search results (e.g. "Melbourne CBD", "Sydney"). Appended to query as "near <location>".',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (1-10, default 5).',
      },
    },
  },
  inputExamples: [
    { query: 'best coffee in Melbourne CBD' },
    { query: 'restaurants', location: 'Federation Square', max_results: 3 },
    { place_id: 'ChIJP3Sa8ziYEmsRUKgyFmh9AQM' },
  ],

  handler: async (input) => {
    const query = input.query as string | undefined;
    const placeId = input.place_id as string | undefined;

    if (!query && !placeId) {
      return { content: JSON.stringify({ error: "Provide 'query' (text search) or 'place_id' (details)." }) };
    }

    const apiKey = getOptionalEnv('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      const searchQuery = query ?? `place details ${placeId}`;
      return { content: JSON.stringify({ error: 'Google Maps not configured. Use web_search as fallback.', fallback_query: searchQuery }) };
    }

    try {
      if (placeId) {
        const result = await placesDetail(apiKey, placeId);
        return { content: JSON.stringify(result) };
      }
      const result = await placesTextSearch(apiKey, query!, input);
      return { content: JSON.stringify(result) };
    } catch (e) {
      console.error('[places_search] error:', (e as Error).message);
      return { content: JSON.stringify({ error: (e as Error).message, fallback_query: query ?? `place ${placeId}` }) };
    }
  },
};
