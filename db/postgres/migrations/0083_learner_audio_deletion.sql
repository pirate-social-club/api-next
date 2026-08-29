-- Account-scoped learner-audio deletion reads only live reservations and stored artifacts.
CREATE INDEX study_spoken_answer_commands_live_account_idx
  ON study_spoken_answer_commands (account_id, lease_expires_at)
  WHERE state = 'reserved';

CREATE INDEX karaoke_sessions_live_account_idx
  ON karaoke_sessions (account_id, expires_at)
  WHERE status = 'active';

CREATE INDEX learner_audio_artifacts_stored_account_idx
  ON learner_audio_artifacts (account_id, created_at, learner_audio_artifact_id)
  WHERE recording_state = 'stored';
