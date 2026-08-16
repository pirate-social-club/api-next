ALTER TABLE communities
  ADD COLUMN karaoke_scoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_scoring_enabled IN (0, 1));

ALTER TABLE communities
  ADD COLUMN karaoke_stt_provider TEXT NOT NULL DEFAULT 'assistant' CHECK (
    karaoke_stt_provider IN ('assistant', 'elevenlabs', 'mistral', 'openai', 'none')
  );

ALTER TABLE communities
  ADD COLUMN karaoke_stt_model TEXT NOT NULL DEFAULT '';

ALTER TABLE communities
  ADD COLUMN karaoke_voice_coach_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_voice_coach_enabled IN (0, 1));

ALTER TABLE communities
  ADD COLUMN karaoke_audio_retention TEXT NOT NULL DEFAULT 'not_stored' CHECK (
    karaoke_audio_retention = 'not_stored'
  );
