-- Prospective categorical producer. No Dance policy/admission is seeded or
-- activated here. Numeric Study/Karaoke policies and evidence stay unchanged.
ALTER TABLE qualification_policy_versions
 DROP CONSTRAINT qualification_policy_kind_shape,
 DROP CONSTRAINT qualification_policy_document_shape,
 ADD CONSTRAINT qualification_policy_kind_shape CHECK(
  (activity_key='study' AND policy_kind='study_session_first_pass_v2') OR
  (activity_key='karaoke' AND policy_kind IN('karaoke_qualification_v1','karaoke_qualification_v2')) OR
  (activity_key='dance' AND policy_kind='dance_owner_verdict_v1')),
 ADD CONSTRAINT qualification_policy_document_shape CHECK((
  (policy_kind='study_session_first_pass_v2' AND policy_document='{"required_correct_bps":7000}'::JSONB) OR
  (policy_kind='karaoke_qualification_v1' AND policy_document='{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000}'::JSONB) OR
  (policy_kind='karaoke_qualification_v2' AND policy_document-'eligible_playback_kinds'='{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000}'::JSONB
    AND policy_document->'eligible_playback_kinds' IN('["full_mix"]'::JSONB,'["instrumental"]'::JSONB,'["full_mix","instrumental"]'::JSONB,'["instrumental","full_mix"]'::JSONB)) OR
  (policy_kind='dance_owner_verdict_v1' AND policy_document->>'grading_mode'='moderator_verdict'
    AND policy_document->>'verdict'='passed' AND jsonb_typeof(policy_document->'score_bps')='null'
    AND jsonb_typeof(policy_document->'calibration')='null' AND jsonb_typeof(policy_document->'numeric_floor_bps')='null'
    AND policy_document->>'policy_hash' ~ '^[a-f0-9]{64}$'
    AND is_dance_identifier(policy_document->>'producer_id'))
 ) IS TRUE);
ALTER TABLE dance_review_policy_versions_v1 ADD CONSTRAINT dance_review_qualification_policy_fk
 FOREIGN KEY(qualification_policy_version_id) REFERENCES qualification_policy_versions;
ALTER TABLE activity_qualifications
 ALTER COLUMN score_bps DROP NOT NULL,
 ADD COLUMN grading_mode TEXT NOT NULL DEFAULT 'numeric' CHECK(grading_mode IN('numeric','moderator_verdict')),
 ADD COLUMN dance_review_id TEXT REFERENCES dance_moderated_reviews_v1(review_id),
 ADD COLUMN categorical_verdict TEXT,
 ADD COLUMN calibration_id TEXT,
 ADD COLUMN numeric_floor_bps INTEGER,
 DROP CONSTRAINT activity_qualification_attempt_shape,
 ADD CONSTRAINT activity_qualification_attempt_shape CHECK(
  (activity_key='study' AND study_session_id IS NOT NULL AND karaoke_session_id IS NULL AND karaoke_attempt_id IS NULL AND dance_review_id IS NULL) OR
  (activity_key='karaoke' AND study_session_id IS NULL AND karaoke_session_id IS NOT NULL AND karaoke_attempt_id IS NOT NULL AND dance_review_id IS NULL) OR
  (activity_key='dance' AND study_session_id IS NULL AND karaoke_session_id IS NULL AND karaoke_attempt_id IS NULL AND dance_review_id IS NOT NULL)),
 ADD CONSTRAINT activity_qualification_grading_family CHECK((
  (grading_mode='numeric' AND activity_key IN('study','karaoke') AND score_bps IS NOT NULL AND categorical_verdict IS NULL AND dance_review_id IS NULL) OR
  (grading_mode='moderator_verdict' AND activity_key='dance' AND score_bps IS NULL AND categorical_verdict='passed'
    AND calibration_id IS NULL AND numeric_floor_bps IS NULL AND dance_review_id IS NOT NULL)
 ) IS TRUE);
CREATE UNIQUE INDEX activity_qualifications_dance_review_uidx ON activity_qualifications(dance_review_id) WHERE activity_key='dance';

CREATE FUNCTION dance_review_worker_authorized_v1() RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT session_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='dance_moderated_reviews_v1'::regclass)
   OR EXISTS(SELECT 1 FROM dance_moderated_runtime_roles_v1 r WHERE r.purpose='worker' AND pg_has_role(session_user::regrole::oid,r.role_oid,'MEMBER'))
