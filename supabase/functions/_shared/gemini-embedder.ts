// Gemini Embedding 2 Preview — multimodal embeddings (text, image, PDF)
// Returns 3072-dim vectors for pgvector storage (halfvec(3072)).
// At 3072 dims, Gemini returns already-normalized vectors — no manual normalization needed.

import { getGeminiApiKey } from "./ai/gemini.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_MODEL = "models/gemini-embedding-2-preview";
const OUTPUT_DIMS = 3072;
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_DELAY_MS = 200;
const BATCH_MAX_TEXTS = 100; // Gemini batchEmbedContents limit

// ── Core single-item embedding call ─────────────────────────────

interface EmbedContentPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callEmbedContent(
  parts: EmbedContentPart[],
): Promise<number[]> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_API_BASE}/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        content: { parts },
        outputDimensionality: OUTPUT_DIMS,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Gemini embedding failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }

    const data = await res.json();
    const raw =
      data?.embedding?.values ??
      data?.embeddings?.[0]?.values ??
      null;

    if (!raw || !Array.isArray(raw)) {
      throw new Error(
        `Gemini embedding returned no values: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    return raw; // 3072-dim vectors are already normalized by Gemini
  } finally {
    clearTimeout(timer);
  }
}

// ── Batch embedding call (up to 100 texts per request) ──────────

async function callBatchEmbedContents(
  texts: string[],
): Promise<number[][]> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;

  const requests = texts.map((text) => ({
    model: EMBEDDING_MODEL,
    content: { parts: [{ text }] },
    outputDimensionality: OUTPUT_DIMS,
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ requests }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Gemini batch embedding failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }

    const data = await res.json();
    const embeddings = data?.embeddings;

    if (!embeddings || !Array.isArray(embeddings)) {
      throw new Error(
        `Gemini batch embedding returned no embeddings: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    return embeddings.map((e: { values: number[] }) => e.values);
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ──────────────────────────────────────────────────

/** Embed a single text string. Returns 3072-dim vector. */
export async function embedText(text: string): Promise<number[]> {
  return callEmbedContent([{ text }]);
}

/** Embed an image via inline base64. Returns 3072-dim vector. */
export async function embedImage(
  base64: string,
  mimeType: string,
): Promise<number[]> {
  return callEmbedContent([{ inline_data: { mime_type: mimeType, data: base64 } }]);
}

/** Embed a PDF (≤6 pages) via inline base64. Returns 3072-dim vector. */
export async function embedPdfPages(base64: string): Promise<number[]> {
  return callEmbedContent([
    { inline_data: { mime_type: "application/pdf", data: base64 } },
  ]);
}

/**
 * Embed multiple texts using Gemini batchEmbedContents endpoint.
 * Batches into groups of 100 (Gemini limit) with delay between sub-batches.
 * Returns 3072-dim vectors in the same order as input texts.
 */
export async function batchEmbedTexts(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_MAX_TEXTS) {
    const batch = texts.slice(i, i + BATCH_MAX_TEXTS);
    const batchResults = await callBatchEmbedContents(batch);
    results.push(...batchResults);

    // Delay between sub-batches to respect rate limits
    if (i + BATCH_MAX_TEXTS < texts.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
}

/** Format a number[] as a pgvector-compatible string. */
export function vectorString(values: number[]): string {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}
