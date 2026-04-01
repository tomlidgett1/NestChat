-- ============================================================
-- Fix: Embedding model mismatch + FTS recall
--
-- Problems fixed:
-- 1. hybrid_search_documents searched ALL embeddings regardless
--    of model. Mixed embedding models produce near-zero similarity.
--    Now filters to text-embedding-3-large only.
-- 2. FTS used plainto_tsquery (AND logic), so multi-word queries
--    required ALL terms to match. Now uses OR for filtering
--    (any term matches) while keeping AND for ranking (more
--    matching terms = higher score).
-- ============================================================

-- Helper: build an OR-based tsquery from free-text input.
-- Each word is stemmed independently, then combined with OR.
-- Filters out single-character words and empty stems.
CREATE OR REPLACE FUNCTION public.build_or_tsquery(query_text TEXT)
RETURNS tsquery
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT COALESCE(
    string_agg(plainto_tsquery('english', word)::text, ' | ')::tsquery,
    plainto_tsquery('english', query_text)
  )
  FROM unnest(regexp_split_to_array(trim(query_text), '\s+')) AS word
  WHERE length(word) > 1
    AND plainto_tsquery('english', word)::text != '';
$$;


-- ============================================================
-- Updated hybrid_search_documents
-- Changes:
--   1. Added e.embedding_model = 'text-embedding-3-large'
--      to the semantic CTE so only compatible vectors are compared
--   2. Changed FTS WHERE from plainto_tsquery (AND) to
--      build_or_tsquery (OR) for much better recall
--   3. Kept plainto_tsquery for ts_rank_cd scoring so docs
--      matching MORE terms still rank higher
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
          AND e.embedding_model = 'text-embedding-3-large'
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
          AND d.fts_vector @@ build_or_tsquery(query_text)
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
-- Updated match_search_documents (pure semantic fallback)
-- Added embedding_model filter for same reason.
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
      AND e.embedding_model = 'text-embedding-3-large'
      AND (source_filters IS NULL OR d.source_type = ANY(source_filters))
      AND (1 - (e.embedding <=> query_embedding)) >= min_score
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
$$;
