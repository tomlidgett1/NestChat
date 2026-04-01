#!/usr/bin/env node
/**
 * Re-embed all search_embeddings that use text-embedding-3-large (OpenAI)
 * with gemini-embedding-2-preview (Gemini).
 *
 * After migrating the embedding model from OpenAI to Gemini, old embeddings
 * are in the wrong vector space and produce near-zero similarity scores.
 * This script fixes that by re-embedding the associated document text.
 *
 * Usage:
 *   node scripts/reembed-stale-openai.mjs [--handle +61414187820] [--batch-size 30] [--dry-run]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(envPath);

const SUPABASE_URL = process.env.SUPABASE_URL;
const ADMIN_KEY = process.env.SUPABASE_SECRET_KEY || process.env.NEW_SUPABASE_SECRET_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !ADMIN_KEY || !GEMINI_KEY) {
  console.error("Missing SUPABASE_URL, SUPABASE_SECRET_KEY (or NEW_SUPABASE_SECRET_KEY), or GEMINI_API_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const handleIdx = args.indexOf("--handle");
const HANDLE_FILTER = handleIdx >= 0 ? args[handleIdx + 1] : null;
const batchIdx = args.indexOf("--batch-size");
const EMBED_BATCH = batchIdx >= 0 ? parseInt(args[batchIdx + 1], 10) : 30;

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_MODEL = "models/gemini-embedding-2-preview";
const OUTPUT_DIMS = 3072;
const GEMINI_BATCH_MAX = 100;

const headers = {
  apikey: ADMIN_KEY,
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status} ${await res.text()}`);
}

async function embedBatch(texts) {
  const requests = texts.map((text) => ({
    model: EMBEDDING_MODEL,
    content: { parts: [{ text }] },
    outputDimensionality: OUTPUT_DIMS,
  }));

  const res = await fetch(
    `${GEMINI_API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini embed failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

function vectorString(values) {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}

function truncate(text, max = 30000) {
  return text.length > max ? text.slice(0, max) : text;
}

async function main() {
  console.log("=== Re-embed stale OpenAI embeddings with Gemini ===");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Handle filter: ${HANDLE_FILTER || "ALL"}`);
  console.log(`Batch size: ${EMBED_BATCH}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log();

  // Find all documents that have OpenAI embeddings but no Gemini embedding
  const handleClause = HANDLE_FILTER
    ? `&handle=eq.${encodeURIComponent(HANDLE_FILTER)}`
    : "";

  // Step 1: Get document IDs with stale OpenAI embeddings
  console.log("Fetching stale OpenAI embedding document IDs...");

  let offset = 0;
  const PAGE_SIZE = 1000;
  const staleDocIds = [];

  while (true) {
    const rows = await supabaseGet(
      `search_embeddings?embedding_model=eq.text-embedding-3-large${handleClause}&select=document_id,handle&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      staleDocIds.push({ documentId: r.document_id, handle: r.handle });
    }
    offset += rows.length;
    process.stdout.write(`  fetched ${staleDocIds.length} stale embeddings...\r`);
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`\nFound ${staleDocIds.length} documents with OpenAI embeddings.`);

  if (staleDocIds.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Step 2: Check which already have Gemini embeddings (skip those)
  console.log("Checking for existing Gemini embeddings...");
  const docIdSet = new Set(staleDocIds.map((d) => d.documentId));
  const alreadyGemini = new Set();

  const GEMINI_CHECK_BATCH = 100;
  const docIdArr = [...docIdSet];
  for (let i = 0; i < docIdArr.length; i += GEMINI_CHECK_BATCH) {
    const batch = docIdArr.slice(i, i + GEMINI_CHECK_BATCH);
    try {
      const rows = await supabaseGet(
        `search_embeddings?embedding_model=eq.gemini-embedding-2-preview&document_id=in.(${batch.join(",")})&select=document_id`
      );
      for (const r of rows) {
        alreadyGemini.add(r.document_id);
      }
    } catch {
      // Skip check errors; we'll just re-embed these
    }
    if (i % 5000 === 0 && i > 0) {
      process.stdout.write(`  checked ${i}/${docIdArr.length} for existing Gemini embeddings...\r`);
    }
  }

  const needsReembed = staleDocIds.filter((d) => !alreadyGemini.has(d.documentId));
  console.log(
    `${alreadyGemini.size} already have Gemini embeddings, ${needsReembed.length} need re-embedding.`
  );

  if (needsReembed.length === 0) {
    console.log("All documents already have Gemini embeddings.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would re-embed these document IDs:");
    for (const d of needsReembed.slice(0, 10)) {
      console.log(`  ${d.documentId} (handle: ${d.handle})`);
    }
    if (needsReembed.length > 10) {
      console.log(`  ... and ${needsReembed.length - 10} more`);
    }
    return;
  }

  // Step 3: Process in batches
  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < needsReembed.length; i += EMBED_BATCH) {
    const batch = needsReembed.slice(i, i + EMBED_BATCH);
    const batchDocIds = batch.map((d) => d.documentId);

    try {
      // Fetch document text
      const docs = await supabaseGet(
        `search_documents?id=in.(${batchDocIds.join(",")})&select=id,handle,title,summary_text,chunk_text`
      );

      const textsToEmbed = docs.map((d) => {
        const parts = [d.title || "", d.summary_text || "", d.chunk_text || ""]
          .filter(Boolean)
          .join("\n");
        return truncate(parts || "empty document");
      });

      // Embed with Gemini (sub-batch if needed)
      const allEmbeddings = [];
      for (let j = 0; j < textsToEmbed.length; j += GEMINI_BATCH_MAX) {
        const subBatch = textsToEmbed.slice(j, j + GEMINI_BATCH_MAX);
        const embeddings = await embedBatch(subBatch);
        allEmbeddings.push(...embeddings);
        if (j + GEMINI_BATCH_MAX < textsToEmbed.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Upsert new Gemini embeddings
      const embRows = docs.map((doc, idx) => ({
        handle: doc.handle,
        document_id: doc.id,
        embedding: vectorString(allEmbeddings[idx]),
        embedding_model: "gemini-embedding-2-preview",
        model_version: "2026-03",
      }));

      await supabasePost(
        "search_embeddings?on_conflict=document_id,embedding_model,model_version",
        embRows
      );

      processed += docs.length;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / (elapsed || 1)).toFixed(1);
      process.stdout.write(
        `  [${elapsed}s] ${processed}/${needsReembed.length} re-embedded (${rate}/s, ${errors} errors)\r`
      );
    } catch (err) {
      errors += batch.length;
      console.error(`\nBatch ${i}-${i + batch.length} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Rate limit: 200ms between batches
    if (i + EMBED_BATCH < needsReembed.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\nDone. ${processed} re-embedded, ${errors} errors in ${totalElapsed}s.`);

  // Step 4: Clean up old OpenAI embeddings
  console.log("\nCleaning up old OpenAI embeddings...");
  const successDocIds = needsReembed
    .slice(0, processed)
    .map((d) => d.documentId);

  for (let i = 0; i < successDocIds.length; i += PAGE_SIZE) {
    const batch = successDocIds.slice(i, i + PAGE_SIZE);
    try {
      await supabaseDelete(
        `search_embeddings?embedding_model=eq.text-embedding-3-large&document_id=in.(${batch.join(",")})`
      );
    } catch (err) {
      console.error(`Cleanup batch failed: ${err.message}`);
    }
  }

  console.log("Cleanup complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
