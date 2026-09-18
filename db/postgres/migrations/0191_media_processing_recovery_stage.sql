-- A dedicated attempt stage gives the one authorized alignment recovery its own
-- persisted identity and attempt-number budget. The consumed alignment attempt
-- and its history are untouched. The stage-aware consumers keep their meaning:
-- the ACR exhaustion evidence and the reference resolver stay scoped to the ACR
-- stages, while the stage-agnostic attempt queries, the terminal alerts and the
-- store's input-kind mapping treat the recovery stage like any other attempt.

ALTER TABLE media_processing_attempts
  DROP CONSTRAINT media_processing_attempts_stage_check,
  ADD CONSTRAINT media_processing_attempts_stage_check CHECK (
    stage = ANY (ARRAY[
      'probe','sample_primary','sample_alternate','acr_primary','acr_alternate',
      'metadata','classifier','publication','alignment','alignment_recovery'
    ]::text[])
  );
