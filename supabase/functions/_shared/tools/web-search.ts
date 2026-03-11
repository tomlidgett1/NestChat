import type { ToolContract } from './types.ts';

export const webSearchTool: ToolContract = {
  name: 'web_search',
  description:
    'Search the web for current, real-time information. This is a native Anthropic server tool — it is handled automatically by the API and does not require manual execution. Use this when the user asks about current events, recent news, live data, or anything that requires up-to-date information beyond your training data. Do NOT use this for questions you can already answer from context or general knowledge.',
  namespace: 'web.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 10000,
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: async () => {
    return { content: 'Web search handled natively by Anthropic.' };
  },
};
