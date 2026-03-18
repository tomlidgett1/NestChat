import type { ToolContract } from './types.ts';
import { geminiGroundedSearch, isGeminiModel } from '../ai/gemini.ts';
import { MODEL_MAP } from '../ai/models.ts';

function buildDateTimeContext(timezone: string | null): string {
  const now = new Date();
  const tz = timezone ?? 'UTC';
  const formatted = now.toLocaleString('en-AU', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const shortTz = now.toLocaleString('en-AU', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop() ?? tz;
  return `${formatted} ${shortTz}`;
}

export const webSearchTool: ToolContract = {
  name: 'web_search',
  description:
    'Search the web for current, real-time information. Use this when the user asks about current events, recent news, live scores, live data, or anything that requires up-to-date information beyond your training data. You MUST provide a search query. Do NOT use this for questions you can already answer from context or general knowledge.',
  namespace: 'web.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 15000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'The search query to look up on the web.',
      },
    },
    required: ['query'],
  },
  handler: async (input, ctx) => {
    const query = (input.query as string) ?? '';
    const userTz = ctx?.timezone ?? null;

    // For Gemini models, perform a real grounded search via a dedicated API call
    if (isGeminiModel(MODEL_MAP.fast)) {
      if (!query) {
        return { content: 'No search query provided.' };
      }
      try {
        const dateTimeContext = buildDateTimeContext(userTz);
        const timedQuery = `[Current date and time: ${dateTimeContext}] ${query}`;
        const result = await geminiGroundedSearch({
          model: MODEL_MAP.fast,
          query: timedQuery,
        });
        console.log(`[web_search] Gemini grounded search: "${query}" → ${result.text.length} chars (tz=${userTz ?? 'UTC'})`);
        return { content: result.text };
      } catch (err) {
        console.error(`[web_search] Gemini grounded search failed:`, (err as Error).message);
        return { content: `Web search failed: ${(err as Error).message}` };
      }
    }

    // For OpenAI, web_search_preview is handled natively by the API
    return { content: 'Web search handled natively by the API.' };
  },
};