$$;
CREATE FUNCTION begin_moderated_dance_account_erasure_v1(p_account TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE epoch BIGINT;
BEGIN
 PERFORM 1 FROM users WHERE user_id=p_account FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02'; END IF;
 INSERT INTO dance_review_account_fences_v1 VALUES(p_account,1,TRUE,clock_timestamp())
 ON CONFLICT(account_id) DO UPDATE SET revision=dance_review_account_fences_v1.revision+CASE WHEN dance_review_account_fences_v1.erasing THEN 0 ELSE 1 END,
   erasing=TRUE,changed_at=CASE WHEN dance_review_account_fences_v1.erasing THEN dance_review_account_fences_v1.changed_at ELSE clock_timestamp() END
 RETURNING revision INTO epoch;
 INSERT INTO dance_moderated_erasure_queue_v1(account_id,fence_revision) VALUES(p_account,epoch) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION fence_moderated_dance_account_delete_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status='deleted' THEN PERFORM begin_moderated_dance_account_erasure_v1(NEW.user_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_review_account_delete_fence AFTER UPDATE OF status ON users
 FOR EACH ROW EXECUTE FUNCTION fence_moderated_dance_account_delete_v1();

CREATE FUNCTION read_owned_moderated_dance_review_v1(p_account TEXT,p_community TEXT,p_review TEXT) RETURNS JSONB
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT r.state FROM dance_moderated_reviews_v1 r JOIN users u ON u.user_id=r.account_id
 JOIN dance_review_account_fences_v1 f USING(account_id)
 WHERE r.review_id=p_review AND r.community_id=p_community AND r.account_id=p_account AND u.status='active' AND NOT f.erasing
$$;
CREATE FUNCTION lock_moderated_dance_review_v1(p_action JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; owner community_role_assignments; policy TEXT; rating TEXT;
BEGIN
 SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE review_id=p_action->>'reviewId' AND community_id=p_action->>'communityId';
 IF NOT FOUND THEN RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02'; END IF;
 -- Match comment/result delivery: recipient advisory lock BEFORE user rows.
 -- Commit re-enters this same order, including its synchronous inbox trigger.
 -- Immutable review identity is discovery only, not private authority.
 PERFORM pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||r.account_id,0));
 PERFORM 1 FROM users WHERE user_id IN(r.account_id,p_action->'actor'->>'accountId') ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=r.account_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-review-command-v1',p_action->'actor'->>'kind',p_action->'actor'->>'accountId',p_action->>'operation',p_action->>'idempotencyKey')::TEXT,0));
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=r.review_id FOR UPDATE;
 SELECT s.policy_id INTO STRICT policy FROM dance_moderated_sessions_v1 s WHERE s.session_id=r.session_id FOR UPDATE;
 PERFORM 1 FROM dance_review_policy_versions_v1 WHERE policy_id=policy FOR SHARE;
 PERFORM 1 FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=r.state->'capture'->>'choreographyId'
   AND revision=(r.state->'capture'->>'choreographyRevision')::BIGINT FOR SHARE;
 PERFORM 1 FROM dance_moderated_review_evidence_v1 WHERE review_id=r.review_id FOR SHARE;
 IF p_action->'actor'->>'kind'='worker' THEN
  IF NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'worker authority required' USING ERRCODE='42501'; END IF;
 ELSE
  IF (p_action->'actor'->>'kind'='account' AND EXISTS(SELECT 1 FROM users WHERE user_id=p_action->'actor'->>'accountId' AND status='active')
    AND EXISTS(SELECT 1 FROM dance_review_account_fences_v1 WHERE account_id=r.account_id AND NOT erasing)) IS NOT TRUE THEN
   RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02'; END IF;
  IF p_action->>'operation'='verdict' THEN
   SELECT * INTO owner FROM community_role_assignments WHERE community_id=r.community_id AND role='owner' AND status='active' AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=r.community_id AND sole.role='owner' AND sole.status='active')=1 FOR SHARE;
   SELECT e.content_rating INTO rating FROM dance_moderated_review_evidence_v1 e WHERE e.review_id=r.review_id AND e.safety_status='accepted';
   IF (owner.account_id=p_action->'actor'->>'accountId' AND owner.account_id<>r.account_id
     AND rating IS NOT NULL AND can_account_view_content_rating_v1(owner.account_id,rating)) IS NOT TRUE THEN
    RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02'; END IF;
  ELSIF p_action->'actor'->>'accountId' IS DISTINCT FROM r.account_id THEN
   RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02';
  END IF;
 END IF;
 RETURN r.state;
END $$;
CREATE FUNCTION read_moderated_dance_receipt_v1(p_action JSONB) RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object('requestHash',request_hash,'receipt',receipt)
 FROM dance_moderated_command_receipts_v1 WHERE actor_kind=p_action->'actor'->>'kind' AND actor_id=p_action->'actor'->>'accountId'
   AND operation=p_action->>'operation' AND idempotency_key=p_action->>'idempotencyKey'
