// Edge function: embed-user-content
// Accepts user-uploaded text, PDF text, or images,
// embeds via OpenAI text-embedding-3-large, and stores in pgvector.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sentenceAwareChunks } from "../_shared/chunker.ts";
import { getBatchEmbeddings, vectorString } from "../_shared/rag-tools.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const adminKey =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("NEW_SUPABASE_SECRET_KEY") ??
  "";

const MAX_TEXT_BYTES = 100_000; // 100 KB
const MAX_PDF_BYTES = 10_485_760; // 10 MB
const MAX_IMAGE_BYTES = 5_242_880; // 5 MB
const MAX_UPLOADS_PER_USER = 50;
const MAX_CHUNKS_PER_UPLOAD = 64;

interface EmbedRequest {
  type: "text" | "pdf" | "image";
  content: string; // text content or base64
  filename: string;
  mimeType?: string; // for images: image/jpeg, image/png, etc.
  pdfBase64?: string; // optional raw PDF for ≤6 page inline embedding
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    // ── Auth: extract user_id from JWT ──────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing authorization" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");

    const supabaseAuth = createClient(supabaseUrl, adminKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }
    const userId = user.id;

    // Admin client for DB operations (bypasses RLS)
    const supabase = createClient(supabaseUrl, adminKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Parse request ──────────────────────────────────────────
    const body: EmbedRequest = await req.json();
    const { type, content, filename, mimeType, pdfBase64 } = body;

    if (!type || !content || !filename) {
      return jsonResponse(
        { error: "Missing required fields: type, content, filename" },
        400,
      );
    }

    if (!["text", "pdf", "image"].includes(type)) {
      return jsonResponse({ error: "Invalid type. Must be text, pdf, or image" }, 400);
    }

    // ── Size validation ────────────────────────────────────────
    const contentBytes = new TextEncoder().encode(content).length;
    if (type === "text" && contentBytes > MAX_TEXT_BYTES) {
      return jsonResponse({ error: "Text exceeds 100KB limit" }, 400);
    }
    if (type === "pdf" && contentBytes > MAX_PDF_BYTES) {
      return jsonResponse({ error: "PDF text exceeds 10MB limit" }, 400);
    }
    if (type === "image") {
      // base64 is ~4/3 of raw size
      const rawBytes = Math.ceil(contentBytes * 0.75);
      if (rawBytes > MAX_IMAGE_BYTES) {
        return jsonResponse({ error: "Image exceeds 5MB limit" }, 400);
      }
    }

    // ── Upload count limit ─────────────────────────────────────
    const { count } = await supabase
      .from("user_uploads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if ((count ?? 0) >= MAX_UPLOADS_PER_USER) {
      return jsonResponse(
        { error: `Upload limit reached (${MAX_UPLOADS_PER_USER}). Delete some uploads first.` },
        400,
      );
    }

    // ── Create upload record ───────────────────────────────────
    const { data: upload, error: uploadErr } = await supabase
      .from("user_uploads")
      .insert({
        user_id: userId,
        filename,
        file_type: type,
        status: "processing",
        metadata: { mimeType: mimeType ?? null },
      })
      .select("id")
      .single();

    if (uploadErr || !upload) {
      console.error("[embed-user-content] Failed to create upload:", uploadErr?.message);
      return jsonResponse({ error: "Failed to create upload record" }, 500);
    }

    const uploadId = upload.id;

    try {
      let chunkCount = 0;

      if (type === "text" || type === "pdf") {
        // ── Text/PDF: chunk → embed → insert ─────────────────
        const now = new Date().toLocaleDateString("en-AU", {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        });
        const contextHeader = `User Upload: ${filename} | Type: ${type} | Date: ${now}`;
        const sourceType = type === "pdf" ? "pdf_chunk" : "text_chunk";

        const chunks = sentenceAwareChunks(content, contextHeader);
        const limited = chunks.slice(0, MAX_CHUNKS_PER_UPLOAD);

        if (limited.length === 0) {
          await updateUploadStatus(supabase, uploadId, "failed", 0, "No content to embed");
          return jsonResponse({ error: "No content to embed" }, 400);
        }

        // Batch embed via OpenAI
        const embeddings = await getBatchEmbeddings(limited);

        // Insert chunks
        const rows = limited.map((chunkText, i) => ({
          user_id: userId,
          upload_id: uploadId,
          chunk_index: i,
          source_type: sourceType,
          content_text: chunkText,
          embedding: vectorString(embeddings[i]),
          metadata: { filename, type },
        }));

        const { error: insertErr } = await supabase
          .from("user_document_chunks")
          .insert(rows);

        if (insertErr) {
          console.error("[embed-user-content] Chunk insert failed:", insertErr.message);
          // Fallback: insert one by one
          let inserted = 0;
          for (const row of rows) {
            const { error } = await supabase
              .from("user_document_chunks")
              .insert(row);
            if (!error) inserted++;
          }
          chunkCount = inserted;
        } else {
          chunkCount = limited.length;
        }

        // PDF holistic embedding skipped (OpenAI doesn't support inline PDF embedding).
        // Text chunks above cover the content.
      } else if (type === "image") {
        // ── Image: embed filename/metadata as text (OpenAI is text-only) ──
        const resolvedMime = mimeType ?? "image/jpeg";
        const descriptionText = `User uploaded image: ${filename} (${resolvedMime})`;
        const [embedding] = await getBatchEmbeddings([descriptionText]);

        const { error: insertErr } = await supabase
          .from("user_document_chunks")
          .insert({
            user_id: userId,
            upload_id: uploadId,
            chunk_index: 0,
            source_type: "image_embedding",
            content_text: descriptionText,
            embedding: vectorString(embedding),
            metadata: { filename, mimeType: resolvedMime },
          });

        if (insertErr) {
          console.error("[embed-user-content] Image insert failed:", insertErr.message);
          throw new Error("Failed to store image embedding");
        }
        chunkCount = 1;
      }

      // ── Update upload status ───────────────────────────────
      await updateUploadStatus(supabase, uploadId, "completed", chunkCount);

      return jsonResponse({
        uploadId,
        status: "completed",
        chunkCount,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "Unknown error";
      console.error("[embed-user-content] Processing failed:", msg);
      await updateUploadStatus(supabase, uploadId, "failed", 0, msg);
      return jsonResponse({ error: msg }, 500);
    }
  } catch (err) {
    console.error("[embed-user-content] Unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});

async function updateUploadStatus(
  supabase: ReturnType<typeof createClient>,
  uploadId: string,
  status: string,
  chunkCount: number,
  errorMessage?: string,
) {
  const update: Record<string, unknown> = {
    status,
    chunk_count: chunkCount,
    updated_at: new Date().toISOString(),
  };
  if (errorMessage) update.error_message = errorMessage;

  await supabase.from("user_uploads").update(update).eq("id", uploadId);
}
