// Ingestion helpers — soft-delete old documents, insert new ones,
// check if source needs re-indexing.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EmbeddedChunk } from "./embedder.ts";

// ── Soft-delete stale documents ──────────────────────────────

export async function softDeleteSource(
  supabase: SupabaseClient,
  handle: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("search_documents")
    .delete()
    .eq("handle", handle)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId);

  if (error) {
    console.warn(`[ingestion-helpers] softDeleteSource failed for ${sourceType}:${sourceId}:`, error.message);
  }
}

export async function softDeleteSourceTypes(
  supabase: SupabaseClient,
  handle: string,
  sourceTypes: string[],
): Promise<void> {
  for (const st of sourceTypes) {
    const { error } = await supabase
      .from("search_documents")
      .delete()
      .eq("handle", handle)
      .eq("source_type", st);

    if (error) {
      console.warn(`[ingestion-helpers] bulk delete ${st}:`, error.message);
    }
  }
}

// ── Insert embedded documents (two-table: search_documents + search_embeddings) ──

const INSERT_BATCH_SIZE = 25;

export async function insertEmbeddedChunks(
  supabase: SupabaseClient,
  handle: string,
  chunks: EmbeddedChunk[],
): Promise<{ inserted: number; errors: number }> {
  if (chunks.length === 0) return { inserted: 0, errors: 0 };

  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + INSERT_BATCH_SIZE);

    const docRows = batch.map((chunk) => {
      const isSummary = chunk.sourceType.endsWith("_summary");
      const row: Record<string, any> = {
        handle,
        source_type: chunk.sourceType,
        source_id: chunk.sourceId,
        title: chunk.title,
        content_hash: chunk.contentHash,
        metadata: chunk.metadata ?? {},
        is_deleted: false,
      };
      if (isSummary) {
        row.summary_text = chunk.text;
      } else {
        row.chunk_text = chunk.text;
      }
      return row;
    });

    const { data: docs, error: docErr } = await supabase
      .from("search_documents")
      .insert(docRows)
      .select("id, content_hash");

    if (docErr) {
      console.warn(`[ingestion-helpers] batch insert failed, falling back to individual:`, docErr.message);
      for (let j = 0; j < batch.length; j++) {
        try {
          const result = await insertSingleChunk(supabase, handle, batch[j]);
          if (result) inserted++;
          else errors++;
        } catch {
          errors++;
        }
      }
      continue;
    }

    if (!docs || docs.length === 0) {
      errors += batch.length;
      continue;
    }

    const hashToId = new Map<string, string>();
    for (const doc of docs) {
      hashToId.set(doc.content_hash, doc.id);
    }

    const embRows = batch
      .map((chunk) => {
        const docId = hashToId.get(chunk.contentHash);
        if (!docId) return null;
        return {
          handle,
          document_id: docId,
          embedding: chunk.embeddingStr,
          embedding_model: "text-embedding-3-large",
          model_version: "2024-01",
        };
      })
      .filter(Boolean) as Record<string, any>[];

    if (embRows.length > 0) {
      const { error: embErr } = await supabase
        .from("search_embeddings")
        .upsert(embRows, { onConflict: "document_id,embedding_model,model_version" });

      if (embErr) {
        console.error(`[ingestion-helpers] embedding batch upsert failed:`, embErr.message);
        errors += embRows.length;
      } else {
        inserted += embRows.length;
      }
    }

    const missed = batch.length - embRows.length;
    if (missed > 0) errors += missed;
  }

  return { inserted, errors };
}

async function insertSingleChunk(
  supabase: SupabaseClient,
  handle: string,
  chunk: EmbeddedChunk,
): Promise<boolean> {
  const isSummary = chunk.sourceType.endsWith("_summary");
  const docRow: Record<string, any> = {
    handle,
    source_type: chunk.sourceType,
    source_id: chunk.sourceId,
    title: chunk.title,
    content_hash: chunk.contentHash,
    metadata: chunk.metadata ?? {},
    is_deleted: false,
  };
  if (isSummary) docRow.summary_text = chunk.text;
  else docRow.chunk_text = chunk.text;

  const { data: existing } = await supabase
    .from("search_documents")
    .select("id")
    .eq("handle", handle)
    .eq("content_hash", chunk.contentHash)
    .maybeSingle();

  let docId: string;
  if (existing) {
    await supabase.from("search_documents").update(docRow).eq("id", existing.id);
    docId = existing.id;
  } else {
    const { data: created, error } = await supabase
      .from("search_documents")
      .insert(docRow)
      .select("id")
      .single();
    if (error || !created) return false;
    docId = created.id;
  }

  const embRow = {
    handle,
    document_id: docId,
    embedding: chunk.embeddingStr,
    embedding_model: "text-embedding-3-large",
    model_version: "2024-01",
  };

  const { error: embErr } = await supabase
    .from("search_embeddings")
    .upsert(embRow, { onConflict: "document_id,embedding_model,model_version" });

  return !embErr;
}

// ── Bulk-delete sources (one query per source type) ─────────

export async function bulkDeleteSources(
  supabase: SupabaseClient,
  handle: string,
  sourceType: string,
  sourceIds: string[],
): Promise<void> {
  if (sourceIds.length === 0) return;

  const { error } = await supabase
    .from("search_documents")
    .delete()
    .eq("handle", handle)
    .eq("source_type", sourceType)
    .in("source_id", sourceIds);

  if (error) {
    console.warn(`[ingestion-helpers] bulkDeleteSources failed for ${sourceType} (${sourceIds.length} ids):`, error.message);
  }
}

// ── Bulk check which sources need updating ──────────────────

export async function bulkCheckNeedsUpdate(
  supabase: SupabaseClient,
  handle: string,
  sourceType: string,
  items: Array<{ sourceId: string; contentHash: string }>,
): Promise<Set<string>> {
  if (items.length === 0) return new Set();

  const sourceIds = items.map((i) => i.sourceId);

  const { data } = await supabase
    .from("search_documents")
    .select("source_id, content_hash")
    .eq("handle", handle)
    .eq("source_type", sourceType)
    .in("source_id", sourceIds);

  const existingHashes = new Map<string, string>();
  for (const row of data ?? []) {
    existingHashes.set(row.source_id, row.content_hash);
  }

  const needsUpdate = new Set<string>();
  for (const item of items) {
    const existing = existingHashes.get(item.sourceId);
    if (!existing || existing !== item.contentHash) {
      needsUpdate.add(item.sourceId);
    }
  }

  return needsUpdate;
}

// ── Check if source has changed (single-item, used by memory/conversations) ─

export async function sourceNeedsUpdate(
  supabase: SupabaseClient,
  handle: string,
  sourceType: string,
  sourceId: string,
  newContentHash: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("search_documents")
    .select("content_hash")
    .eq("handle", handle)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .limit(1)
    .maybeSingle();

  if (!data) return true;
  return data.content_hash !== newContentHash;
}
