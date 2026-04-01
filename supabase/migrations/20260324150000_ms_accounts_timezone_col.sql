-- Add timezone column to user_microsoft_accounts (Google accounts already have one).
ALTER TABLE public.user_microsoft_accounts
  ADD COLUMN IF NOT EXISTS timezone text;
