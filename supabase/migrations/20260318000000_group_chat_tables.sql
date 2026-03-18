-- Group chat tables for tracking groups Nest participates in.
-- Privacy model: group chats are fully isolated from individual user data.
-- Nest knows ONLY display names and group conversation history — no memory,
-- profiles, calendar, email, contacts, or RAG data is accessible in groups.

-- ── Group chat registry ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.group_chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    participant_count INTEGER NOT NULL DEFAULT 0,
    group_vibe TEXT DEFAULT 'mixed'
        CHECK (group_vibe IN ('banter', 'professional', 'planning', 'supportive', 'mixed')),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_nest_link_at TIMESTAMPTZ,
    messages_since_link INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_chats_chat_id ON public.group_chats(chat_id);
CREATE INDEX IF NOT EXISTS idx_group_chats_last_activity ON public.group_chats(last_activity_at DESC);

-- ── Group chat members (names only — no personal data) ───────
CREATE TABLE IF NOT EXISTS public.group_chat_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_chat_id UUID NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    display_name TEXT,
    service TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
    joined_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_chat_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_group_chat_members_group ON public.group_chat_members(group_chat_id);
CREATE INDEX IF NOT EXISTS idx_group_chat_members_handle ON public.group_chat_members(handle);

-- ── Auto-update updated_at ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_group_chats_updated_at'
    ) THEN
        CREATE TRIGGER trg_group_chats_updated_at
            BEFORE UPDATE ON public.group_chats
            FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_group_chat_members_updated_at'
    ) THEN
        CREATE TRIGGER trg_group_chat_members_updated_at
            BEFORE UPDATE ON public.group_chat_members
            FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END $$;
