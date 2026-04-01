#!/usr/bin/env node
/**
 * Re-embed all Gemini embeddings with OpenAI text-embedding-3-large,
 * then delete all Gemini embeddings (and any the previous script created).
 *
 * Usage:
 *   node scripts/reembed-to-openai.mjs [--handle +61414187820] [--batch-size 50]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(envPath);

const SUPABASE_URL = process.env.SUPABASE_URL;
const ADMIN_KEY = process.env.SUPABASE_SECRET_KEY || process.env.NEW_SUPABASE_SECRET_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !ADMIN_KEY || !OPENAI_KEY) {
  console.error("Missing SUPABASE_URL, SUPABASE_SECRET_KEY (or NEW_SUPABASE_SECRET_KEY), or OPENAI_API_KEY");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

const args = process.argv.slice(2);
const handleIdx = args.indexOf("--handle");
const HANDLE_FILTER = handleIdx >= 0 ? args[handleIdx + 1] : null;
const batchIdx = args.indexOf("--batch-size");
const EMBED_BATCH = batchIdx >= 0 ? parseInt(args[batchIdx + 1], 10) : 50;

const headers = {
  apikey: ADMIN_KEY,
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path.slice(0, 120)}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path.slice(0, 80)}: ${res.status} ${await res.text()}`);
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`DELETE ${path.slice(0, 80)}: ${res.status} ${await res.text()}`);
}

async function embedBatch(texts) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: texts,
    dimensions: 3072,
  });
  return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function vectorString(values) {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}

function truncate(text, max = 30000) {
  return text.length > max ? text.slice(0, max) : text;
}

async function main() {
  console.log("=== Re-embed Gemini → OpenAI text-embedding-3-large ===");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Handle: ${HANDLE_FILTER || "ALL"}`);
  console.log(`Batch size: ${EMBED_BATCH}\n`);

  const handleClause = HANDLE_FILTER
    ? `&handle=eq.${encodeURIComponent(HANDLE_FILTER)}`
    : "";

  // Step 1: Find docs with Gemini embeddings but NO OpenAI embedding
  console.log("Finding docs with Gemini-only embeddings...");
  let offset = 0;
  const PAGE = 1000;
  const geminiDocs = [];

  while (true) {
    const rows = await supabaseGet(
      `search_embeddings?embedding_model=eq.gemini-embedding-2-preview${handleClause}&select=document_id,handle&limit=${PAGE}&offset=${offset}`
    );
    if (rows.length === 0) break;
    for (const r of rows) geminiDocs.push({ documentId: r.document_id, handle: r.handle });
    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log(`Found ${geminiDocs.length} Gemini embeddings total.`);

  // Check which already have OpenAI
  const docIdSet = new Set(geminiDocs.map((d) => d.documentId));
  const hasOpenAI = new Set();
  const docIdArr = [...docIdSet];

  for (let i = 0; i < docIdArr.length; i += 100) {
    const batch = docIdArr.slice(i, i + 100);
    try {
      const rows = await supabaseGet(
        `search_embeddings?embedding_model=eq.text-embedding-3-large&document_id=in.(${batch.join(",")})&select=document_id`
      );
      for (const r of rows) hasOpenAI.add(r.document_id);
    } catch { /* skip */ }
  }

  const needsEmbed = geminiDocs.filter((d) => !hasOpenAI.has(d.documentId));
  console.log(`${hasOpenAI.size} already have OpenAI, ${needsEmbed.length} need re-embedding.\n`);

  // Step 2: Re-embed with OpenAI
  let processed = 0;
  let errors = 0;
  const start = Date.now();

  for (let i = 0; i < needsEmbed.length; i += EMBED_BATCH) {
    const batch = needsEmbed.slice(i, i + EMBED_BATCH);
    const batchDocIds = batch.map((d) => d.documentId);

    try {
      const docs = await supabaseGet(
        `search_documents?id=in.(${batchDocIds.join(",")})&select=id,handle,title,summary_text,chunk_text`
      );

      const textsToEmbed = docs.map((d) => {
        const parts = [d.title || "", d.summary_text || "", d.chunk_text || ""].filter(Boolean).join("\n");
        return truncate(parts || "empty document");
      });

      const embeddings = await embedBatch(textsToEmbed);

      const embRows = docs.map((doc, idx) => ({
        handle: doc.handle,
        document_id: doc.id,
        embedding: vectorString(embeddings[idx]),
        embedding_model: "text-embedding-3-large",
        model_version: "2024-01",
      }));

      await supabasePost(
        "search_embeddings?on_conflict=document_id,embedding_model,model_version",
        embRows
      );

      processed += docs.length;
    } catch (err) {
      errors += batch.length;
      console.error(`\nBatch ${i} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const rate = (processed / (elapsed || 1)).toFixed(1);
    process.stdout.write(
      `  [${elapsed}s] ${processed}/${needsEmbed.length} re-embedded (${rate}/s, ${errors} errors)\r`
    );

    if (i + EMBED_BATCH < needsEmbed.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(`\n\nRe-embedding done: ${processed} embedded, ${errors} errors.`);

  // Step 3: Delete ALL Gemini embeddings
  console.log("\nDeleting all Gemini embeddings...");
  const delClause = HANDLE_FILTER
    ? `search_embeddings?embedding_model=eq.gemini-embedding-2-preview&handle=eq.${encodeURIComponent(HANDLE_FILTER)}`
    : `search_embeddings?embedding_model=eq.gemini-embedding-2-preview`;

  try {
    await supabaseDelete(delClause);
    console.log("All Gemini embeddings deleted.");
  } catch (err) {
    console.error(`Gemini delete failed: ${err.message}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
