#!/usr/bin/env node
/**
 * Integration check: embed query with OpenAI (same as prod) and call hybrid_search_documents.
 *
 * Usage:
 *   node scripts/test-hybrid-search-query.mjs [--handle +61414187820] "did i ever interview at influx"
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
let handle = "+61414187820";
if (handleIdx >= 0) {
  handle = args[handleIdx + 1];
  args.splice(handleIdx, 2);
}
const query = args.join(" ").trim() || "did i ever interview at influx";

function vectorString(values) {
  return "[" + values.map((v) => v.toFixed(8)).join(",") + "]";
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: ADMIN_KEY,
      Authorization: `Bearer ${ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${name}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log("Query:", query);
  console.log("Handle:", handle);

  const embRes = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query,
    dimensions: 3072,
  });
  const embStr = vectorString(embRes.data[0].embedding);

  const rows = await rpc("hybrid_search_documents", {
    p_handle: handle,
    query_text: query,
    query_embedding: embStr,
    match_count: 15,
    source_filters: null,
    min_semantic_score: 0.28,
  });

  console.log("\nTop results (fused_score desc):\n");
  for (const r of rows) {
    const preview = (r.chunk_text || r.summary_text || "").replace(/\s+/g, " ").slice(0, 120);
    console.log(
      `- fused=${Number(r.fused_score).toFixed(4)} sem=${Number(r.semantic_score).toFixed(4)} lex=${Number(r.lexical_score).toFixed(4)} | ${r.title || "(no title)"} | ${r.source_id || ""}`,
    );
    if (preview) console.log(`  ${preview}…`);
  }

  const hay = (r) =>
    `${r.title || ""} ${r.summary_text || ""} ${r.chunk_text || ""} ${r.source_id || ""}`.toLowerCase();
  const influxHits = rows.filter((r) => hay(r).includes("influx"));
  console.log("\n---");
  if (influxHits.length) {
    console.log(`PASS: ${influxHits.length} row(s) mention Influx in top ${rows.length}.`);
    for (const r of influxHits) {
      console.log(`  • ${r.title} (${r.source_id}) fused=${Number(r.fused_score).toFixed(4)}`);
    }
  } else {
    console.log(`FAIL: No Influx-related rows in top ${rows.length} for this query/handle.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
