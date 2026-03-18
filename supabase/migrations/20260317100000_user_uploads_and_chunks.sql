-- ============================================================
-- User Uploads & Document Chunks
-- Stores user-uploaded content (PDFs, images, text) with
-- Gemini embedding-2-preview multimodal embeddings (1536 dims)
-- ============================================================

-- pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: user_uploads
-- Tracks each user upload session (metadata + status)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'image', 'text')),
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    chunk_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_uploads_user_id
    ON public.user_uploads (user_id);

ALTER TABLE public.user_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_uploads_select ON public.user_uploads
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY user_uploads_insert ON public.user_uploads
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_uploads_delete ON public.user_uploads
    FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY user_uploads_update ON public.user_uploads
    FOR UPDATE USING (auth.uid() = user_id);

-- ============================================================
-- Table: user_document_chunks
-- Stores text chunks + Gemini 1536-dim multimodal embeddings
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    upload_id UUID NOT NULL REFERENCES public.user_uploads(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL CHECK (source_type IN ('pdf_chunk', 'image_embedding', 'text_chunk')),
    content_text TEXT,
    embedding vector(1536) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Stored tsvector for lexical search on chunk text
    fts_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content_text, ''))
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_user_document_chunks_user_id
    ON public.user_document_chunks (user_id);

CREATE INDEX IF NOT EXISTS idx_user_document_chunks_upload_id
    ON public.user_document_chunks (upload_id);

CREATE INDEX IF NOT EXISTS idx_user_document_chunks_fts
    ON public.user_document_chunks USING gin(fts_vector);

-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX IF NOT EXISTS idx_user_document_chunks_embedding_hnsw
    ON public.user_document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

ALTER TABLE public.user_document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_document_chunks_select ON public.user_document_chunks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY user_document_chunks_insert ON public.user_document_chunks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_document_chunks_delete ON public.user_document_chunks
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- Function: match_user_document_chunks
-- Cosine similarity search over user-uploaded content
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_user_document_chunks(
    p_user_id UUID,
    query_embedding vector(1536),
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