$$;
CREATE FUNCTION moderated_dance_review_facts_v1(p_review TEXT,p_actor JSONB,p_operation TEXT,p_at_ms BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; c JSONB; policy dance_review_policy_versions_v1;
 e dance_moderated_review_evidence_v1; u dance_moderated_uploads_v1;
 owner community_role_assignments; f dance_review_account_fences_v1; active BOOLEAN; cutoff TIMESTAMPTZ; admitted BOOLEAN;
BEGIN
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
 c:=r.state->'capture';
 SELECT p.* INTO STRICT policy FROM dance_review_policy_versions_v1 p JOIN dance_moderated_sessions_v1 s USING(policy_id) WHERE s.session_id=r.session_id;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=r.account_id;
 SELECT status='active' AND NOT f.erasing INTO active FROM users WHERE user_id=r.account_id;
 SELECT * INTO owner FROM community_role_assignments WHERE community_id=r.community_id AND role='owner' AND status='active' AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=r.community_id AND sole.role='owner' AND sole.status='active')=1;
 SELECT * INTO e FROM dance_moderated_review_evidence_v1 WHERE review_id=p_review AND analysis_revision=(c->>'analysisRevision')::BIGINT;
 SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE upload_id=c->>'uploadId';
 SELECT cutoff_at INTO cutoff FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=c->>'choreographyId' AND revision=(c->>'choreographyRevision')::BIGINT;
 SELECT EXISTS(SELECT 1 FROM qualification_policy_versions q JOIN activity_registry a ON a.activity_key=q.activity_key
   WHERE q.qualification_policy_version_id=policy.qualification_policy_version_id AND q.activity_key='dance'
     AND q.policy_kind='dance_owner_verdict_v1' AND q.policy_document->>'policy_hash'=c->'policy'->>'qualificationHash'
     AND a.status='active' AND policy.review_policy->>'admission' IN('streak_admitted','money_admitted')) INTO admitted;
 RETURN jsonb_build_object(
  'accountActive',coalesce(active,FALSE),'accountFenceRevision',f.revision,'workerAuthorized',p_actor->>'kind'='worker' AND dance_review_worker_authorized_v1(),
  'ownedPersona',jsonb_build_object('active',active_activity_persona(r.account_id,c->>'personaId',r.community_id),'accountId',r.account_id,'personaId',c->>'personaId','communityId',r.community_id),
  'owner',CASE WHEN owner.role_assignment_id IS NULL THEN NULL ELSE jsonb_build_object('accountId',owner.account_id,'communityId',owner.community_id,'assignmentId',owner.role_assignment_id,'revision',owner.authority_revision,
    'canInspect',coalesce(e.safety_status='accepted' AND can_account_view_content_rating_v1(owner.account_id,e.content_rating)
      AND EXISTS(SELECT 1 FROM users WHERE user_id=owner.account_id AND status='active'),FALSE)) END,
  'referenceCutoffAtMs',CASE WHEN cutoff IS NULL THEN NULL ELSE floor(extract(epoch FROM cutoff)*1000)::BIGINT END,
  'media',CASE WHEN u.state NOT IN('sealed','held') THEN NULL ELSE jsonb_build_object('accepted',TRUE,'sourceDigest',u.server_sha256,'normalizedDigest',u.normalized_digest,'normalizationVersion',u.normalization_version,'normalizationHash',u.normalization_hash) END,
  'safety',CASE WHEN e.review_id IS NULL THEN NULL ELSE jsonb_build_object('status',e.safety_status,'persisted',TRUE,'sourceDigest',e.source_digest,'analysisRevision',e.analysis_revision,'policyHash',e.safety_policy_hash,'frameDigests',e.frame_digests) END,
  'integrity',CASE WHEN e.review_id IS NULL THEN NULL ELSE jsonb_build_object('status',e.integrity_status,'persisted',TRUE,'sourceDigest',e.source_digest,'normalizedDigest',e.normalized_digest,'policyHash',e.normalization_hash) END,
  'disposition',policy.disposition_profile,
  'submissionDay',jsonb_build_object('atMs',p_at_ms,'day',to_char(to_timestamp(p_at_ms::NUMERIC/1000) AT TIME ZONE (c->>'timezone'),'YYYY-MM-DD'),'timezone',c->>'timezone','timezoneVersion',c->>'timezoneVersion'),
  'qualification',CASE WHEN NOT admitted THEN NULL ELSE jsonb_build_object('admitted',TRUE,'producerId',c->'policy'->>'producerId','policyVersion',policy.qualification_policy_version_id,'policyHash',c->'policy'->>'qualificationHash','admissionVersion',c->'policy'->>'admissionVersion','admissionHash',c->'policy'->>'admissionHash') END);
END $$;

