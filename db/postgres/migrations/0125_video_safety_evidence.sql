-- Reserved in api-video-execution-completion; delivery owns ordinal 0124.
-- Private normalized evidence and automatic hold share one immutable row.
CREATE TABLE media_video_safety_evidence (
  submission_id TEXT NOT NULL,
  video_revision BIGINT NOT NULL CHECK (video_revision > 0),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  request_id TEXT NOT NULL UNIQUE CHECK (btrim(request_id) <> ''),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_ref TEXT NOT NULL CHECK (evidence_ref ~ '^evidence_[a-f0-9]{64}$'),
  evidence_snapshot JSONB NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object' AND octet_length(evidence_snapshot::text) <= 65536),
  platform_held BOOLEAN NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, video_revision, creation_revision),
  FOREIGN KEY (submission_id, video_revision) REFERENCES media_video_revisions (submission_id, video_revision),
  CONSTRAINT video_safety_no_visual_allow CHECK (COALESCE(evidence_snapshot->'fact'->>'mediaSafety' IN ('review_required', 'blocked') AND evidence_snapshot->'fact'->'minorSafetyEvidenceRef' = 'null'::jsonb, FALSE)),
  CONSTRAINT video_safety_evidence_identity CHECK (COALESCE(evidence_snapshot->>'requestId' = request_id AND evidence_snapshot->>'inputDigest' = input_sha256 AND evidence_snapshot->'fact'->>'evidenceRef' = evidence_ref AND (evidence_snapshot->>'platformHeld')::boolean = platform_held, FALSE)),
  CONSTRAINT video_safety_hold_blocked CHECK (NOT platform_held OR evidence_snapshot->'fact'->>'mediaSafety' = 'blocked' OR evidence_snapshot->'fact'->>'captionSafety' = 'blocked')
);
CREATE INDEX media_video_safety_platform_hold_idx ON media_video_safety_evidence (accepted_at, submission_id) WHERE platform_held;
CREATE TRIGGER media_video_safety_evidence_immutable BEFORE UPDATE ON media_video_safety_evidence
  FOR EACH ROW EXECUTE FUNCTION media_video_stage_fact_immutable();
