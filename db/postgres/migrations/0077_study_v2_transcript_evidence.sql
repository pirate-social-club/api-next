-- Server-authorized, expiring transcript evidence for qualifying say-it-back
-- submissions. Raw audio custody is owned by the later source-exercises lane.

CREATE TABLE study_transcript_evidence_v2 (
  transcript_evidence_id TEXT PRIMARY KEY CHECK (
    char_length(transcript_evidence_id) BETWEEN 1 AND 256
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  session_item_id TEXT NOT NULL REFERENCES study_session_items_v2 (session_item_id),
  transcript TEXT NOT NULL CHECK (char_length(transcript) BETWEEN 1 AND 4096),
  transcription_policy_revision TEXT NOT NULL,
  provider_evidence_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  UNIQUE (transcript_evidence_id, account_id, session_item_id)
);

CREATE TRIGGER study_transcript_evidence_v2_immutable
  BEFORE UPDATE OR DELETE ON study_transcript_evidence_v2
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
