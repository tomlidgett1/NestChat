-- ============================================================
-- Migrate user_document_chunks from vector(1536) to halfvec(3072)
-- Gemini embedding-2-preview now outputs 3072-dim vectors
-- (matching the main RAG pipeline's halfvec(3072) format).
--
-- Existing 1536-dim vectors are incompatible, so we truncate
-- the chunks table and mark uploads as needing re-upload.
-- ============================================================

-- 1. Drop the HNSW index (can't alter column type with index present)
DROP INDEX IF EXISTS idx_user_document_chunks_embedding_hnsw;

-- 2. Truncate incompatible 1536-dim embeddings
TRUNCATE public.user_document_chunks;

-- 3. Alter column type to halfvec(3072)
ALTER TABLE public.user_document_chunks
    ALTER COLUMN embedding TYPE halfvec(3072);

-- 4. Recreate HNSW index with halfvec cosine ops
CREATE INDEX idx_user_document_chunks_embedding_hnsw
    ON public.user_document_chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- 5. Mark existing uploads so users know to re-upload
-- Add 'needs_reupload' as valid status
ALTER TABLE public.user_uploads
    DROP CONSTRAINT IF EXISTS user_uploads_status_check;

ALTER TABLE public.user_uploads
    ADD CONSTRAINT user_uploads_status_check
    CHECK (status IN ('processing', 'completed', 'failed', 'needs_reupload'));

UPDATE public.user_uploads
    SET status = 'needs_reupload', chunk_count = 0;

-- 6. Drop the OLD vector(1536) overload so PostgREST doesn't get a 300 Multiple Choices
DROP FUNCTION IF EXISTS public.match_user_document_chunks(UUID, vector, INT, FLOAT);

-- 7. Replace the similarity search function for 3072-dim halfvec
CREATE OR REPLACE FUNCTION public.match_user_document_chunks(
    p_user_id UUID,
    query_embedding halfvec(3072),
    match_count INT DEFAULT 20,
    min_score FLOAT DEFAULT 0.30
)
RETURNS TABLE (
    chunk_id UUID,
    upload_id UUID,
    chunk_index INT,
    source_type TEXT,
    content_text TEXT,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        c.id AS chunk_id,
        c.upload_id,
        c.chunk_index,
        c.source_type,
        c.content_text,
        c.metadata,
        (1 - (c.embedding <=> query_embedding))::float AS similarity
    FROM public.user_document_chunks c
    WHERE c.user_id = p_user_id
      AND (1 - (c.embedding <=> query_embedding)) >= min_score
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
$$;
