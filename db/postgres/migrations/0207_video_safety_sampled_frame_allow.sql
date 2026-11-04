-- Spec 013 v1 automatic video publication amendment (2026-09-25): the
-- sampled-frame OpenAI gate may record media allow. Allow must name the gate,
-- carry its own sampled-frame evidence and keep minor-safety evidence null;
-- every other fact stays review_required or blocked, exactly as before.
ALTER TABLE media_video_safety_evidence
  DROP CONSTRAINT video_safety_no_visual_allow;
ALTER TABLE media_video_safety_evidence
  ADD CONSTRAINT video_safety_no_visual_allow CHECK (COALESCE(
    (
      (evidence_snapshot -> 'fact' ->> 'mediaSafety') IN ('review_required', 'blocked')
      AND (evidence_snapshot -> 'fact' -> 'minorSafetyEvidenceRef') = 'null'::jsonb
    ) OR (
      (evidence_snapshot -> 'fact' ->> 'mediaSafety') = 'allow'
      AND (evidence_snapshot -> 'fact' -> 'minorSafetyEvidenceRef') = 'null'::jsonb
      AND (evidence_snapshot -> 'fact' ->> 'gateKind') = 'sampled_frame_openai_v1'
      AND (evidence_snapshot -> 'fact' ->> 'sampledFrameEvidenceRef') ~ '^sampled_frame_openai_v1_[a-f0-9]{64}$'
      AND NOT platform_held
    ),
    false
  ));
