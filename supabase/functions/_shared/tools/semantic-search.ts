import type { ToolContract } from './types.ts';

export const semanticSearchTool: ToolContract = {
  name: 'semantic_search',
  description:
    "Search the user's personal knowledge base using semantic similarity. This searches across memories, past conversations, emails, meeting notes, calendar events, and any documents the user has uploaded to My Nest (PDFs, images, text notes). Use this when you need to recall something specific about the user or find information from their history that isn't already in the conversation context. Returns relevant excerpts ranked by relevance score. Be specific with your query — 'favourite restaurant in Melbourne' will work better than 'restaurant'. Do NOT use this for general web searches — use web_search for that.",
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
      const userId = ctx.authUserId;
      const query = input.query as string;

      if (handle && query) {
        const embedding = await getEmbedding(query);
        const embStr = vectorString(embedding);

        // Search main knowledge base and user uploads in parallel
        const [mainResult, userUploadsResult] = await Promise.all([
          // Main RAG: emails, meetings, conversations, memories, etc.
          supabase.rpc('hybrid_search_documents', {
            p_handle: handle,
            query_text: query,
            query_embedding: embStr,
            match_count: 10,
            source_filters: null,
            min_semantic_score: 0.28,
          }),
          // User uploads (My Nest): PDFs, images, text notes
          userId
            ? supabase.rpc('match_user_document_chunks', {
                p_user_id: userId,
                query_embedding: embStr,
                match_count: 5,
                min_score: 0.30,
              })
            : Promise.resolve({ data: null, error: null }),
        ]);

        // Format main results
        type MainResult = {
          title: string;
          source_type: string;
          chunk_text: string | null;
          summary_text: string | null;
          semantic_score: number;
          fused_score?: number;
        };

        const mainHits: Array<{ title: string; text: string; score: number }> = [];
        if (!mainResult.error && mainResult.data) {
          for (const r of mainResult.data as MainResult[]) {
            mainHits.push({
              title: r.title ?? r.source_type,
              text: (r.chunk_text ?? r.summary_text ?? '').slice(0, 800),
              score: r.fused_score ?? r.semantic_score,
            });
          }
        }

        // Format user upload results
        type UploadResult = {
          chunk_id: string;
          upload_id: string;
          source_type: string;
          content_text: string | null;
          metadata: Record<string, unknown>;
          similarity: number;
        };

        const uploadHits: Array<{ title: string; text: string; score: number }> = [];
        if (!userUploadsResult.error && userUploadsResult.data) {
          for (const r of userUploadsResult.data as UploadResult[]) {
            const label =
              (r.metadata?.filename as string) ??
              (r.source_type === 'image_embedding' ? 'Uploaded Image' : 'My Nest Upload');
            uploadHits.push({
              title: `📎 ${label}`,
              text: (r.content_text ?? '(image — no text content)').slice(0, 800),
              score: r.similarity,
            });
          }
        }

        // Merge and sort by score (descending), take top 8
        const allHits = [...mainHits, ...uploadHits]
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);

        if (allHits.length > 0) {
          const blocks = allHits.map(
            (r, i) => `[${i + 1}] ${r.title} (${Math.round(r.score * 100)}% match)\n${r.text}`,
          );
          searchResult = blocks.join('\n\n');
        }
      }
    } catch (err) {
      console.warn('[semantic-search] error:', (err as Error).message);
      searchResult =
        'Knowledge base search temporarily unavailable. Try asking the question directly — the answer may already be in the conversation context.';
    }
    return { content: searchResult };
  },
};
