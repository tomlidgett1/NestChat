-- ============================================================================
-- Ingestion job queue for RAG Phase 2 — external data ingestion
-- Adapted from TapMeeting's task-queue architecture.
-- ============================================================================

-- ── ingestion_jobs: top-level job tracking ──────────────────────

CREATE TABLE IF NOT EXISTS public.ingestion_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle TEXT NOT NULL,
    auth_user_id UUID,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    mode TEXT NOT NULL DEFAULT 'full'
        CHECK (mode IN ('full', 'incremental')),
    sources_requested TEXT[] DEFAULT '{}',
    progress JSONB DEFAULT '{}',
    total_documents INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 0,
    total_embeddings INTEGER DEFAULT 0,
    error_message TEXT,
    account_emails TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all_ingestion_jobs ON public.ingestion_jobs
    FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_handle
    ON public.ingestion_jobs (handle);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
    ON public.ingestion_jobs (status);

-- ── ingestion_tasks: atomic units of work ───────────────────────

CREATE TABLE IF NOT EXISTS public.ingestion_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.ingestion_jobs(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    auth_user_id UUID,
    task_type TEXT NOT NULL CHECK (task_type IN ('emails', 'calendar', 'transcript')),
    params JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    result JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.ingestion_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all_ingestion_tasks ON public.ingestion_tasks
    FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_ingestion_tasks_job_status
    ON public.ingestion_tasks (job_id, status);
CREATE INDEX IF NOT EXISTS idx_ingestion_tasks_pending
    ON public.ingestion_tasks (status, created_at)
    WHERE status = 'pending';

-- ── Unique index on search_documents for upsert-by-content-hash ─

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_documents_handle_content_hash
    ON public.search_documents (handle, content_hash)
    WHERE content_hash != '' AND content_hash IS NOT NULL;

-- ── pg_cron: ingest-cron every 5 minutes ────────────────────────

SELECT cron.schedule(
    'ingest-cron-5min',
    '*/5 * * * *',
    $$
    SELECT net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/ingest-cron',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
    );
    $$
);
