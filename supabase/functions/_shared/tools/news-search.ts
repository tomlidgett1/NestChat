import type { ToolContract } from './types.ts';
import { geminiGroundedSearch } from '../ai/gemini.ts';
import { MODEL_MAP } from '../ai/models.ts';

const NEWS_SEARCH_TIMEOUT_MS = 25_000;

function buildDateContext(timezone: string | null): {
  isoDate: string;
  weekday: string;
  dateTime: string;
} {
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

async function groundedSearch(query: string): Promise<string> {
  try {
    const result = await geminiGroundedSearch({ model: MODEL_MAP.fast, query });
    return result.text;
  } catch (e) {
    console.error(
      `[news_search] grounded search failed: "${query.substring(0, 80)}"`,
      (e as Error).message,
    );
    return '';
  }
}

export const newsSearchTool: ToolContract = {
  name: 'news_search',
  description:
    'Search for comprehensive, current news from multiple sources. Use this instead of web_search when the user asks about news, current events, what\'s happening, headlines, or wants a news update/briefing. Performs multiple parallel searches to deliver thorough coverage including local, national, and topic-specific news. Provide the user\'s location if known for local news.',
  namespace: 'web.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: NEWS_SEARCH_TIMEOUT_MS,
  inputSchema: {
    type: 'object' as const,
    properties: {
      location: {
        type: 'string' as const,
        description:
          'The user\'s city or region for local news (e.g. "Melbourne, Australia", "Sydney, NSW"). Use their known location from context if available.',
      },
      topics: {
        type: 'string' as const,
        description:
          'Specific news topics the user asked about, comma-separated (e.g. "technology, AI" or "Ukraine war, election"). Leave empty for a general news briefing.',
      },
      country: {
        type: 'string' as const,
        description:
          'The user\'s country for national news context (e.g. "Australia", "United States"). Defaults to Australia if unknown.',
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    const location = (input.location as string)?.trim() || null;
    const topics = (input.topics as string)?.trim() || null;
    const country = (input.country as string)?.trim() || 'Australia';
    const userTz = ctx?.timezone ?? null;
    const { isoDate, weekday, dateTime } = buildDateContext(userTz);

    const datePrefix = `Today is ${weekday} ${isoDate}. Current time: ${dateTime}.`;

    const searches: Array<{ label: string; query: string }> = [];

    // ── Search 1: Top headlines ──────────────────────────────────
    const regionHint = location ? ` relevant to someone in ${location}, ${country}` : ` relevant to ${country}`;
    searches.push({
      label: 'Top Stories',
      query:
        `${datePrefix} What are the biggest and most important news stories${regionHint} from today (${isoDate}) and the last 24 hours? ` +
        'Give 5-6 major headlines covering politics, economy, world events, and any breaking news. ' +
        'For each story: the headline, the source/publication, and a 2-3 sentence summary of what happened and why it matters. ' +
        'Only include stories from the last 24-48 hours. Be specific with names, numbers, and facts.',
    });

    // ── Search 2: Local/regional news (when location is known) ──
    if (location) {
      searches.push({
        label: `Local (${location})`,
        query:
          `${datePrefix} What are the latest local news stories specifically in or around ${location}, ${country} from today or the last 48 hours? ` +
          'Include local politics, council/government decisions, community events, transport disruptions, weather events, property/development, crime, or significant local stories. ' +
          '3-5 stories with specific details, names, and sources. Only real news from reliable local media outlets.',
      });
    }

    // ── Search 3: Topic-specific OR business/tech/world ─────────
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

    console.log(
      `[news_search] executing ${searches.length} parallel searches (location=${location ?? 'unknown'}, country=${country}, topics=${topics ?? 'general'})`,
    );

    const results = await Promise.all(
      searches.map(async (s) => {
        const text = await groundedSearch(s.query);
        return { label: s.label, text };
      }),
    );

    const sections: string[] = [];
    for (const r of results) {
      if (r.text && r.text.length > 30) {
        sections.push(`=== ${r.label} ===\n${r.text}`);
      }
    }

    if (sections.length === 0) {
      return { content: 'Unable to retrieve current news at this time. Try asking again in a moment.' };
    }

    const combined = sections.join('\n\n');
    console.log(
      `[news_search] completed: ${sections.length} sections, ${combined.length} chars total`,
    );

    return { content: combined };
  },
};