CREATE FUNCTION commit_moderated_dance_review_v1(p_input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE a JSONB:=p_input->'action'; transition JSONB:=p_input->'transition'; next JSONB:=transition->'state';
 receipt JSONB:=p_input->'receipt'; r dance_moderated_reviews_v1; f dance_review_account_fences_v1;
 owner community_role_assignments; evidence dance_moderated_review_evidence_v1;
 item JSONB; q JSONB; old_intent JSONB; event_at TIMESTAMPTZ; terminal TIMESTAMPTZ;
 next_status TEXT:=next->>'state'; next_revision BIGINT:=(next->>'revision')::BIGINT;
 qualified TEXT; expected_evidence JSONB; worker BOOLEAN; account_active BOOLEAN;
BEGIN
 -- Re-enter the same locks/authorization, with no provider or external work.
 PERFORM lock_moderated_dance_review_v1(a);
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=a->>'reviewId' FOR UPDATE;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=r.account_id FOR UPDATE;
 SELECT status='active' AND NOT f.erasing INTO account_active FROM users WHERE user_id=r.account_id;
 worker:=a->'actor'->>'kind'='worker' AND dance_review_worker_authorized_v1();
 IF ((p_input->>'beforeReviewRevision')::BIGINT=r.revision
   AND (p_input->>'beforePublicationRevision')::BIGINT=r.publication_revision
   AND (p_input->>'captureAccountFenceRevision')::BIGINT=(r.state->'capture'->>'accountFenceRevision')::BIGINT
   AND (p_input->>'observedAccountFenceRevision')::BIGINT=f.revision
   AND (p_input->>'observedAccountActive')::BOOLEAN=account_active
   AND next->'capture'=r.state->'capture' AND next->'reviewDeadlineMs'=r.state->'reviewDeadlineMs'
   AND receipt->>'review_id'=r.review_id AND receipt->>'operation'=a->>'operation'
   AND receipt->'result'->>'review_id'=r.review_id AND receipt->>'request_hash' IS NULL
   AND a->>'requestHash' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'review or lifecycle fence changed' USING ERRCODE='DRV05';
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_command_receipts_v1 c WHERE c.actor_kind=a->'actor'->>'kind'
   AND c.actor_id=a->'actor'->>'accountId' AND c.operation=a->>'operation' AND c.idempotency_key=a->>'idempotencyKey') THEN
  RAISE EXCEPTION 'command receipt already exists; reload original' USING ERRCODE='DRV03';
 END IF;
 IF (r.state->'initialSubmit')<>'null'::JSONB AND next->'initialSubmit' IS DISTINCT FROM r.state->'initialSubmit' THEN
  RAISE EXCEPTION 'initial submission is immutable' USING ERRCODE='DRV01';
 END IF;
 IF next IS DISTINCT FROM r.state THEN
  IF next_revision<>r.revision+1 AND NOT(worker AND next_revision=r.revision AND r.status='reviewed'
    AND a->>'operation' IN('erase','publication_failed') AND next_status=r.status
    AND (next->>'publicationRevision')::BIGINT=r.publication_revision+1
    AND (next-'publication'-'publicationRevision')=(r.state-'publication'-'publicationRevision')) THEN
   RAISE EXCEPTION 'invalid review revision' USING ERRCODE='DRV05';
  END IF;
  IF r.status NOT IN('uploaded','screening','awaiting_review') AND
    (next_status IS DISTINCT FROM r.status OR next->'verdict' IS DISTINCT FROM r.state->'verdict'
      OR next->'qualificationRef' IS DISTINCT FROM r.state->'qualificationRef'
      OR next->'attestation' IS DISTINCT FROM r.state->'attestation') THEN
   RAISE EXCEPTION 'terminal result is immutable' USING ERRCODE='DRV01';
  END IF;
 END IF;
 IF NOT account_active OR f.revision<>(r.state->'capture'->>'accountFenceRevision')::BIGINT THEN
  IF NOT worker OR a->>'operation' NOT IN('erase','publication_failed') THEN
   RAISE EXCEPTION 'account lifecycle changed' USING ERRCODE='DRV05';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(transition->'intents') x WHERE x->>'kind' NOT IN('cleanup_review','cleanup_temporary','handoff_cancel')) THEN
   RAISE EXCEPTION 'erasure cannot create review, qualification, notification or publication' USING ERRCODE='DRV05';
  END IF;
 END IF;
 terminal:=CASE WHEN next->>'terminalAtMs' IS NULL THEN NULL ELSE to_timestamp((next->>'terminalAtMs')::NUMERIC/1000) END;
 event_at:=CASE WHEN a->>'operation'='submit' AND r.submitted_at IS NULL
   THEN to_timestamp((next->>'submittedAtMs')::NUMERIC/1000) ELSE terminal END;
 IF next_status='reviewed' AND r.status<>'reviewed' THEN
  SELECT * INTO owner FROM community_role_assignments WHERE community_id=r.community_id AND role='owner' AND status='active' AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=r.community_id AND sole.role='owner' AND sole.status='active')=1 FOR SHARE;
  SELECT * INTO evidence FROM dance_moderated_review_evidence_v1 WHERE review_id=r.review_id AND analysis_revision=(r.state->'capture'->>'analysisRevision')::BIGINT;
  IF (a->>'operation'='verdict' AND a->'actor'->>'kind'='account'
    AND owner.account_id=a->'actor'->>'accountId' AND owner.account_id<>r.account_id
    AND r.status='awaiting_review' AND terminal<r.review_deadline AND clock_timestamp()<r.review_deadline
    AND terminal>=r.uploaded_at AND terminal<=clock_timestamp()
    AND next->>'verdict' IN('passed','not_passed') AND evidence.safety_status='accepted'
    AND evidence.integrity_status='unique' AND can_account_view_content_rating_v1(owner.account_id,evidence.content_rating)
    AND next->'attestation'->>'version'='dance-owner-verdict-attestation-v1'
    AND next->'attestation'->>'reviewerAccountId'=owner.account_id
    AND next->'attestation'->>'assignmentId'=owner.role_assignment_id
    AND (next->'attestation'->>'assignmentRevision')::BIGINT=owner.authority_revision
    AND next->'attestation'->>'sourceDigest'=r.state->'capture'->>'sourceDigest'
    AND next->'attestation'->>'rubricVersion'=r.state->'capture'->'policy'->>'rubricVersion'
    AND next->'attestation'->>'rubricHash'=r.state->'capture'->'policy'->>'rubricHash'
    AND next->'attestation'->>'termsHash'=r.state->'capture'->>'termsHash'
    AND next->'attestation'->>'cueId'=r.state->'capture'->>'cueId'
    AND (next->'attestation'->>'bodyStartMs')::BIGINT=(r.state->'capture'->>'bodyStartMs')::BIGINT
    AND (next->'attestation'->>'bodyEndMs')::BIGINT=(r.state->'capture'->>'bodyEndMs')::BIGINT
    AND next->'attestation'->>'cue'=CASE next->>'verdict' WHEN 'passed' THEN 'affirmed' ELSE 'not_attested' END) IS NOT TRUE THEN
   RAISE EXCEPTION 'current owner, inspection or verdict deadline unavailable' USING ERRCODE='DRV05';
  END IF;
  INSERT INTO dance_moderated_verdict_audits_v1 VALUES(r.review_id,owner.account_id,owner.role_assignment_id,
    owner.authority_revision,next->>'verdict',next->'attestation',r.revision,next_revision,terminal);
 END IF;
 IF next->'initialSubmit'<>'null'::JSONB AND r.state->'initialSubmit'='null'::JSONB THEN
  IF (a->>'operation'='submit' AND a->'actor'->>'accountId'=r.account_id AND r.status='uploaded'
    AND event_at>=r.uploaded_at AND event_at<r.review_deadline AND clock_timestamp()<r.review_deadline
    AND next->'initialSubmit'->>'id'=a->>'receiptId'
    AND jsonb_typeof(next->'initialSubmit'->'showPublicly')='boolean'
    AND next->'initialSubmit'->>'disclosureVersion'=r.state->'capture'->'policy'->>'disclosureVersion') IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid immutable Submit' USING ERRCODE='DRV05';
  END IF;
 END IF;
 IF next_status='review_expired' THEN
  -- A supplied future timestamp cannot manufacture expiry. Account commands
  -- may expire an actually pending submitted review at the real deadline.
  IF terminal IS NULL OR terminal<r.review_deadline OR terminal>clock_timestamp() OR clock_timestamp()<r.review_deadline
   OR (r.status<>'review_expired' AND (r.status NOT IN('screening','awaiting_review') OR r.submitted_at IS NULL OR r.terminal_at IS NOT NULL))
   OR (r.status='review_expired' AND next IS DISTINCT FROM r.state) THEN
   RAISE EXCEPTION 'premature or invalid review expiry' USING ERRCODE='DRV05';
  END IF;
 END IF;
 UPDATE dance_moderated_reviews_v1 SET state=next,revision=next_revision,
  publication_revision=(next->>'publicationRevision')::BIGINT,status=next_status,
  submitted_at=CASE WHEN next->>'submittedAtMs' IS NULL THEN NULL ELSE to_timestamp((next->>'submittedAtMs')::NUMERIC/1000) END,
  terminal_at=terminal WHERE review_id=r.review_id;
 IF next->'showPublicly' IS DISTINCT FROM r.state->'showPublicly' THEN
  INSERT INTO dance_moderated_choice_changes_v1 VALUES(r.review_id,(next->>'choiceRevision')::BIGINT,
   a->'actor'->>'accountId',(r.state->>'showPublicly')::BOOLEAN,(next->>'showPublicly')::BOOLEAN,
   r.state->'capture'->'policy'->>'disclosureVersion',next_revision,coalesce(event_at,clock_timestamp()));
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(transition->'intents') LOOP
  IF (item->>'reviewId'=r.review_id
    AND (item->>'key')::JSONB=jsonb_build_array('dance-review-intent-v1',r.review_id,item->>'kind',(item->>'generation')::BIGINT)
    AND ((item->>'kind' IN('result','cleanup_review','hold_review','qualification') AND (item->>'generation')::BIGINT=0)
      OR (item->>'kind' IN('handoff_prepare','handoff_release') AND (item->>'generation')::BIGINT=(next->>'generation')::BIGINT AND (item->>'generation')::BIGINT>0)
      OR (item->>'kind' IN('handoff_cancel','cleanup_temporary') AND (item->>'generation')::BIGINT=(r.state->>'generation')::BIGINT AND (item->>'generation')::BIGINT>0))) IS NOT TRUE THEN
   RAISE EXCEPTION 'foreign review intent' USING ERRCODE='DRV05'; END IF;
  SELECT intent INTO old_intent FROM dance_moderated_review_intents_v1 WHERE intent_key=item->>'key';
  IF FOUND AND old_intent IS DISTINCT FROM item THEN RAISE EXCEPTION 'intent identity conflict' USING ERRCODE='DRV03'; END IF;
  INSERT INTO dance_moderated_review_intents_v1(intent_key,review_id,kind,generation,deadline_at,intent,status,attempts)
   VALUES(item->>'key',r.review_id,item->>'kind',(item->>'generation')::BIGINT,
    CASE WHEN item->>'deadlineMs' IS NULL THEN NULL ELSE to_timestamp((item->>'deadlineMs')::NUMERIC/1000) END,item,'pending',0)
   ON CONFLICT(intent_key) DO NOTHING;
  IF item->>'kind'='qualification' THEN
   IF qualified IS NOT NULL THEN RAISE EXCEPTION 'multiple qualifications' USING ERRCODE='DRV04'; END IF;
   q:=item->'qualification'; qualified:=q->>'id';
   IF (account_active AND next_status='reviewed' AND next->>'verdict'='passed'
    AND q->>'accountId'=r.account_id AND q->>'communityId'=r.community_id
    AND q->>'grading_mode'='moderator_verdict' AND q->>'verdict'='passed'
    AND jsonb_typeof(q->'score_bps')='null' AND jsonb_typeof(q->'calibration')='null'
    AND jsonb_typeof(q->'floor')='null' AND qualified=next->>'qualificationRef'
    AND q->>'admissionHash'=next->'capture'->'policy'->>'admissionHash'
    AND q->>'policyHash'=next->'capture'->'policy'->>'qualificationHash') IS NOT TRUE THEN
    RAISE EXCEPTION 'unadmitted categorical qualification' USING ERRCODE='DRV04'; END IF;
   expected_evidence:=jsonb_build_object('kind','dance_owner_verdict_v1','review_id',r.review_id,
    'grading_mode','moderator_verdict','verdict','passed','cue_attestation','affirmed',
    'policy_hash',next->'capture'->'policy'->>'qualificationHash','admission_hash',next->'capture'->'policy'->>'admissionHash',
    'submission_timezone',next->'capture'->>'timezone','submission_timezone_version',next->'capture'->>'timezoneVersion');
   INSERT INTO activity_qualifications(qualification_id,account_id,persona_id,community_id,post_id,audio_revision,
    activity_key,score_bps,qualification_policy_version_id,qualified_at,streak_day,evidence_summary,
    grading_mode,dance_review_id,categorical_verdict,calibration_id,numeric_floor_bps)
   VALUES(qualified,r.account_id,next->'capture'->>'personaId',r.community_id,next->'capture'->>'songPostId',
    (next->'capture'->>'audioRevision')::BIGINT,'dance',NULL,next->'capture'->'policy'->>'qualificationVersion',
    terminal,(next->'submissionDay'->>'day')::DATE,expected_evidence,'moderator_verdict',r.review_id,'passed',NULL,NULL);
  END IF;
 END LOOP;
 IF (next->>'qualificationRef') IS DISTINCT FROM qualified AND next->'qualificationRef' IS DISTINCT FROM r.state->'qualificationRef' THEN
  RAISE EXCEPTION 'qualification reference has no actual admitted insert' USING ERRCODE='DRV04'; END IF;
 IF r.terminal_at IS NULL AND terminal IS NOT NULL THEN
  UPDATE dance_moderated_sessions_v1 SET state='terminal' WHERE session_id=r.session_id;
  DELETE FROM dance_moderated_active_slots_v1 WHERE session_id=r.session_id;
  IF account_active AND next_status IN('reviewed','review_expired') THEN
   INSERT INTO dance_moderated_result_events_v1(event_id,review_id,recipient_account_id,outcome,review_revision,occurred_at)
   VALUES('dance-result:'||r.review_id,r.review_id,r.account_id,CASE next_status WHEN 'review_expired' THEN 'review_expired' ELSE next->>'verdict' END,next_revision,terminal);
  END IF;
 END IF;
 INSERT INTO dance_moderated_command_receipts_v1 VALUES(a->'actor'->>'kind',a->'actor'->>'accountId',
  a->>'operation',a->>'idempotencyKey',a->>'requestHash',r.review_id,r.community_id,receipt,clock_timestamp());
 RETURN jsonb_build_object('committed',TRUE,'qualificationId',qualified);
