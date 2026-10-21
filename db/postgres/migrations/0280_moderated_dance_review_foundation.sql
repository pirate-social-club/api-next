-- Prospective source only. No policy, provider, credential or runtime is enabled.
-- Numeric/automated Dance history is deliberately independent of this family.
CREATE FUNCTION reject_dance_review_history_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Dance review history is immutable' USING ERRCODE='DRV01'; END $$;

ALTER TABLE community_role_assignments ADD COLUMN authority_revision BIGINT NOT NULL DEFAULT 1
  CHECK(authority_revision BETWEEN 1 AND 9007199254740991);
CREATE FUNCTION advance_dance_owner_authority_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authority_revision IS DISTINCT FROM OLD.authority_revision THEN
    RAISE EXCEPTION 'owner authority revision is server maintained' USING ERRCODE='DRV01';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.authority_revision:=OLD.authority_revision+1; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dance_owner_authority_revision BEFORE UPDATE ON community_role_assignments
  FOR EACH ROW EXECUTE FUNCTION advance_dance_owner_authority_v1();

CREATE TABLE dance_review_account_fences_v1 (
  account_id TEXT PRIMARY KEY REFERENCES users(user_id), revision BIGINT NOT NULL CHECK(revision>0),
  erasing BOOLEAN NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE dance_review_policy_versions_v1 (
  policy_id TEXT PRIMARY KEY CHECK(is_dance_identifier(policy_id)),
  policy_hash TEXT NOT NULL UNIQUE CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
  review_policy JSONB NOT NULL CHECK(jsonb_typeof(review_policy)='object'),
  operational_profile JSONB NOT NULL CHECK(jsonb_typeof(operational_profile)='object'),
  disposition_profile JSONB NOT NULL CHECK(jsonb_typeof(disposition_profile)='object'),
  qualification_policy_version_id TEXT NOT NULL,
  accepted_by TEXT NOT NULL CHECK(btrim(accepted_by)<>''),
  valid_from TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(valid_until>valid_from),
  CHECK((review_policy->>'version'='moderator-review-policy-v1') IS TRUE),
  CHECK(((review_policy->>'reviewWindowMs')::NUMERIC=604800000) IS TRUE),
  CHECK((review_policy->>'hash'=policy_hash) IS TRUE),
  CHECK((review_policy->>'qualificationVersion'=qualification_policy_version_id) IS TRUE)
);
-- Admission is explicit/prospective. Changing this pointer never upgrades a capture.
CREATE TABLE dance_review_policy_admissions_v1 (
  community_id TEXT PRIMARY KEY REFERENCES communities(community_id),
  policy_id TEXT NOT NULL REFERENCES dance_review_policy_versions_v1(policy_id),
  accepted BOOLEAN NOT NULL, accepted_by TEXT NOT NULL CHECK(btrim(accepted_by)<>''),
  effective_at TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
  CHECK(valid_until>effective_at)
);

CREATE TABLE dance_moderator_reference_revisions_v1 (
  choreography_id TEXT NOT NULL CHECK(is_dance_identifier(choreography_id)),
  revision BIGINT NOT NULL CHECK(revision>0), community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL, audio_revision BIGINT NOT NULL CHECK(audio_revision>0),
  segment_id TEXT NOT NULL REFERENCES dance_song_segments(segment_id),
  reference_post_id TEXT NOT NULL, video_render_revision TEXT NOT NULL,
  reference_digest TEXT NOT NULL CHECK(reference_digest ~ '^[a-f0-9]{64}$'),
  source_binding JSONB NOT NULL CHECK(jsonb_typeof(source_binding)='object'),
  alignment_evidence JSONB NOT NULL CHECK(jsonb_typeof(alignment_evidence)='object'),
  terms_hash TEXT NOT NULL CHECK(terms_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(choreography_id,revision),
  FOREIGN KEY(community_id,song_post_id) REFERENCES posts(community_id,post_id),
  FOREIGN KEY(community_id,reference_post_id) REFERENCES posts(community_id,post_id)
);
CREATE TABLE dance_moderator_reference_cutoffs_v1 (
  choreography_id TEXT NOT NULL, revision BIGINT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN('rights','safety','retired')),
  cutoff_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(choreography_id,revision),
  FOREIGN KEY(choreography_id,revision) REFERENCES dance_moderator_reference_revisions_v1
);
CREATE TABLE dance_moderated_sessions_v1 (
  session_id TEXT PRIMARY KEY CHECK(is_dance_identifier(session_id)),
  review_id TEXT NOT NULL UNIQUE CHECK(is_dance_identifier(review_id)),
  attempt_id TEXT NOT NULL UNIQUE CHECK(is_dance_identifier(attempt_id)),
  account_id TEXT NOT NULL REFERENCES users(user_id), persona_id TEXT NOT NULL,
  community_id TEXT NOT NULL, song_post_id TEXT NOT NULL, choreography_id TEXT NOT NULL,
  choreography_revision BIGINT NOT NULL, policy_id TEXT NOT NULL REFERENCES dance_review_policy_versions_v1,
  capture_account_fence BIGINT NOT NULL CHECK(capture_account_fence>0),
  terms JSONB NOT NULL CHECK(jsonb_typeof(terms)='object'),
  terms_hash TEXT NOT NULL CHECK(terms_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN('created','consented','awaiting_upload','uploaded','terminal')),
  FOREIGN KEY(account_id,persona_id) REFERENCES personas(account_id,persona_id),
  FOREIGN KEY(community_id,song_post_id) REFERENCES posts(community_id,post_id),
  FOREIGN KEY(choreography_id,choreography_revision) REFERENCES dance_moderator_reference_revisions_v1,
  UNIQUE(session_id,review_id,account_id,community_id),
  CHECK(expires_at>created_at),
  CHECK((terms->>'session_id'=session_id AND terms->>'terms_hash'=terms_hash) IS TRUE)
);
CREATE TABLE dance_moderated_active_slots_v1 (
  account_id TEXT NOT NULL REFERENCES users(user_id), choreography_id TEXT NOT NULL,
  choreography_revision BIGINT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES dance_moderated_sessions_v1,
  PRIMARY KEY(account_id,choreography_id,choreography_revision)
);
CREATE TABLE dance_moderated_consents_v1 (
  session_id TEXT PRIMARY KEY REFERENCES dance_moderated_sessions_v1,
  receipt_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  terms_hash TEXT NOT NULL, consent_version TEXT NOT NULL, consent_hash TEXT NOT NULL,
  retention_hash TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id,receipt_id),
  CHECK(terms_hash ~ '^[a-f0-9]{64}$' AND consent_hash ~ '^[a-f0-9]{64}$' AND retention_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE dance_moderated_uploads_v1 (
  upload_id TEXT PRIMARY KEY CHECK(is_dance_identifier(upload_id)),
  session_id TEXT NOT NULL UNIQUE REFERENCES dance_moderated_sessions_v1,
  consent_receipt_id TEXT NOT NULL REFERENCES dance_moderated_consents_v1(receipt_id),
  private_object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
  maximum_bytes BIGINT NOT NULL CHECK(maximum_bytes>0), expected_duration_ms BIGINT NOT NULL CHECK(expected_duration_ms>0),
  reserved_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  first_stored_at TIMESTAMPTZ, sealed_at TIMESTAMPTZ, server_sha256 TEXT,
  normalized_digest TEXT, normalization_version TEXT, normalization_hash TEXT,
  state TEXT NOT NULL CHECK(state IN('reserved','sealing','sealed','unknown','deleted','held')),
  FOREIGN KEY(session_id,consent_receipt_id) REFERENCES dance_moderated_consents_v1(session_id,receipt_id),
  CHECK(expires_at>reserved_at), CHECK(first_stored_at IS NULL OR first_stored_at>=reserved_at),
  CHECK(server_sha256 IS NULL OR server_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK(normalized_digest IS NULL OR normalized_digest ~ '^[a-f0-9]{64}$'),
  CHECK(state NOT IN('sealed','held') OR (sealed_at IS NOT NULL AND first_stored_at IS NOT NULL
    AND server_sha256 IS NOT NULL AND normalized_digest IS NOT NULL AND normalization_version IS NOT NULL AND normalization_hash IS NOT NULL))
);
CREATE TABLE dance_moderated_reviews_v1 (
  review_id TEXT PRIMARY KEY REFERENCES dance_moderated_sessions_v1(review_id),
  session_id TEXT NOT NULL UNIQUE REFERENCES dance_moderated_sessions_v1,
  account_id TEXT NOT NULL REFERENCES users(user_id), community_id TEXT NOT NULL,
  state JSONB NOT NULL CHECK(jsonb_typeof(state)='object'),
  revision BIGINT NOT NULL CHECK(revision>0), publication_revision BIGINT NOT NULL CHECK(publication_revision>=0),
  status TEXT NOT NULL CHECK(status IN('uploaded','screening','awaiting_review','reviewed','review_expired','withdrawn','held','expired','abandoned','processing_failed')),
  uploaded_at TIMESTAMPTZ NOT NULL, review_deadline TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_id,review_id,account_id,community_id) REFERENCES dance_moderated_sessions_v1(session_id,review_id,account_id,community_id),
  CHECK((state->'capture'->>'reviewId'=review_id AND state->'capture'->>'sessionId'=session_id
    AND state->'capture'->>'accountId'=account_id AND state->'capture'->>'communityId'=community_id) IS TRUE),
  CHECK(((state->>'revision')::BIGINT=revision AND (state->>'publicationRevision')::BIGINT=publication_revision AND state->>'state'=status) IS TRUE),
  CHECK(review_deadline=uploaded_at+interval '168 hours'),
  CHECK((status IN('uploaded','screening','awaiting_review'))=(terminal_at IS NULL))
);
CREATE INDEX dance_moderated_review_queue_v1 ON dance_moderated_reviews_v1(community_id,review_deadline,review_id) WHERE status='awaiting_review';
CREATE INDEX dance_moderated_review_latest_v1 ON dance_moderated_reviews_v1(account_id,community_id,submitted_at DESC,review_id DESC);
CREATE TABLE dance_moderated_command_receipts_v1 (
  actor_kind TEXT NOT NULL CHECK(actor_kind IN('account','worker')), actor_id TEXT NOT NULL,
  operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review_id TEXT NOT NULL, community_id TEXT NOT NULL,
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_kind,actor_id,operation,idempotency_key)
);
CREATE TABLE dance_moderated_choice_changes_v1 (
  review_id TEXT NOT NULL REFERENCES dance_moderated_reviews_v1,
  choice_revision BIGINT NOT NULL CHECK(choice_revision>0), actor_id TEXT NOT NULL,
  before_value BOOLEAN, after_value BOOLEAN NOT NULL, disclosure_version TEXT NOT NULL,
  review_revision BIGINT NOT NULL, changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(review_id,choice_revision)
);
CREATE TABLE dance_moderated_review_evidence_v1 (
  review_id TEXT NOT NULL REFERENCES dance_moderated_reviews_v1, analysis_revision BIGINT NOT NULL CHECK(analysis_revision>0),
  source_digest TEXT NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  normalization_hash TEXT NOT NULL CHECK(normalization_hash ~ '^[a-f0-9]{64}$'),
  safety_policy_hash TEXT NOT NULL CHECK(safety_policy_hash ~ '^[a-f0-9]{64}$'),
  frame_digests TEXT[] NOT NULL CHECK(cardinality(frame_digests)=3),
  safety_status TEXT NOT NULL CHECK(safety_status IN('accepted','flagged','failed','unknown')),
  content_rating TEXT NOT NULL CHECK(content_rating IN('general','adult_18')),
  integrity_status TEXT NOT NULL CHECK(integrity_status IN('unique','blocked','unknown')),
  normalized_digest TEXT NOT NULL CHECK(normalized_digest ~ '^[a-f0-9]{64}$'),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(review_id,analysis_revision)
);
CREATE TABLE dance_moderated_review_intents_v1 (
  intent_key TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES dance_moderated_reviews_v1,
  kind TEXT NOT NULL CHECK(kind IN('result','cleanup_review','cleanup_temporary','hold_review','handoff_prepare','handoff_cancel','handoff_release','qualification')),
  generation BIGINT NOT NULL CHECK(generation>=0), deadline_at TIMESTAMPTZ,
  intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object'),
  status TEXT NOT NULL CHECK(status IN('pending','running','unknown','completed','exhausted')),
  lease_token TEXT, lease_until TIMESTAMPTZ, attempts BIGINT NOT NULL CHECK(attempts>=0),
  disposition JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(review_id,kind,generation)
);
CREATE TABLE dance_moderated_verdict_audits_v1 (
  review_id TEXT PRIMARY KEY REFERENCES dance_moderated_reviews_v1,
  reviewer_account_id TEXT NOT NULL REFERENCES users(user_id), owner_assignment_id TEXT NOT NULL REFERENCES community_role_assignments(role_assignment_id),
  owner_assignment_revision BIGINT NOT NULL CHECK(owner_assignment_revision>0),
  verdict TEXT NOT NULL CHECK(verdict IN('passed','not_passed')),
  attestation JSONB NOT NULL CHECK(jsonb_typeof(attestation)='object'),
  before_revision BIGINT NOT NULL, after_revision BIGINT NOT NULL CHECK(after_revision=before_revision+1),
  committed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE dance_moderated_result_events_v1 (
  event_id TEXT PRIMARY KEY, review_id TEXT NOT NULL UNIQUE REFERENCES dance_moderated_reviews_v1,
  recipient_account_id TEXT NOT NULL REFERENCES users(user_id),
  outcome TEXT NOT NULL CHECK(outcome IN('passed','not_passed','review_expired')),
  review_revision BIGINT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE TABLE dance_moderated_runtime_roles_v1 (
  role_oid OID NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN('account','worker','media','erasure')),
  PRIMARY KEY(role_oid,purpose)
);
CREATE TABLE dance_moderated_erasure_queue_v1 (
  account_id TEXT NOT NULL REFERENCES users(user_id), fence_revision BIGINT NOT NULL CHECK(fence_revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
  PRIMARY KEY(account_id,fence_revision)
);
CREATE TABLE dance_moderated_media_leases_v1 (
  lease_id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES dance_moderated_reviews_v1,
  actor_account_id TEXT NOT NULL REFERENCES users(user_id),
  audience TEXT NOT NULL CHECK(audience IN('dancer','owner')),
  owner_assignment_id TEXT, owner_assignment_revision BIGINT,
  capture_account_fence BIGINT NOT NULL CHECK(capture_account_fence>0),
  issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  CHECK(expires_at>issued_at),
  CHECK((audience='dancer' AND owner_assignment_id IS NULL AND owner_assignment_revision IS NULL)
    OR (audience='owner' AND owner_assignment_id IS NOT NULL AND owner_assignment_revision>0))
);

-- Purpose-specific EXECUTE grants are supplied by the reviewed integration;
-- PUBLIC and inherited/default grants never provide a raw-table write path.
DO $acl$
DECLARE obj RECORD; recipient RECORD;
BEGIN
 FOR obj IN SELECT c.oid,c.relowner,c.relname FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace
   AND (c.relname LIKE 'dance_moderated_%_v1' OR c.relname IN('dance_review_account_fences_v1','dance_review_policy_versions_v1','dance_review_policy_admissions_v1','dance_moderator_reference_revisions_v1','dance_moderator_reference_cutoffs_v1')) LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC CASCADE',obj.relname);
  FOR recipient IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid=obj.oid),acldefault('r',obj.relowner))) a WHERE a.grantee<>0 AND a.grantee<>obj.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I CASCADE',obj.relname,recipient.name);
  END LOOP;
 END LOOP;
END $acl$;
DO $immutable$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['dance_review_policy_versions_v1','dance_moderator_reference_revisions_v1','dance_moderator_reference_cutoffs_v1','dance_moderated_consents_v1','dance_moderated_command_receipts_v1','dance_moderated_choice_changes_v1','dance_moderated_review_evidence_v1','dance_moderated_verdict_audits_v1'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1()',t||'_no_truncate',t);
 END LOOP;
END $immutable$;
