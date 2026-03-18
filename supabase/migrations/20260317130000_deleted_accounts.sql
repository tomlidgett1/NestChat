-- ============================================================
-- Deleted Accounts — audit trail for account deletions.
-- Retains minimal info for compliance, analytics, and support.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.deleted_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID NOT NULL,
    email TEXT NOT NULL,
    handle TEXT,
    display_name TEXT,
    connected_accounts JSONB NOT NULL DEFAULT '[]',
    deletion_reason TEXT DEFAULT 'user_requested',
    tables_cleaned TEXT[] NOT NULL DEFAULT '{}',
    errors TEXT[] NOT NULL DEFAULT '{}',
    total_documents_deleted INTEGER DEFAULT 0,
    total_chunks_deleted INTEGER DEFAULT 0,
    total_uploads_deleted INTEGER DEFAULT 0,
    account_created_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_email
    ON public.deleted_accounts (email);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
    ON public.deleted_accounts (deleted_at);

-- No RLS — only service role should access this table
ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;
