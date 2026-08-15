-- Stage 1 of the posts.source_language split.
--
-- `posts.source_language` is currently overloaded across two incompatible meanings:
--   (A) the dominant language of the song's LYRICS  - consumed by Study (gating, grading, identity)
--   (B) the source language of the translatable title/body/caption - consumed by translation
--       and the "Translated from X" attribution.
--
-- This migration gives meaning (A) its own home so that (B) can later be corrected without
-- silently redefining Study semantics.
--
-- `lyrics_language`: BCP-47-ish tag for the dominant language of `posts.lyrics`.
-- NULL when the post has no lyrics or when detection abstained. Never derived from
-- title/body/caption. Consumed by learning features. Not used for translation provenance.
--
-- The provenance columns mirror the shape of 1091_source_language_detection_metadata.sql but
-- are owned by meaning (A) and must be maintained independently: long lyrics are higher-signal
-- than a short title, but not infallible (instrumentals, mixed-language songs, repeated hooks,
-- romanized text).
--
-- Additive and inert: nothing reads or writes these columns in this stage.

ALTER TABLE posts ADD COLUMN lyrics_language TEXT;
ALTER TABLE posts ADD COLUMN lyrics_language_confidence REAL;
ALTER TABLE posts ADD COLUMN lyrics_language_reliable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN lyrics_language_detector TEXT;
ALTER TABLE posts ADD COLUMN lyrics_language_detected_at TEXT;
ALTER TABLE posts ADD COLUMN lyrics_language_source_hash TEXT;
