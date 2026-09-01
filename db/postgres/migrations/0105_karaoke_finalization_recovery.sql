-- Keep the every-minute Karaoke recovery sweep bounded by due work instead of
-- scanning the complete session and recording histories.

CREATE INDEX karaoke_sessions_active_expiry_recovery_idx
  ON karaoke_sessions (expires_at, session_id)
  WHERE status = 'active';

CREATE INDEX karaoke_recordings_pending_recovery_idx
  ON karaoke_recordings (created_at, session_id, attempt_id)
  WHERE state = 'pending';
