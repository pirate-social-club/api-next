-- Source grants owns 0123. Reconcile ordinals and regenerate after its merge.
-- There was no production consumer for this ledger. Never invent attempt dates
-- for an unexpected manually started row during rollout.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM media_video_stream_ingests WHERE state <> 'not_started') THEN
    RAISE EXCEPTION 'video delivery migration requires disposition of preexisting ingest attempts';
  END IF;
  IF EXISTS (SELECT 1 FROM media_video_enrichment_outbox WHERE state = 'running') THEN
    RAISE EXCEPTION 'video delivery migration requires disposition of preexisting running enrichment';
  END IF;
END $$;

ALTER TABLE media_video_enrichment_outbox
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CONSTRAINT media_video_enrichment_lease_shape CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  );

ALTER TABLE media_video_stream_ingests
  DROP CONSTRAINT media_video_stream_ingest_shape,
  DROP CONSTRAINT media_video_stream_ingests_state_check,
  ADD COLUMN ingest_revision bigint NOT NULL DEFAULT 0 CHECK (ingest_revision >= 0),
  ADD COLUMN acceptance_deadline_ms bigint,
  ADD COLUMN encoding_deadline_ms bigint,
  ADD COLUMN failure_reason text,
  ADD CONSTRAINT media_video_stream_ingests_state_check CHECK (
    state IN ('not_started','sending','bound','ready','failed','reconciliation_required')
  ),
  ADD CONSTRAINT media_video_stream_ingest_shape CHECK (
    (state = 'not_started' AND creator_marker IS NULL AND source_sha256 IS NULL
      AND provider_video_id IS NULL AND acceptance_deadline_ms IS NULL
      AND encoding_deadline_ms IS NULL AND failure_reason IS NULL)
    OR (
      state <> 'not_started' AND creator_marker IS NOT NULL
      AND creator_marker ~ '^[A-Za-z0-9_-]{1,64}$' AND source_sha256 IS NOT NULL
      AND acceptance_deadline_ms IS NOT NULL AND acceptance_deadline_ms > 0
      AND encoding_deadline_ms IS NOT NULL AND encoding_deadline_ms >= acceptance_deadline_ms
      AND encoding_deadline_ms <= 9007199254740991
      AND (
        (state = 'sending' AND provider_video_id IS NULL AND failure_reason IS NULL)
        OR (state IN ('bound','ready') AND provider_video_id IS NOT NULL
          AND btrim(provider_video_id) <> '' AND failure_reason IS NULL)
        OR (state = 'failed' AND provider_video_id IS NOT NULL
          AND btrim(provider_video_id) <> '' AND failure_reason IS NOT NULL
          AND failure_reason IN ('encoding_failed','encoding_timeout'))
        OR (state = 'reconciliation_required' AND provider_video_id IS NULL
          AND failure_reason IS NOT NULL AND failure_reason IN
            ('acceptance_unknown','identity_mismatch','multiple_matches','unsafe_delivery'))
      )
    )
  );

CREATE INDEX media_video_enrichment_eligible
  ON media_video_enrichment_outbox (enrichment_kind, lease_expires_at, created_at, effect_identity)
  WHERE state IN ('pending','running');
