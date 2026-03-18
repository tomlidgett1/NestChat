// RAG embedding utilities — uses Gemini gemini-embedding-2-preview (3072 dims).
// Provides LRU-cached embeddings, batch support, and pgvector-compatible string formatting.

import { batchEmbedTexts } from "./gemini-embedder.ts";

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
 * Embed multiple texts using Gemini batchEmbedContents.
 * Returns embeddings in the same order as the input texts.
 */
export async function getBatchEmbeddings(
  texts: string[],
): Promise<number[][]> {
  return batchEmbedTexts(texts);
}

/**
 * Format a number[] embedding as a pgvector-compatible string.
 * e.g. "[0.12345678,0.23456789,...]"
 */
export function vectorString(values: number[]): string {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}
