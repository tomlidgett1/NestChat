// RAG embedding utilities — uses OpenAI text-embedding-3-large (3072 dims).
// Provides LRU-cached embeddings, batch support, and pgvector-compatible string formatting.

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMS = 3072;
const BATCH_MAX = 100;
const BATCH_DELAY_MS = 100;

// ── Embedding LRU Cache ──────────────────────────────────────

const embeddingCache = new Map<string, number[]>();
const EMBEDDING_CACHE_MAX = 100;

/**
 * Embed a single text. Uses an LRU cache to avoid re-embedding
 * identical queries within the same edge function invocation.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const cacheKey = text.trim().toLowerCase().slice(0, 200);
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  const results = await getBatchEmbeddings([text]);
  const embedding = results[0];

  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(cacheKey, embedding);
  return embedding;
}

/**
 * Embed multiple texts using OpenAI text-embedding-3-large.
 * Batches into groups of 100 with delay between sub-batches.
 * Returns embeddings in the same order as the input texts.
 */
export async function getBatchEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { getOpenAIClient } = await import("./ai/models.ts");
  const client = getOpenAIClient();
  const results: number[][] = [];
  let totalPromptTokens = 0;

  for (let i = 0; i < texts.length; i += BATCH_MAX) {
    const batch = texts.slice(i, i + BATCH_MAX);
    const t0 = Date.now();

    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMS,
    });

    const batchTokens = (response as unknown as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0;
    totalPromptTokens += batchTokens;

    const sorted = response.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index);
    for (const item of sorted) {
      results.push(item.embedding);
    }

    // Log embedding batch cost (fire-and-forget)
    import("./cost-tracker.ts").then(({ logApiCost }) => {
      import("./supabase.ts").then(({ getAdminClient }) => {
        logApiCost(getAdminClient(), {
          userId: null,
          model: EMBEDDING_MODEL,
          endpoint: "embeddings",
          description: `Embedding batch (${batch.length} texts)`,
          tokensIn: batchTokens,
          tokensOut: 0,
          latencyMs: Date.now() - t0,
          metadata: { batch_size: batch.length, batch_offset: i },
        });
      });
    }).catch(() => {});

    if (i + BATCH_MAX < texts.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
}

/**
 * Format a number[] embedding as a pgvector-compatible string.
 * e.g. "[0.12345678,0.23456789,...]"
 */
export function vectorString(values: number[]): string {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}
