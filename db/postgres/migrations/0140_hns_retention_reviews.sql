-- Persisted retention reviews and the retirement authorization derived from
-- them — spec 012, "Authority retention, quota, and retirement" and
-- `retention_review_v1`.
--
-- Until now `retirement_authorization` returned null everywhere and every
-- teardown retained. That was the safe posture while nothing could record a
-- review, but it charges retained zones, keysets and reservations against the
-- admission quota indefinitely. This makes retirement reachable, and only
-- through evidence.
--
-- A review is a durable record of one fresh current-and-safe inspection of one
-- authority generation. It never expresses a wall-clock permission: the spec is
-- explicit that no wall-clock value alone authorizes deletion or release, so
-- `reviewed_at` schedules the next review and bounds evidence age, and never
-- substitutes for the inspection itself.

CREATE TABLE hns_root_import_retention_reviews (
  retention_review_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_import_session_id TEXT NOT NULL,
  -- The exact authority generation inspected. An authorization is valid only
  -- for the generation it was recorded against: a superseded operation holds
  -- different infrastructure, and reusing an older decision would authorize
  -- deleting something nobody inspected.
  authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  current_observed_at TIMESTAMPTZ,
  safe_observed_at TIMESTAMPTZ,
  current_resource_sha256 TEXT,
  safe_resource_sha256 TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('retain', 'retire_authorized', 'superseded')),
  reason TEXT NOT NULL CHECK (btrim(reason) = reason AND octet_length(reason) BETWEEN 1 AND 256),
  evidence_ref TEXT NOT NULL
    CHECK (btrim(evidence_ref) = evidence_ref AND octet_length(evidence_ref) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_retention_review_evidence_shape CHECK (
    -- Authorizing retirement requires both views to have been inspected in
    -- this review. A retain decision may record whatever it saw, including
    -- nothing when the chain was unavailable.
    decision <> 'retire_authorized'
    OR (current_observed_at IS NOT NULL AND safe_observed_at IS NOT NULL)
  ),
  CONSTRAINT hns_retention_review_digest_shape CHECK (
    (current_resource_sha256 IS NULL OR current_resource_sha256 ~ '^[0-9a-f]{64}$')
    AND (safe_resource_sha256 IS NULL OR safe_resource_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT hns_retention_review_unique_evidence
    UNIQUE (root_import_session_id, evidence_ref)
);

CREATE INDEX hns_root_import_retention_reviews_session_idx
  ON hns_root_import_retention_reviews(root_import_session_id, reviewed_at DESC);

-- Reviews are evidence. Rewriting one would rewrite the record of a decision
-- that may already have deleted infrastructure.
CREATE OR REPLACE FUNCTION reject_hns_retention_review_change_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HNS retention reviews are append-only';
END;
$$;

CREATE TRIGGER hns_root_import_retention_reviews_change_guard
BEFORE UPDATE OR DELETE ON hns_root_import_retention_reviews
FOR EACH ROW EXECUTE FUNCTION reject_hns_retention_review_change_v1();

-- Returns an authorization only when one was recorded against the operation's
-- current authority generation and its evidence is still fresh. Everything
-- else returns no row, which the caller treats as retain.
CREATE OR REPLACE FUNCTION authorize_hns_root_import_retirement_v1(
  input_session_id TEXT,
  input_freshness_seconds INTEGER
) RETURNS TABLE (
  kind TEXT,
  recorded_at TIMESTAMPTZ,
  evidence_ref TEXT,
  authority_generation BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  current_generation BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_freshness_seconds IS NULL OR input_freshness_seconds NOT BETWEEN 1 AND 604800 THEN
    RAISE EXCEPTION 'invalid HNS retirement freshness bound';
  END IF;
  SELECT lifecycle.generation INTO current_generation
    FROM hns_root_import_lifecycle AS lifecycle
   WHERE lifecycle.root_import_session_id = input_session_id;
  IF NOT FOUND THEN
    -- No lifecycle means no inspected generation to validate against.
    RETURN;
  END IF;
  RETURN QUERY
    SELECT CASE WHEN review.decision = 'superseded' THEN 'supersession' ELSE 'retention_review' END,
           review.reviewed_at, review.evidence_ref, review.authority_generation
      FROM hns_root_import_retention_reviews AS review
     WHERE review.root_import_session_id = input_session_id
       AND review.decision IN ('retire_authorized', 'superseded')
       AND review.authority_generation = current_generation
       AND review.reviewed_at > database_now - (input_freshness_seconds * interval '1 second')
     ORDER BY review.reviewed_at DESC
     LIMIT 1;
END;
$$;
