-- Immutable, bounded dance grading evidence. Raw media and pose sequences are
-- deliberately absent; external work remains coordinated in the control plane.

CREATE TABLE dance_attempt (
    dance_attempt_id TEXT NOT NULL PRIMARY KEY,
    dance_attempt_session_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    dance_choreography_revision_id TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    activity_timezone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'rejected', 'failed')),
    score_bps INTEGER CHECK (score_bps IS NULL OR score_bps BETWEEN 0 AND 10000),
    rank_eligible INTEGER NOT NULL CHECK (rank_eligible IN (0, 1)),
    quality_outcome TEXT NOT NULL CHECK (quality_outcome IN ('passed', 'rejected', 'failed')),
    integrity_outcome TEXT NOT NULL CHECK (
        integrity_outcome IN ('passed', 'reference_replay', 'duplicate_attempt', 'unavailable')
    ),
    reason_code TEXT CHECK (
        reason_code IS NULL
        OR reason_code IN (
            'video_invalid', 'duration_out_of_range', 'insufficient_coverage',
            'insufficient_pose_presence', 'multiple_people', 'reference_replay',
            'duplicate_attempt', 'scoring_unavailable', 'below_platform_floor',
            'version_mismatch'
        )
    ),
    coverage_bps INTEGER CHECK (coverage_bps IS NULL OR coverage_bps BETWEEN 0 AND 10000),
    pose_detection_bps INTEGER CHECK (
        pose_detection_bps IS NULL OR pose_detection_bps BETWEEN 0 AND 10000
    ),
    duration_ratio_bps INTEGER CHECK (
        duration_ratio_bps IS NULL OR duration_ratio_bps BETWEEN 0 AND 20000
    ),
    selected_mirror TEXT CHECK (
        selected_mirror IS NULL OR selected_mirror IN ('canonical', 'mirrored')
    ),
    temporal_offset_ms INTEGER,
    temporal_warp_bps INTEGER CHECK (
        temporal_warp_bps IS NULL OR temporal_warp_bps BETWEEN 0 AND 10000
    ),
    unmatched_coverage_bps INTEGER CHECK (
        unmatched_coverage_bps IS NULL OR unmatched_coverage_bps BETWEEN 0 AND 10000
    ),
    reference_content_sha256 TEXT NOT NULL CHECK (
        length(reference_content_sha256) = 64
        AND reference_content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    reference_feature_sha256 TEXT NOT NULL CHECK (
        length(reference_feature_sha256) = 64
        AND reference_feature_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    pose_model_version TEXT NOT NULL,
    pose_model_sha256 TEXT NOT NULL CHECK (
        length(pose_model_sha256) = 64
        AND pose_model_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    feature_schema_version TEXT NOT NULL,
    scorer_version TEXT NOT NULL,
    calibration_version TEXT NOT NULL,
    calibration_checksum TEXT NOT NULL CHECK (
        length(calibration_checksum) = 64
        AND calibration_checksum NOT GLOB '*[^0-9a-f]*'
    ),
    calibration_admitted INTEGER NOT NULL CHECK (calibration_admitted IN (0, 1)),
    fingerprint_policy_version TEXT NOT NULL,
    integrity_policy_version TEXT NOT NULL,
    whole_attempt_fingerprint_hmac TEXT CHECK (
        whole_attempt_fingerprint_hmac IS NULL
        OR (
            length(whole_attempt_fingerprint_hmac) = 64
            AND whole_attempt_fingerprint_hmac NOT GLOB '*[^0-9a-f]*'
        )
    ),
    segment_fingerprint_hmac_json TEXT,
    grader_result_digest TEXT NOT NULL CHECK (
        length(grader_result_digest) = 64
        AND grader_result_digest NOT GLOB '*[^0-9a-f]*'
    ),
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT dance_attempt_status_fields_check CHECK (
        (status = 'passed'
          AND score_bps IS NOT NULL
          AND quality_outcome = 'passed'
          AND integrity_outcome = 'passed')
        OR
        (status IN ('rejected', 'failed')
          AND rank_eligible = 0)
    ),
    CONSTRAINT dance_attempt_rank_calibration_check CHECK (
        rank_eligible = 0 OR calibration_admitted = 1
    ),
    CONSTRAINT dance_attempt_segment_fingerprint_json_check CHECK (
        segment_fingerprint_hmac_json IS NULL
        OR (
            json_valid(segment_fingerprint_hmac_json)
            AND json_type(segment_fingerprint_hmac_json) = 'array'
            AND json_array_length(segment_fingerprint_hmac_json) <= 32
        )
    ),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_dance_attempt_user_post
    ON dance_attempt(user_id, post_id, completed_at DESC);

CREATE INDEX idx_dance_attempt_revision_score
    ON dance_attempt(
        dance_choreography_revision_id,
        rank_eligible,
        score_bps DESC,
        completed_at
    );

CREATE TRIGGER dance_attempt_segment_fingerprints_insert
BEFORE INSERT ON dance_attempt
WHEN NEW.segment_fingerprint_hmac_json IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM json_each(NEW.segment_fingerprint_hmac_json)
    WHERE type <> 'text'
       OR length(value) <> 64
       OR value GLOB '*[^0-9a-f]*'
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid dance segment fingerprint');
END;

CREATE TRIGGER dance_attempt_segment_fingerprints_update
BEFORE UPDATE OF segment_fingerprint_hmac_json ON dance_attempt
WHEN NEW.segment_fingerprint_hmac_json IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM json_each(NEW.segment_fingerprint_hmac_json)
    WHERE type <> 'text'
       OR length(value) <> 64
       OR value GLOB '*[^0-9a-f]*'
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid dance segment fingerprint');
END;