END $$;

DO $review_acl$
DECLARE f RECORD; grantee RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure AS signature FROM pg_proc p
  WHERE p.pronamespace=trusted::regnamespace AND p.proname IN('dance_review_worker_authorized_v1',
   'begin_moderated_dance_account_erasure_v1','fence_moderated_dance_account_delete_v1',
   'read_owned_moderated_dance_review_v1','lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1',
   'moderated_dance_review_facts_v1','commit_moderated_dance_review_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
  END LOOP;
 END LOOP;
END $review_acl$;

CREATE FUNCTION latest_owned_moderated_dance_review_v1(p_account TEXT,p_community TEXT,p_post TEXT,p_choreography TEXT,p_revision BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE latest JSONB; active_session TEXT;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM users WHERE user_id=p_account AND status='active')
  OR EXISTS(SELECT 1 FROM dance_review_account_fences_v1 WHERE account_id=p_account AND erasing) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM dance_moderator_reference_revisions_v1 d WHERE d.choreography_id=p_choreography AND d.revision=p_revision
   AND d.community_id=p_community AND d.song_post_id=p_post) THEN RETURN NULL; END IF;
 SELECT r.state INTO latest FROM dance_moderated_reviews_v1 r WHERE r.account_id=p_account AND r.community_id=p_community
  AND r.state->'capture'->>'songPostId'=p_post AND r.state->'capture'->>'choreographyId'=p_choreography
  AND (r.state->'capture'->>'choreographyRevision')::BIGINT=p_revision AND r.submitted_at IS NOT NULL
  ORDER BY r.submitted_at DESC,r.review_id DESC LIMIT 1;
 SELECT slot.session_id INTO active_session FROM dance_moderated_active_slots_v1 slot JOIN dance_moderated_sessions_v1 s USING(session_id)
  WHERE slot.account_id=p_account AND slot.choreography_id=p_choreography AND slot.choreography_revision=p_revision
    AND s.community_id=p_community AND s.song_post_id=p_post;
 RETURN jsonb_build_object('latest',latest,'activeSessionId',active_session);
