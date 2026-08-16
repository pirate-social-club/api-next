-- Persist derived karaoke scoring diagnostics so calibration failures and
-- misleading live line scores remain auditable after Workers Logs expire.
-- This contains no transcript, recognized text, or audio.
ALTER TABLE karaoke_attempt ADD COLUMN scoring_diagnostics_json TEXT;
