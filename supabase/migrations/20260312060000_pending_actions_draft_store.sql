-- Upgrade pending_actions to serve as the full draft store per OpenAI recommended architecture.
-- email_draft now stores locally (no Gmail API call), email_send creates + sends in one shot.

alter table public.pending_actions
  add column if not exists body_text text,
  add column if not exists body_html text,
  add column if not exists cc jsonb not null default '[]'::jsonb,
  add column if not exists bcc jsonb not null default '[]'::jsonb,
  add column if not exists reply_to_thread_id text,
  add column if not exists reply_all boolean not null default false,
  add column if not exists provider_message_id text,
  add column if not exists sent_at timestamptz;
