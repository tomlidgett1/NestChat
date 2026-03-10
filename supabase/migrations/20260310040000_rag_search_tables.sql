-- ============================================================
-- RAG Search Infrastructure
-- pgvector tables, HNSW index, stored tsvector, hybrid search
-- with Reciprocal Rank Fusion (RRF) + time decay
-- ============================================================

-- pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: search_documents
-- Canonical store for all searchable content (text + metadata)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.search_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
        source_type IN (
            'conversation_summary',
            'conversation_chunk',
            'memory_summary',
            'memory_chunk',
            'email_summary',
            'email_chunk',
            'calendar_summary',
            'calendar_chunk',
            'meeting_summary',
            'meeting_chunk',
            'utterance_chunk',
            'note_summary',
            'note_chunk'
        )
    ),
    source_id TEXT NOT NULL,
    parent_id UUID REFERENCES public.search_documents(id) ON DELETE CASCADE,
    title TEXT,
    summary_text TEXT,
    chunk_text TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    token_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Stored tsvector for fast lexical search (no per-query computation)
    fts_vector tsvector GENERATED ALWAYS AS (
        to_tsvector(
            'english',
            coalesce(title, '') || ' ' ||
            coalesce(summary_text, '') || ' ' ||
            coalesce(chunk_text, '')
        )
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_search_documents_handle
    ON public.search_documents (handle);

CREATE INDEX IF NOT EXISTS idx_search_documents_handle_source
    ON public.search_documents (handle, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_search_documents_content_hash
    ON public.search_documents (handle, content_hash);

CREATE INDEX IF NOT EXISTS idx_search_documents_fts
    ON public.search_documents USING gin(fts_vector);

ALTER TABLE public.search_documents ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Table: search_embeddings
-- Vector store (OpenAI text-embedding-3-large = 3072 dims)
-- Uses halfvec to halve storage (16-bit vs 32-bit floats)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.search_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle TEXT NOT NULL,
    document_id UUID NOT NULL REFERENCES public.search_documents(id) ON DELETE CASCADE,
    embedding halfvec(3072) NOT NULL,
    embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-large',
    model_version TEXT NOT NULL DEFAULT '2024-01',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, embedding_model, model_version)
);

CREATE INDEX IF NOT EXISTS idx_search_embeddings_handle
    ON public.search_embeddings (handle);

-- HNSW index for fast approximate nearest-neighbour search
-- m=16, ef_construction=200 gives ~95% recall
CREATE INDEX IF NOT EXISTS idx_search_embeddings_vector_hnsw
    ON public.search_embeddings
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- ============================================================
-- Function: hybrid_search_documents
-- Combines semantic (vector) + lexical (FTS) via RRF scoring
-- with time decay for recency bias
-- ============================================================

CREATE OR REPLACE FUNCTION public.hybrid_search_documents(
    p_handle TEXT,
    query_text TEXT,
    query_embedding halfvec(3072),
    match_count INT DEFAULT 30,
    source_filters TEXT[] DEFAULT NULL,
    min_semantic_score FLOAT DEFAULT 0.28
)
RETURNS TABLE (
    document_id UUID,
    source_type TEXT,
    source_id TEXT,
    title TEXT,
    summary_text TEXT,
    chunk_text TEXT,
    metadata JSONB,
    semantic_score FLOAT,
    lexical_score FLOAT,
    fused_score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '12s'
AS $$
BEGIN
    RETURN QUERY
    WITH semantic AS (
        SELECT
            d.id,
            (1 - (e.embedding <=> query_embedding))::float AS score,
            ROW_NUMBER() OVER (
                ORDER BY e.embedding <=> query_embedding
            ) AS rank
        FROM public.search_embeddings e
        JOIN public.search_documents d ON d.id = e.document_id
        WHERE d.handle = p_handle
          AND e.handle = p_handle
          AND d.is_deleted = FALSE
          AND (source_filters IS NULL OR d.source_type = ANY(source_filters))
          AND (1 - (e.embedding <=> query_embedding)) >= min_semantic_score
        ORDER BY e.embedding <=> query_embedding
        LIMIT match_count
    ),
    lexical AS (
        SELECT
            d.id,
            ts_rank_cd(d.fts_vector, plainto_tsquery('english', query_text))::float AS score,
            ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(d.fts_vector, plainto_tsquery('english', query_text)) DESC
            ) AS rank
        FROM public.search_documents d
        WHERE d.handle = p_handle
          AND d.is_deleted = FALSE
          AND (source_filters IS NULL OR d.source_type = ANY(source_filters))
          AND d.fts_vector @@ plainto_tsquery('english', query_text)
        ORDER BY ts_rank_cd(d.fts_vector, plainto_tsquery('english', query_text)) DESC
        LIMIT match_count
    ),
    combined AS (
        SELECT
            COALESCE(s.id, l.id) AS doc_id,
            COALESCE(s.score, 0)::float AS sem_score,
            COALESCE(l.score, 0)::float AS lex_score,
            COALESCE(s.rank, 9999) AS sem_rank,
            COALESCE(l.rank, 9999) AS lex_rank
        FROM semantic s
        FULL OUTER JOIN lexical l ON s.id = l.id
    )
    SELECT
        d.id AS document_id,
        d.source_type,
        d.source_id,
        d.title,
        d.summary_text,
        d.chunk_text,
        d.metadata,
        c.sem_score AS semantic_score,
        c.lex_score AS lexical_score,
        (
            (1.0 / (60 + c.sem_rank)) + (1.0 / (60 + c.lex_rank))
        )::float
        * (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - d.created_at)) / 86400.0 * 0.003))::float
        AS fused_score
    FROM combined c
    JOIN public.search_documents d ON d.id = c.doc_id
    WHERE d.handle = p_handle
      AND d.is_deleted = FALSE
    ORDER BY fused_score DESC
    LIMIT match_count;
END;
$$;

-- ============================================================
-- Function: match_search_documents
-- Pure semantic search fallback (no FTS component)
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_search_documents(
    p_handle TEXT,
    query_embedding halfvec(3072),
    match_count INT DEFAULT 30,
    source_filters TEXT[] DEFAULT NULL,
    min_score FLOAT DEFAULT 0.28
)
RETURNS TABLE (
    document_id UUID,
    source_type TEXT,
    source_id TEXT,
    title TEXT,
    summary_text TEXT,
    chunk_text TEXT,
    metadata JSONB,
    semantic_score FLOAT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        d.id AS document_id,
        d.source_type,
        d.source_id,
        d.title,
        d.summary_text,
        d.chunk_text,
        d.metadata,
        (1 - (e.embedding <=> query_embedding))::float AS semantic_score
    FROM public.search_embeddings e
    JOIN public.search_documents d ON d.id = e.document_id
    WHERE d.handle = p_handle
      AND e.handle = p_handle
      AND d.is_deleted = FALSE
      AND (source_filters IS NULL OR d.source_type = ANY(source_filters))
      AND (1 - (e.embedding <=> query_embedding)) >= min_score
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
$$;
