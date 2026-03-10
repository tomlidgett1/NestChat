// RAG embedding utilities — extracted from TapMeeting tools.ts.
// Provides OpenAI text-embedding-3-large embeddings with LRU cache,
// batch support, and pgvector-compatible string formatting.

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const FETCH_TIMEOUT_MS = 10_000;

// ── Fetch with timeout + 1-retry ─────────────────────────────

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

async function retryFetch(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
        return resp;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[rag-tools] ${resp.status} on attempt ${attempt + 1}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[rag-tools] Error on attempt ${attempt + 1}: ${lastError.message}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw lastError ?? new Error("retryFetch: max attempts exceeded");
}

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
 * Embed multiple texts in a single OpenAI API call.
 * Returns embeddings in the same order as the input texts.
 */
export async function getBatchEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const resp = await retryFetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-large", input: texts }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Embedding API failed (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();

  return (data.data as Array<{ index: number; embedding: number[] }>)
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Format a number[] embedding as a pgvector-compatible string.
 * e.g. "[0.12345678,0.23456789,...]"
 */
export function vectorString(values: number[]): string {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}
