// Batch embedder for server-side ingestion pipeline.
// Processes chunks in optimal batches, respects OpenAI rate limits,
// and yields progress for job tracking.

import { getBatchEmbeddings, vectorString } from "./rag-tools.ts";

export interface ChunkToEmbed {
  text: string;
  sourceType: string;
  sourceId: string;
  title: string;
  chunkIndex: number;
  contentHash: string;
  parentSourceId?: string | null;
  metadata?: Record<string, any>;
}

export interface EmbeddedChunk extends ChunkToEmbed {
  embedding: number[];
  embeddingStr: string;
}

const BATCH_SIZE = 32;
const BATCH_DELAY_MS = 200;

/**
 * Embed an array of chunks in batches.
 * Yields progress via callback for job tracking.
 */
export async function embedChunks(
  chunks: ChunkToEmbed[],
  onProgress?: (completed: number, total: number) => void,
): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const results: EmbeddedChunk[] = [];
  let completed = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    let embeddings: number[][];
    try {
      embeddings = await getBatchEmbeddings(texts);
    } catch (err) {
      console.error(`[embedder] Batch ${i}-${i + batch.length} failed:`, (err as Error).message);
      // Retry once after delay
      await sleep(1000);
      try {
        embeddings = await getBatchEmbeddings(texts);
      } catch (retryErr) {
        console.error(`[embedder] Retry failed, skipping batch:`, (retryErr as Error).message);
        completed += batch.length;
        onProgress?.(completed, chunks.length);
        continue;
      }
    }

    for (let j = 0; j < batch.length; j++) {
      results.push({
        ...batch[j],
        embedding: embeddings[j],
        embeddingStr: vectorString(embeddings[j]),
      });
    }

    completed += batch.length;
    onProgress?.(completed, chunks.length);

    if (i + BATCH_SIZE < chunks.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return results;
}

/**
 * Truncate text that exceeds the token limit for embeddings.
 * text-embedding-3-large handles ~8191 tokens; we estimate 4 chars/token.
 */
export function truncateForEmbedding(text: string, maxChars = 30000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
