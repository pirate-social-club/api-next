-- Reserved by api-video-execution-completion, control-plane fa31b0f (2026-09-05).
-- Bearers never enter PostgreSQL. Request identity is diagnostic, not replay identity.
CREATE TABLE media_video_source_grants (
  capability_sha256 TEXT PRIMARY KEY CHECK (capability_sha256 ~ '^[a-f0-9]{64}$'),
  request_id TEXT NOT NULL CHECK (length(request_id) >= 1 AND length(request_id) <= 512 AND btrim(request_id) = request_id),
  consumer TEXT NOT NULL CHECK (consumer IN ('qencode', 'stream')),
  immutable_ref TEXT NOT NULL REFERENCES media_immutable_objects (immutable_ref) ON DELETE CASCADE,
  physical_key TEXT NOT NULL CHECK (length(physical_key) BETWEEN 11 AND 778),
  object_version TEXT NOT NULL CHECK (btrim(object_version) <> ''),
  etag TEXT NOT NULL CHECK (btrim(etag) <> ''),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/quicktime')),
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(issued_at)),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at) AND expires_at > issued_at),
  revoked_at TIMESTAMPTZ CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= issued_at)),
  CONSTRAINT video_source_grant_key_identity CHECK (
    immutable_ref LIKE 'media://immutable/%' AND
    physical_key = 'immutable/' || substring(immutable_ref FROM length('media://immutable/') + 1)
  )
);
CREATE INDEX media_video_source_grants_request_idx ON media_video_source_grants (request_id);
CREATE INDEX media_video_source_grants_expiry_idx ON media_video_source_grants (expires_at)
  WHERE revoked_at IS NULL;
