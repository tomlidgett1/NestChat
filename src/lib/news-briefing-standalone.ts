/**
 * Node/Express copy of the Supabase `news_search` multi-source grounded fetch.
 * Used by POST /automations/api/trigger when automation_type is news_briefing.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Align with Nest Edge `MODEL_MAP.fast` unless overridden. */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';

function buildDateContext(timezone: string | null): { isoDate: string; weekday: string; dateTime: string } {
  const now = new Date();
  const tz = timezone ?? 'Australia/Sydney';
  const isoDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const weekday = now.toLocaleDateString('en-AU', { timeZone: tz, weekday: 'long' });
  const dateTime = now.toLocaleString('en-AU', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return { isoDate, weekday, dateTime };
}

async function geminiGroundedSearch(query: string, model: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 2048 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini search ${resp.status}: ${errBody.slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    let text = '';
    for (const p of parts) {
      if (p.text) text += p.text;
    }
    return text || '';
  } finally {
    clearTimeout(timer);
  }
}

export function inferCountryFromTimezone(timezone: string | null): string {
  const tz = timezone ?? 'Australia/Sydney';
  if (tz.startsWith('Australia/')) return 'Australia';
  if (tz.startsWith('Pacific/Auckland')) return 'New Zealand';
  if (tz.startsWith('America/')) return 'United States';
  if (tz.startsWith('Europe/London') || tz.startsWith('Europe/Belfast')) return 'United Kingdom';
  if (tz.startsWith('Europe/Dublin')) return 'Ireland';
  if (tz.startsWith('Asia/Singapore')) return 'Singapore';
  if (tz.startsWith('Asia/Hong_Kong')) return 'Hong Kong';
  if (tz.startsWith('Asia/Tokyo')) return 'Japan';
  return 'Australia';
}

const TIMEZONE_REGION_MAP: Record<string, string> = {
  Australia: 'Australia',
  America: 'USA',
  Europe: 'Europe',
  Asia: 'Asia',
  Pacific: 'Pacific',
};

export function resolveLocationFromProfile(
  contextProfile: unknown,
  timezone: string | null,
): string | null {
  const ctx = contextProfile as Record<string, { value?: string } | undefined> | null;
  const cur = ctx?.currentLocation?.value?.trim();
  if (cur) return cur;
  const home = ctx?.homeLocation?.value?.trim();
  if (home) return home;
  const work = ctx?.workLocation?.value?.trim();
  if (work) return work;
  if (!timezone || !timezone.includes('/')) return null;
  const parts = timezone.split('/');
  const city = parts[parts.length - 1]?.replace(/_/g, ' ').trim();
  if (!city) return null;
  const region = parts[0];
  const country = TIMEZONE_REGION_MAP[region];
  return country ? `${city}, ${country}` : city;
}

export function extractInterestsFromDeepProfile(snapshot: Record<string, unknown> | null): string[] {
  if (!snapshot) return [];
  const pl = snapshot.personal_life as Record<string, unknown> | undefined;
  const arr = pl?.interests;
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 120)).slice(0, 6);
}

export interface RunNewsSearchParams {
  location: string | null;
  country: string;
  topics?: string;
  timezone: string | null;
}

/**
 * Same multi-query strategy as `news_search` Edge tool — parallel Gemini grounded searches.
 */
export async function runNewsSearchForBriefing(params: RunNewsSearchParams): Promise<string> {
  const model = process.env.GEMINI_NEWS_MODEL || DEFAULT_MODEL;
  const { location, country, topics: topicsRaw, timezone: userTz } = params;
  const topics = topicsRaw?.trim() || null;
  const { isoDate, weekday, dateTime } = buildDateContext(userTz);
  const datePrefix = `Today is ${weekday} ${isoDate}. Current time: ${dateTime}.`;

  const searches: Array<{ label: string; query: string }> = [];
  const regionHint = location ? ` relevant to someone in ${location}, ${country}` : ` relevant to ${country}`;
  searches.push({
    label: 'Top Stories',
    query:
      `${datePrefix} What are the biggest and most important news stories${regionHint} from today (${isoDate}) and the last 24 hours? ` +
      'Give 5-6 major headlines covering politics, economy, world events, and any breaking news. ' +
      'For each story: the headline, the source/publication, and a 2-3 sentence summary of what happened and why it matters. ' +
      'Only include stories from the last 24-48 hours. Be specific with names, numbers, and facts.',
  });

  if (location) {
    searches.push({
      label: `Local (${location})`,
      query:
        `${datePrefix} What are the latest local news stories specifically in or around ${location}, ${country} from today or the last 48 hours? ` +
        'Include local politics, council/government decisions, community events, transport disruptions, weather events, property/development, crime, or significant local stories. ' +
        '3-5 stories with specific details, names, and sources. Only real news from reliable local media outlets.',
    });
  }

  if (topics) {
    const topicList = topics
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 4);
    searches.push({
      label: `Topics: ${topicList.join(', ')}`,
      query:
        `${datePrefix} Search for the very latest news and developments about: ${topicList.join(', ')}. ` +
        'Include the most recent stories from the last 24-48 hours. For each story: headline, source, and a thorough 2-3 sentence summary with specific facts, quotes, and context. ' +
        'Be comprehensive — include multiple angles and developments if they exist.',
    });
  } else {
    const baseContext = location ? ` (user is in ${location}, ${country})` : ` (user is in ${country})`;
    searches.push({
      label: 'Business, Tech & World',
      query:
        `${datePrefix} What are the latest significant business, technology, and international news stories from today or the last 24 hours${baseContext}? ` +
        'Include stock market movements, major company news, tech industry developments, and significant global events. ' +
        '4-5 stories with specific details and source names.',
    });
  }

  const results = await Promise.all(
    searches.map(async (s) => {
      try {
        const text = await geminiGroundedSearch(s.query, model);
        return { label: s.label, text };
      } catch (e) {
        console.error('[news-briefing-standalone] search failed:', (e as Error).message);
        return { label: s.label, text: '' };
      }
    }),
  );

  const sections: string[] = [];
  for (const r of results) {
    if (r.text && r.text.length > 30) {
      sections.push(`=== ${r.label} ===\n${r.text}`);
    }
  }
  return sections.join('\n\n');
}
