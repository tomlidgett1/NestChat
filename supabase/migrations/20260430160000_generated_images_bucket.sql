-- Create public storage bucket for Nano Banana Pro 2 generated/edited images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'generated-images',
  'generated-images',
  true,
  10485760,  -- 10MB max
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access
CREATE POLICY "Public read access for generated images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'generated-images');

-- Allow service role to upload
CREATE POLICY "Service role upload for generated images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'generated-images');
