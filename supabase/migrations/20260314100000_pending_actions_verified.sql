-- Add verified flag to pending_actions for post-send verification audit trail.
-- verified = true means we confirmed the message exists in the provider's sent folder.

alter table public.pending_actions
  add column if not exists verified boolean not null default false;
