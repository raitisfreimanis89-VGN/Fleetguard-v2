-- ================================================================
-- Migration 020 — safety log attachments can be videos (2026-11-23)
--
-- Samsara clips download as MP4 (well under 1 MB); an iPhone video is
-- video/quicktime. The 10 MB limit and the admin-only policies from 019
-- are unchanged. Must match SAFETY_FILE_TYPES in js/app.js.
-- ================================================================
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf',
                                  'video/mp4','video/quicktime','video/webm']
 WHERE id = 'safety-files';
