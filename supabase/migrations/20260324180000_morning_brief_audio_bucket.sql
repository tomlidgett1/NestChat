-- Private bucket for ElevenLabs morning brief MP3s; Edge uses service role to upload + sign URLs for Linq fetch.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'morning-brief-audio',
  'morning-brief-audio',
  false,
  5242880,
  ARRAY['audio/mpeg']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