END $$;

CREATE FUNCTION can_owner_read_moderated_dance_v1(p_account TEXT,p_review TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(
  SELECT 1 FROM dance_moderated_reviews_v1 r JOIN users dancer ON dancer.user_id=r.account_id
  JOIN dance_review_account_fences_v1 fence ON fence.account_id=r.account_id
  JOIN community_role_assignments o ON o.community_id=r.community_id AND o.role='owner' AND o.status='active'
  JOIN users actor ON actor.user_id=o.account_id
  JOIN dance_moderated_review_evidence_v1 e ON e.review_id=r.review_id AND e.analysis_revision=(r.state->'capture'->>'analysisRevision')::BIGINT
  JOIN posts song ON song.community_id=r.community_id AND song.post_id=r.state->'capture'->>'songPostId'
  WHERE r.review_id=p_review AND o.account_id=p_account AND o.account_id<>r.account_id
   AND actor.status='active' AND dancer.status='active' AND NOT fence.erasing
   AND NOT EXISTS(SELECT 1 FROM dance_review_account_fences_v1 own_fence WHERE own_fence.account_id=p_account AND own_fence.erasing)
   AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=r.community_id AND sole.role='owner' AND sole.status='active')=1
   AND r.status='awaiting_review' AND r.review_deadline>statement_timestamp()
   AND e.safety_status='accepted' AND e.integrity_status='unique'
   AND e.source_digest=r.state->'capture'->>'sourceDigest' AND e.normalized_digest=r.state->'capture'->>'normalizedDigest'
   AND e.safety_policy_hash=r.state->'capture'->'policy'->>'safetyHash'
   AND e.normalization_hash=r.state->'capture'->'policy'->>'normalizationHash'
   AND can_account_view_content_rating_v1(p_account,CASE WHEN e.content_rating='adult_18' OR song.content_rating='adult_18' THEN 'adult_18' ELSE 'general' END)
 )
