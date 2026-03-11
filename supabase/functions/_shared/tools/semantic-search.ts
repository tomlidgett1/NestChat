import type { ToolContract } from './types.ts';

export const semanticSearchTool: ToolContract = {
  name: 'semantic_search',
  description:
    "Search the user's personal knowledge base using semantic similarity. This searches across memories, past conversations, emails, meeting notes, calendar events, and any documents the user has added to their second brain. Use this when you need to recall something specific about the user or find information from their history that isn't already in the conversation context. Returns relevant excerpts ranked by relevance score. Be specific with your query — 'favourite restaurant in Melbourne' will work better than 'restaurant'. Do NOT use this for general web searches — use web_search for that.",
  namespace: 'knowledge.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 10000,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "A specific natural-language search query. Be descriptive — e.g. 'favourite restaurant in Melbourne', 'meeting with Sarah about project timeline last week', 'Tom's birthday'. More specific queries return better results.",
      },
    },
    required: ['query'],
  },
  inputExamples: [
    { query: 'favourite restaurant in Melbourne' },
    { query: 'meeting notes from last week about the product launch' },
    { query: "Tom's work schedule and preferences" },
  ],
  handler: async (input, ctx) => {
    let searchResult = 'No results found.';
    try {
      const { getAdminClient } = await import('../supabase.ts');
      const { getEmbedding, vectorString } = await import('../rag-tools.ts');
      const supabase = getAdminClient();
      const handle = ctx.senderHandle;
      const query = input.query as string;
      if (handle && query) {
        const embedding = await getEmbedding(query);
        const embStr = vectorString(embedding);
        const { data, error } = await supabase.rpc('hybrid_search_documents', {
          p_handle: handle,
          query_text: query,
          query_embedding: embStr,
          match_count: 10,
          source_filters: null,
          min_semantic_score: 0.28,
        });
        if (!error && data && data.length > 0) {
          const blocks = (
            data as Array<{
              title: string;
              source_type: string;
              chunk_text: string | null;
              summary_text: string | null;
              semantic_score: number;
            }>
          )
            .slice(0, 8)
            .map((r, i) => {
              const text = (r.chunk_text ?? r.summary_text ?? '').slice(0, 800);
              return `[${i + 1}] ${r.title ?? r.source_type} (${Math.round(r.semantic_score * 100)}% match)\n${text}`;
            });
          searchResult = blocks.join('\n\n');
        }
      }
    } catch (err) {
      console.warn('[semantic-search] error:', (err as Error).message);
      searchResult = 'Knowledge base search temporarily unavailable. Try asking the question directly — the answer may already be in the conversation context.';
    }
    return { content: searchResult };
  },
};