$$;
CREATE FUNCTION owner_moderated_dance_queue_v1(p_account TEXT,p_community TEXT,p_cursor TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE owner community_role_assignments; anchor_deadline TIMESTAMPTZ; anchor_id TEXT;
 r RECORD; items JSONB:='[]'; total INTEGER:=0; more BOOLEAN:=FALSE; next_cursor TEXT;
BEGIN
 SELECT * INTO owner FROM community_role_assignments o WHERE o.community_id=p_community AND o.account_id=p_account
   AND o.role='owner' AND o.status='active' AND EXISTS(SELECT 1 FROM users WHERE user_id=p_account AND status='active')
   AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=p_community AND sole.role='owner' AND sole.status='active')=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'private resource unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_cursor IS NOT NULL THEN
  SELECT review_deadline,review_id INTO anchor_deadline,anchor_id FROM dance_moderated_reviews_v1 x WHERE x.community_id=p_community
   AND encode(sha256(convert_to(jsonb_build_array(p_account,owner.role_assignment_id,owner.authority_revision,p_community,'awaiting_review',x.review_deadline,x.review_id)::TEXT,'UTF8')),'hex')=p_cursor;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid queue cursor' USING ERRCODE='DRV06'; END IF;
 END IF;
 FOR r IN SELECT x.* FROM dance_moderated_reviews_v1 x WHERE x.community_id=p_community
   AND can_owner_read_moderated_dance_v1(p_account,x.review_id)
   AND (p_cursor IS NULL OR (x.review_deadline,x.review_id)>(anchor_deadline,anchor_id))
   ORDER BY x.review_deadline,x.review_id LIMIT 21 LOOP
  total:=total+1;
  IF total=21 THEN more:=TRUE; EXIT; END IF;
  items:=items||jsonb_build_array(jsonb_build_object('review_id',r.review_id,'review_revision',r.revision,
   'community_id',p_community,'song_post_id',r.state->'capture'->>'songPostId',
   'choreography_id',r.state->'capture'->>'choreographyId','choreography_revision',r.state->'capture'->'choreographyRevision',
   'segment_id',r.state->'capture'->>'segmentId','submitted_at',to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'review_deadline',to_char(r.review_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','awaiting_review'));
  next_cursor:=encode(sha256(convert_to(jsonb_build_array(p_account,owner.role_assignment_id,owner.authority_revision,p_community,'awaiting_review',r.review_deadline,r.review_id)::TEXT,'UTF8')),'hex');
 END LOOP;
 RETURN jsonb_build_object('object','dance_owner_review_page','items',items,'next_cursor',CASE WHEN more THEN next_cursor ELSE NULL END);
END $$;
CREATE FUNCTION owner_moderated_dance_detail_v1(p_account TEXT,p_community TEXT,p_review TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; reference dance_moderator_reference_revisions_v1; c JSONB;
BEGIN
 IF NOT can_owner_read_moderated_dance_v1(p_account,p_review) THEN RETURN NULL; END IF;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
 IF r.community_id<>p_community THEN RETURN NULL; END IF;
 c:=r.state->'capture';
 SELECT * INTO STRICT reference FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=c->>'choreographyId' AND revision=(c->>'choreographyRevision')::BIGINT;
 RETURN jsonb_build_object('object','dance_owner_review','review',jsonb_build_object(
   'review_id',r.review_id,'review_revision',r.revision,'community_id',p_community,'song_post_id',c->>'songPostId',
   'choreography_id',c->>'choreographyId','choreography_revision',c->'choreographyRevision','segment_id',c->>'segmentId',
   'submitted_at',to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'review_deadline',to_char(r.review_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','awaiting_review'),
  'reference_post_id',reference.reference_post_id,'video_render_revision',reference.video_render_revision,
  'cue',jsonb_build_object('id',c->>'cueId','start_ms',c->'cueStartMs','end_ms',c->'cueEndMs','hold_ms',c->'cueHoldMs'),
  'body',jsonb_build_object('start_ms',c->'bodyStartMs','end_ms',c->'bodyEndMs'),
  'rubric_version',c->'policy'->>'rubricVersion','rubric_hash',c->'policy'->>'rubricHash',
  'attestation_version','dance-owner-verdict-attestation-v1');
END $$;
DO $read_acl$
DECLARE f RECORD; grantee RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
   AND p.proname IN('latest_owned_moderated_dance_review_v1','can_owner_read_moderated_dance_v1','owner_moderated_dance_queue_v1','owner_moderated_dance_detail_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
  END LOOP;
 END LOOP;
END $read_acl$;

-- Numeric branches below are retained from accepted0082, SHA256 d78f06a3f902aaeeb09a232b719da3d711eb1e524068294b68b2b9188a603d75.
CREATE OR REPLACE FUNCTION guard_activity_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  study_record study_sessions%ROWTYPE;
  study_v2_record RECORD;
  karaoke_session_record karaoke_sessions%ROWTYPE;
  karaoke_attempt_record karaoke_attempts%ROWTYPE;
  karaoke_policy_document JSONB;
  karaoke_policy_kind TEXT;
  expected_evidence JSONB;
  dance_record dance_moderated_reviews_v1;
  dance_policy qualification_policy_versions;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'activity qualifications are append-only';
  END IF;
  IF NEW.activity_key = 'dance' THEN
    SELECT * INTO dance_record FROM dance_moderated_reviews_v1 WHERE review_id=NEW.dance_review_id FOR SHARE;
    SELECT * INTO dance_policy FROM qualification_policy_versions WHERE qualification_policy_version_id=NEW.qualification_policy_version_id;
    expected_evidence:=jsonb_build_object('kind','dance_owner_verdict_v1','review_id',dance_record.review_id,
      'grading_mode','moderator_verdict','verdict','passed','cue_attestation','affirmed',
      'policy_hash',dance_record.state->'capture'->'policy'->>'qualificationHash',
      'admission_hash',dance_record.state->'capture'->'policy'->>'admissionHash',
      'submission_timezone',dance_record.state->'capture'->>'timezone',
      'submission_timezone_version',dance_record.state->'capture'->>'timezoneVersion');
    IF (dance_record.status='reviewed' AND dance_record.state->>'verdict'='passed'
      AND dance_record.state->'attestation'->>'cue'='affirmed'
      AND dance_record.state->'attestation'->>'version'='dance-owner-verdict-attestation-v1'
      AND dance_record.state->'capture'->'policy'->>'admission' IN('streak_admitted','money_admitted')
      AND dance_policy.activity_key='dance' AND dance_policy.policy_kind='dance_owner_verdict_v1'
      AND dance_policy.policy_document->>'policy_hash'=dance_record.state->'capture'->'policy'->>'qualificationHash'
      AND NEW.grading_mode='moderator_verdict' AND NEW.categorical_verdict='passed'
      AND NEW.score_bps IS NULL AND NEW.calibration_id IS NULL AND NEW.numeric_floor_bps IS NULL
      AND NEW.qualification_id=dance_record.state->>'qualificationRef') IS NOT TRUE OR
      ROW(NEW.account_id,NEW.persona_id,NEW.community_id,NEW.post_id,NEW.audio_revision,
        NEW.qualification_policy_version_id,NEW.qualified_at,NEW.streak_day,NEW.evidence_summary)
      IS DISTINCT FROM ROW(dance_record.account_id,dance_record.state->'capture'->>'personaId',dance_record.community_id,
        dance_record.state->'capture'->>'songPostId',(dance_record.state->'capture'->>'audioRevision')::BIGINT,
        dance_record.state->'capture'->'policy'->>'qualificationVersion',dance_record.terminal_at,
        (dance_record.state->'submissionDay'->>'day')::DATE,expected_evidence) THEN
      RAISE EXCEPTION 'Dance qualification is not exact categorical reducer output' USING ERRCODE='DRV04';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.activity_key = 'study' THEN
    SELECT session.account_id, session.persona_id, session.community_id, session.post_id,
           session.audio_revision, session.qualification_policy_revision,
           session.timezone, session.status, session.completed_at,
           count(item.session_item_id)::bigint AS qualifying_exercise_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
           ))::bigint AS presented_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
                AND attempt.attempt_number=1 AND attempt.outcome='correct'
           ))::bigint AS first_pass_correct
      INTO study_v2_record
     FROM study_sessions_v2 session
      JOIN study_session_items_v2 item ON item.session_id=session.session_id
     WHERE session.session_id=NEW.study_session_id
     GROUP BY session.session_id;
    IF study_v2_record.account_id IS NOT NULL THEN
      expected_evidence := jsonb_build_object(
        'kind', 'study_session_first_pass_v2',
        'qualifying_exercise_count', study_v2_record.qualifying_exercise_count,
        'first_pass_correct', study_v2_record.first_pass_correct,
        'required_correct', greatest(
          1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
        )
      );
      IF study_v2_record.status <> 'completed'
         OR study_v2_record.presented_count <> study_v2_record.qualifying_exercise_count
         OR study_v2_record.first_pass_correct < greatest(
           1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
         )
         OR ROW(
           NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
           NEW.audio_revision, NEW.qualification_policy_version_id,
           NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
         ) IS DISTINCT FROM ROW(
           study_v2_record.account_id, study_v2_record.persona_id,
           study_v2_record.community_id, study_v2_record.post_id,
           study_v2_record.audio_revision, study_v2_record.qualification_policy_revision,
           ((10000 * study_v2_record.first_pass_correct)
             / study_v2_record.qualifying_exercise_count)::integer,
           study_v2_record.completed_at,
           (study_v2_record.completed_at AT TIME ZONE study_v2_record.timezone)::date,
           expected_evidence
         ) THEN
        RAISE EXCEPTION 'Study v2 qualification is not exact reducer output';
      END IF;
      RETURN NEW;
    END IF;

    SELECT * INTO study_record FROM study_sessions
     WHERE session_id = NEW.study_session_id FOR SHARE;
    expected_evidence := jsonb_build_object(
      'kind', 'study_session_first_pass_v2',
      'qualifying_exercise_count', study_record.qualifying_exercise_count,
      'first_pass_correct', study_record.first_pass_correct,
      'required_correct', study_record.required_correct
    );
    IF study_record.session_id IS NULL OR study_record.status <> 'completed'
       OR study_record.first_pass_correct < study_record.required_correct
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         study_record.account_id, study_record.persona_id,
         study_record.community_id, study_record.post_id,
         study_record.audio_revision, study_record.qualification_policy_version_id,
         study_record.score_bps, study_record.completed_at,
         study_record.streak_day, expected_evidence
       ) THEN
      RAISE EXCEPTION 'Study qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.activity_key = 'karaoke' THEN
    SELECT * INTO karaoke_session_record FROM karaoke_sessions
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT * INTO karaoke_attempt_record FROM karaoke_attempts
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT policy_kind, policy_document INTO karaoke_policy_kind, karaoke_policy_document
      FROM qualification_policy_versions
     WHERE qualification_policy_version_id = karaoke_session_record.qualification_policy_version_id
       AND activity_key = 'karaoke';
    IF karaoke_session_record.session_id IS NULL
       OR karaoke_session_record.status <> 'completed'
       OR karaoke_attempt_record.completion_reason <> 'completed'
       OR karaoke_attempt_record.scored_line_count < 5
       OR karaoke_attempt_record.coverage_bps < 8500
       OR karaoke_attempt_record.final_score_bps < 7000
       OR (
         karaoke_policy_kind = 'karaoke_qualification_v2'
         AND NOT (karaoke_policy_document->'eligible_playback_kinds'
           ? karaoke_session_record.playback_kind)
       )
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         karaoke_session_record.account_id, karaoke_session_record.persona_id,
         karaoke_session_record.community_id, karaoke_session_record.post_id,
         karaoke_session_record.audio_revision,
         karaoke_session_record.qualification_policy_version_id,
         karaoke_attempt_record.final_score_bps, karaoke_attempt_record.completed_at,
         (karaoke_attempt_record.completed_at AT TIME ZONE karaoke_session_record.timezone)::date,
         karaoke_attempt_record.evidence_summary
       ) THEN
      RAISE EXCEPTION 'Karaoke qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserved activities cannot produce qualifications';
END
$$;
