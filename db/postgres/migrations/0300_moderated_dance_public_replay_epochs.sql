-- Public reference descriptors support pure local reindexing. Private attempt
-- frame hashes are never retained here. No key is created, rotated or deleted.
CREATE TABLE dance_moderated_public_replay_v1 (
 choreography_id TEXT NOT NULL, revision BIGINT NOT NULL,
 scope TEXT NOT NULL, normalization_hash TEXT NOT NULL CHECK(normalization_hash~'^[a-f0-9]{64}$'),
 source_sha256 TEXT NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 frames JSONB NOT NULL CHECK(jsonb_typeof(frames)='array' AND jsonb_array_length(frames) BETWEEN 1 AND 3600),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(choreography_id,revision),
 FOREIGN KEY(choreography_id,revision) REFERENCES dance_moderator_reference_revisions_v1(choreography_id,revision)
);
CREATE TRIGGER moderated_public_replay_immutable BEFORE UPDATE OR DELETE ON dance_moderated_public_replay_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_public_replay_no_truncate BEFORE TRUNCATE ON dance_moderated_public_replay_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TABLE dance_moderated_public_replay_indexes_v1 (
 choreography_id TEXT NOT NULL, revision BIGINT NOT NULL, key_epoch TEXT NOT NULL,
 claims JSONB, valid_until TIMESTAMPTZ, work_token TEXT, work_until TIMESTAMPTZ,
 last_checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(choreography_id,revision,key_epoch),
 FOREIGN KEY(choreography_id,revision) REFERENCES dance_moderated_public_replay_v1,
 CHECK((claims IS NULL)=(valid_until IS NULL)),
 CHECK(claims IS NULL OR (jsonb_typeof(claims)='array' AND jsonb_array_length(claims)=2))
);
CREATE TABLE dance_moderated_replay_epochs_v1 (
 key_epoch TEXT PRIMARY KEY CHECK(length(key_epoch) BETWEEN 1 AND 192),
 key_commitment TEXT NOT NULL CHECK(key_commitment~'^[a-f0-9]{64}$'),
 bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE dance_moderated_replay_epoch_retirements_v1 (
 key_epoch TEXT PRIMARY KEY, retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 acceptance_ref TEXT NOT NULL CHECK(length(acceptance_ref) BETWEEN 1 AND 512)
);
CREATE TRIGGER moderated_replay_epoch_immutable BEFORE UPDATE OR DELETE ON dance_moderated_replay_epochs_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_replay_epoch_no_truncate BEFORE TRUNCATE ON dance_moderated_replay_epochs_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_replay_epoch_retirement_immutable BEFORE UPDATE OR DELETE ON dance_moderated_replay_epoch_retirements_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_replay_epoch_retirement_no_truncate BEFORE TRUNCATE ON dance_moderated_replay_epoch_retirements_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();

CREATE FUNCTION bind_moderated_dance_replay_keys_v1(p_keys JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item JSONB; prior TEXT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'replay keys unavailable' USING ERRCODE='DRV02'; END IF;
 IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array' OR jsonb_array_length(p_keys) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'replay keys incomplete' USING ERRCODE='DRV06'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 FOR item IN SELECT value FROM jsonb_array_elements(p_keys) LOOP
  IF (length(item->>'epoch') BETWEEN 1 AND 192 AND item->>'commitment'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'replay key identity invalid' USING ERRCODE='DRV06'; END IF;
  SELECT key_commitment INTO prior FROM dance_moderated_replay_epochs_v1 WHERE key_epoch=item->>'epoch';
  IF prior IS NOT NULL AND prior IS DISTINCT FROM item->>'commitment' THEN RAISE EXCEPTION 'replay key epoch changed' USING ERRCODE='DRV05'; END IF;
  IF prior IS NULL THEN
   IF EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=item->>'epoch') THEN CONTINUE; END IF;
   INSERT INTO dance_moderated_replay_epochs_v1(key_epoch,key_commitment) VALUES(item->>'epoch',item->>'commitment');
  END IF;
 END LOOP;
END $$;

-- Captured producers keep their exact key requirements until their bounded
-- write authority closes. Ready reference history does not pin a key forever.
CREATE FUNCTION moderated_dance_replay_producer_profiles_v1() RETURNS SETOF JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT p.operational_profile FROM dance_review_policy_admissions_v1 a JOIN dance_review_policy_versions_v1 p USING(policy_id)
 WHERE a.accepted AND a.valid_until>statement_timestamp() AND p.valid_until>statement_timestamp()
 UNION ALL SELECT s.terms->'profile' FROM dance_moderated_sessions_v1 s
 WHERE s.state IN('created','consented','awaiting_upload') AND s.expires_at>statement_timestamp()
 UNION ALL SELECT p.operational_profile FROM dance_moderated_reference_commands_v1 c JOIN dance_review_policy_versions_v1 p USING(policy_id)
 WHERE c.state NOT IN('ready','failed') AND (c.worker_deadline IS NULL OR c.worker_deadline>statement_timestamp())
$$;
CREATE FUNCTION moderated_dance_public_replay_requirements_v1() RETURNS TABLE(scope TEXT,normalization_hash TEXT,key_epoch TEXT,retention_ms BIGINT,lease_ms BIGINT)
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT x.profile->>'replayScope',x.normalization_hash,x.profile->>'replayKeyEpoch',
 max((x.profile->>'replayRetentionMs')::BIGINT),max((x.profile->>'workLeaseMs')::BIGINT)
 FROM (
  SELECT p.operational_profile profile,p.review_policy->>'normalizationHash' normalization_hash
  FROM dance_review_policy_admissions_v1 a JOIN dance_review_policy_versions_v1 p USING(policy_id)
  WHERE a.accepted AND a.valid_until>statement_timestamp() AND p.valid_until>statement_timestamp()
  UNION ALL SELECT s.terms->'profile',s.terms->'capture'->'policy'->>'normalizationHash' FROM dance_moderated_sessions_v1 s
  WHERE s.state IN('created','consented','awaiting_upload') AND s.expires_at>statement_timestamp()
 ) x GROUP BY 1,2,3
$$;
CREATE FUNCTION moderated_dance_public_replay_ready_v1(p_scope TEXT,p_normalization TEXT,p_epoch TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
 SELECT NOT EXISTS(SELECT 1 FROM dance_moderator_reference_revisions_v1 r JOIN posts p ON p.community_id=r.community_id AND p.post_id=r.reference_post_id
 WHERE p.status='published' AND p.visibility='public' AND r.alignment_evidence->>'normalization_hash'=p_normalization
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_public_replay_v1 d JOIN dance_moderated_public_replay_indexes_v1 i USING(choreography_id,revision)
 WHERE d.choreography_id=r.choreography_id AND d.revision=r.revision AND d.scope=p_scope AND d.normalization_hash=p_normalization
 AND i.key_epoch=p_epoch AND i.valid_until>clock_timestamp() AND jsonb_array_length(i.claims)=2
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.claims) c WHERE NOT EXISTS(
  SELECT 1 FROM dance_moderated_replay_claims_v1 claim WHERE claim.scope=d.scope AND claim.key_epoch=i.key_epoch
  AND claim.kind=c->>'kind' AND claim.digest=c->>'digest' AND claim.source_kind='reference' AND claim.expires_at>=i.valid_until))))
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=p_epoch)
$$;

CREATE FUNCTION claim_moderated_dance_public_reindex_v1(p_token TEXT,p_epochs JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'public reindex unavailable' USING ERRCODE='DRV02'; END IF;
 IF (length(p_token) BETWEEN 1 AND 192) IS NOT TRUE OR jsonb_typeof(p_epochs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'public reindex identity invalid' USING ERRCODE='DRV06'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT d.*,q.key_epoch,q.retention_ms,q.lease_ms INTO candidate FROM dance_moderated_public_replay_v1 d
 JOIN moderated_dance_public_replay_requirements_v1() q ON q.scope=d.scope AND q.normalization_hash=d.normalization_hash
 JOIN dance_moderator_reference_revisions_v1 r USING(choreography_id,revision)
 JOIN posts p ON p.community_id=r.community_id AND p.post_id=r.reference_post_id AND p.status='published' AND p.visibility='public'
 LEFT JOIN dance_moderated_public_replay_indexes_v1 i ON i.choreography_id=d.choreography_id AND i.revision=d.revision AND i.key_epoch=q.key_epoch
 WHERE p_epochs ? q.key_epoch AND EXISTS(SELECT 1 FROM dance_moderated_replay_epochs_v1 e WHERE e.key_epoch=q.key_epoch)
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 e WHERE e.key_epoch=q.key_epoch)
 AND (i.work_until IS NULL OR i.work_until<=now_at) AND (i.valid_until IS NULL OR i.valid_until<=now_at+(q.lease_ms*interval '1 millisecond'))
 ORDER BY i.last_checked_at NULLS FIRST,d.created_at,d.choreography_id,d.revision,q.key_epoch LIMIT 1;
 IF candidate.choreography_id IS NULL THEN RETURN NULL; END IF;
 INSERT INTO dance_moderated_public_replay_indexes_v1(choreography_id,revision,key_epoch,work_token,work_until)
 VALUES(candidate.choreography_id,candidate.revision,candidate.key_epoch,p_token,now_at+(candidate.lease_ms*interval '1 millisecond'))
 ON CONFLICT(choreography_id,revision,key_epoch) DO UPDATE SET work_token=EXCLUDED.work_token,work_until=EXCLUDED.work_until,last_checked_at=now_at;
 RETURN jsonb_build_object('choreographyId',candidate.choreography_id,'revision',candidate.revision,'scope',candidate.scope,
 'normalizationHash',candidate.normalization_hash,'sourceSha256',candidate.source_sha256,'frames',candidate.frames,'epoch',candidate.key_epoch,'token',p_token);
END $$;

CREATE FUNCTION finish_moderated_dance_public_reindex_v1(p_choreography TEXT,p_revision BIGINT,p_epoch TEXT,p_token TEXT,p_claims JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE d dance_moderated_public_replay_v1; i dance_moderated_public_replay_indexes_v1; item JSONB; prior dance_moderated_replay_claims_v1; retention BIGINT; now_at TIMESTAMPTZ; until_at TIMESTAMPTZ;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'public reindex unavailable' USING ERRCODE='DRV02'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO STRICT d FROM dance_moderated_public_replay_v1 WHERE choreography_id=p_choreography AND revision=p_revision;
 SELECT * INTO STRICT i FROM dance_moderated_public_replay_indexes_v1 WHERE choreography_id=p_choreography AND revision=p_revision AND key_epoch=p_epoch FOR UPDATE;
 now_at:=clock_timestamp();
 SELECT retention_ms INTO retention FROM moderated_dance_public_replay_requirements_v1() q WHERE q.scope=d.scope AND q.normalization_hash=d.normalization_hash AND q.key_epoch=p_epoch;
 IF i.work_token IS DISTINCT FROM p_token OR i.work_until IS NULL OR i.work_until<=now_at OR retention IS NULL
 OR EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=p_epoch)
 OR jsonb_typeof(p_claims) IS DISTINCT FROM 'array' OR jsonb_array_length(p_claims)<>2 THEN RAISE EXCEPTION 'public reindex authority closed' USING ERRCODE='DRV05'; END IF;
 IF (SELECT count(DISTINCT c->>'kind') FROM jsonb_array_elements(p_claims) c)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) c WHERE (c->>'epoch'=p_epoch AND c->>'kind' IN('raw','body') AND c->>'digest'~'^[a-f0-9]{64}$') IS NOT TRUE) THEN RAISE EXCEPTION 'public reindex evidence invalid' USING ERRCODE='DRV06'; END IF;
 until_at:=now_at+(retention*interval '1 millisecond');
 FOR item IN SELECT value FROM jsonb_array_elements(p_claims) ORDER BY value->>'kind',value->>'digest' LOOP
  SELECT * INTO prior FROM dance_moderated_replay_claims_v1 WHERE scope=d.scope AND key_epoch=p_epoch AND kind=item->>'kind' AND digest=item->>'digest';
  IF prior.source_id IS NOT NULL AND prior.source_kind<>'reference' THEN RAISE EXCEPTION 'public recording already claimed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_replay_claims_v1 VALUES(d.scope,p_epoch,item->>'kind',item->>'digest','reference',p_choreography,until_at,now_at)
  ON CONFLICT(scope,key_epoch,kind,digest) DO UPDATE SET expires_at=greatest(dance_moderated_replay_claims_v1.expires_at,EXCLUDED.expires_at);
 END LOOP;
 UPDATE dance_moderated_public_replay_indexes_v1 SET claims=p_claims,valid_until=until_at,work_token=NULL,work_until=NULL,last_checked_at=now_at
 WHERE choreography_id=p_choreography AND revision=p_revision AND key_epoch=p_epoch;
END $$;

-- Remove redundant compatible claims only while every eligible future producer
-- can compare both domains in their same-source replacement epoch. Aliases with
-- different global claim owners wait for finite expiry instead.
CREATE FUNCTION drain_moderated_dance_compatible_replay_v1() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE removed BIGINT; indexes BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'compatible replay drain unavailable' USING ERRCODE='DRV02'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 DELETE FROM dance_moderated_replay_claims_v1 old WHERE
 (old.source_kind='reference' AND old.expires_at<=clock_timestamp()) OR (
 NOT EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 u JOIN dance_moderated_sessions_v1 s USING(session_id)
  WHERE old.source_kind='attempt' AND old.source_id=u.upload_id AND u.normalized_digest IS NOT NULL AND s.terms->'profile'->>'replayKeyEpoch'=old.key_epoch)
 AND EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 raw JOIN dance_moderated_replay_claims_v1 body
  ON body.scope=raw.scope AND body.key_epoch=raw.key_epoch AND body.source_kind=raw.source_kind AND body.source_id=raw.source_id AND body.kind='body'
  WHERE raw.scope=old.scope AND raw.key_epoch<>old.key_epoch AND raw.kind='raw' AND raw.source_kind=old.source_kind AND raw.source_id=old.source_id
  AND least(raw.expires_at,body.expires_at)>=old.expires_at
  AND ((old.source_kind='attempt' AND EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 u JOIN dance_moderated_sessions_v1 s USING(session_id)
   WHERE u.upload_id=old.source_id AND s.terms->'profile'->>'replayKeyEpoch'=raw.key_epoch))
   OR (old.source_kind='reference' AND EXISTS(SELECT 1 FROM moderated_dance_public_replay_requirements_v1() q WHERE q.scope=old.scope AND q.key_epoch=raw.key_epoch)
    AND NOT EXISTS(SELECT 1 FROM moderated_dance_public_replay_requirements_v1() q WHERE q.scope=old.scope AND q.key_epoch=old.key_epoch)))
  AND NOT EXISTS(SELECT 1 FROM moderated_dance_replay_producer_profiles_v1() profile
   WHERE profile->>'replayScope'=old.scope AND ((profile->'replayCompatibleEpochs') ? raw.key_epoch) IS NOT TRUE)
  AND (old.source_kind<>'reference' OR EXISTS(SELECT 1 FROM dance_moderated_public_replay_indexes_v1 i
   WHERE i.choreography_id=old.source_id AND i.key_epoch=raw.key_epoch AND i.valid_until>=old.expires_at))));
 GET DIAGNOSTICS removed=ROW_COUNT;
 DELETE FROM dance_moderated_public_replay_indexes_v1 i USING dance_moderated_public_replay_v1 d
 WHERE i.choreography_id=d.choreography_id AND i.revision=d.revision AND (i.work_until IS NULL OR i.work_until<=clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM moderated_dance_public_replay_requirements_v1() q WHERE q.scope=d.scope AND q.normalization_hash=d.normalization_hash AND q.key_epoch=i.key_epoch)
 AND (i.valid_until IS NULL OR i.valid_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 c WHERE c.scope=d.scope AND c.key_epoch=i.key_epoch AND c.source_kind='reference' AND c.source_id=i.choreography_id));
 GET DIAGNOSTICS indexes=ROW_COUNT;
 RETURN jsonb_build_object('removedClaims',removed,'removedPublicIndexes',indexes);
END $$;

CREATE FUNCTION retire_moderated_dance_replay_epoch_v1(p_epoch TEXT,p_acceptance TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE receipt dance_moderated_replay_epoch_retirements_v1;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_moderated_replay_epochs_v1'::regclass)) THEN RAISE EXCEPTION 'epoch retirement requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 IF length(p_epoch) NOT BETWEEN 1 AND 192 OR length(p_acceptance) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'epoch retirement identity invalid' USING ERRCODE='DRV06'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO receipt FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=p_epoch;
 IF receipt.key_epoch IS NULL THEN
  IF EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 WHERE key_epoch=p_epoch)
  OR EXISTS(SELECT 1 FROM dance_moderated_public_replay_indexes_v1 WHERE key_epoch=p_epoch)
  OR EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 u JOIN dance_moderated_sessions_v1 s USING(session_id) WHERE u.normalized_digest IS NOT NULL AND s.terms->'profile'->>'replayKeyEpoch'=p_epoch)
  OR EXISTS(SELECT 1 FROM moderated_dance_replay_producer_profiles_v1() profile WHERE profile->'replayCompatibleEpochs' ? p_epoch) THEN
   RAISE EXCEPTION 'replay epoch has retained dependencies' USING ERRCODE='DRV07';
  END IF;
  INSERT INTO dance_moderated_replay_epoch_retirements_v1(key_epoch,acceptance_ref) VALUES(p_epoch,p_acceptance) RETURNING * INTO receipt;
 ELSIF receipt.acceptance_ref IS DISTINCT FROM p_acceptance THEN RAISE EXCEPTION 'epoch retirement receipt conflict' USING ERRCODE='DRV03'; END IF;
 RETURN jsonb_build_object('epoch',receipt.key_epoch,'retiredAtMs',floor(extract(epoch FROM receipt.retired_at)*1000)::BIGINT,'acceptanceRef',receipt.acceptance_ref);
END $$;

CREATE FUNCTION guard_moderated_dance_replay_epoch_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=NEW.key_epoch) THEN RAISE EXCEPTION 'replay epoch retired' USING ERRCODE='DRV05'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_replay_claim_epoch BEFORE INSERT OR UPDATE ON dance_moderated_replay_claims_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_replay_epoch_v1();
CREATE TRIGGER moderated_public_replay_index_epoch BEFORE INSERT OR UPDATE ON dance_moderated_public_replay_indexes_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_replay_epoch_v1();


CREATE OR REPLACE FUNCTION publish_moderated_dance_policy_v1(p_input JSONB) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE policy JSONB:=p_input->'policy'; existing dance_review_policy_versions_v1;
 profile JSONB:=p_input->'profile'; disposition JSONB:=p_input->'disposition'; q qualification_policy_versions;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_review_policy_versions_v1'::regclass)) THEN RAISE EXCEPTION 'policy publication requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 IF (p_input->>'version'='dance-moderated-policy-publication-v1' AND length(p_input->>'accepted_by')>0
 AND length(p_input->>'acceptance_ref')>0 AND p_input->>'acceptance_hash'~'^[a-f0-9]{64}$'
 AND policy->>'version'='moderator-review-policy-v1' AND policy->>'hash'~'^[a-f0-9]{64}$'
 AND (policy->>'reviewWindowMs')::BIGINT=604800000 AND profile->>'version'='dance-moderated-intake-profile-v1'
 AND (profile->>'maximumProviderCalls')::BIGINT>=6 AND (profile->>'maximumProviderSpendMicrounits')::NUMERIC>0
 AND policy->>'retentionHash'=disposition->>'hash' AND (disposition->>'accepted')::BOOLEAN
 AND (disposition->'hold'->>'accepted')::BOOLEAN AND length(disposition->'hold'->>'authorityRef')>0
 AND (disposition->'hold'->>'disposeByMs')::NUMERIC>extract(epoch FROM (p_input->>'valid_from')::TIMESTAMPTZ)*1000
 AND least((disposition->>'validUntilMs')::NUMERIC,(disposition->'hold'->>'disposeByMs')::NUMERIC)>=extract(epoch FROM (p_input->>'valid_until')::TIMESTAMPTZ)*1000+(profile->>'sessionTtlMs')::NUMERIC+604800000+greatest((disposition->>'cleanupWithinMs')::NUMERIC,(disposition->>'temporaryCleanupWithinMs')::NUMERIC,(disposition->>'transferWithinMs')::NUMERIC)) IS NOT TRUE THEN
  RAISE EXCEPTION 'policy publication incomplete' USING ERRCODE='DRV06';
 END IF;
 IF (p_input->'producer_registration'->>'status' IN('reserved','active') AND length(p_input->'producer_registration'->>'acceptance_ref')>0
 AND p_input->'producer_registration'->>'acceptance_hash'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'producer registration acceptance required' USING ERRCODE='DRV06'; END IF;
 -- Scope/recipe changes and dropping an old epoch must not partition replay
 -- history. Publication and new capture/reference creation serialize here.
 -- Actual retained claims/current private copies/captured producers constrain
 -- a replacement; public ready-reference history alone is not a key dependency.
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 e WHERE profile->'replayCompatibleEpochs' ? e.key_epoch) THEN RAISE EXCEPTION 'replay epoch retired' USING ERRCODE='DRV07'; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderator_reference_revisions_v1 r
  WHERE r.alignment_evidence->>'normalization_hash' IS DISTINCT FROM policy->>'normalizationHash')
 OR EXISTS(SELECT 1 FROM dance_moderated_public_replay_v1 d WHERE d.scope IS DISTINCT FROM profile->>'replayScope' OR d.normalization_hash IS DISTINCT FROM policy->>'normalizationHash')
 OR EXISTS(SELECT 1 FROM moderated_dance_replay_producer_profiles_v1() prior WHERE prior->>'replayScope' IS DISTINCT FROM profile->>'replayScope'
  OR (prior->>'replayKeyEpoch'<>profile->>'replayKeyEpoch' AND ((profile->'replayCompatibleEpochs') ? (prior->>'replayKeyEpoch')) IS NOT TRUE AND EXISTS(SELECT 1 FROM dance_review_policy_admissions_v1 a JOIN dance_review_policy_versions_v1 other USING(policy_id) WHERE a.community_id<>p_input->>'community_id' AND a.accepted AND a.valid_until>clock_timestamp() AND other.operational_profile=prior)))
 OR EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 c WHERE c.scope IS DISTINCT FROM profile->>'replayScope' OR ((profile->'replayCompatibleEpochs') ? c.key_epoch) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 u JOIN dance_moderated_sessions_v1 session USING(session_id)
  WHERE u.normalized_digest IS NOT NULL AND ((profile->'replayCompatibleEpochs') ? (session.terms->'profile'->>'replayKeyEpoch')) IS NOT TRUE) THEN
  RAISE EXCEPTION 'retained replay family/epochs require compatible normalization' USING ERRCODE='DRV07';
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_sessions_v1 session WHERE session.state IN('created','consented','awaiting_upload') AND session.expires_at>clock_timestamp()
 AND ((profile->'replayCompatibleEpochs') ? (session.terms->'profile'->>'replayKeyEpoch')) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM dance_moderated_reference_commands_v1 c JOIN dance_review_policy_versions_v1 p USING(policy_id) WHERE c.state NOT IN('ready','failed') AND (c.worker_deadline IS NULL OR c.worker_deadline>clock_timestamp())
 AND ((profile->'replayCompatibleEpochs') ? (p.operational_profile->>'replayKeyEpoch')) IS NOT TRUE) THEN RAISE EXCEPTION 'captured replay producer requires its current epoch' USING ERRCODE='DRV07'; END IF;
 SELECT * INTO q FROM qualification_policy_versions WHERE qualification_policy_version_id=policy->>'qualificationVersion' FOR SHARE;
 IF q.qualification_policy_version_id IS NULL THEN
  INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,policy_kind,policy_document)
  VALUES(policy->>'qualificationVersion','dance','dance_owner_verdict_v1',p_input->'qualification_policy_document') RETURNING * INTO q;
 ELSIF q.policy_document IS DISTINCT FROM p_input->'qualification_policy_document' THEN RAISE EXCEPTION 'immutable qualification policy conflict' USING ERRCODE='DRV03'; END IF;
 IF q.activity_key IS DISTINCT FROM 'dance' OR q.policy_kind IS DISTINCT FROM 'dance_owner_verdict_v1'
 OR q.policy_document->>'policy_hash' IS DISTINCT FROM policy->>'qualificationHash'
 OR q.policy_document->>'producer_id' IS DISTINCT FROM policy->>'producerId'
 OR q.policy_document->>'admission' IS DISTINCT FROM policy->>'admission'
 OR q.policy_document->>'admission_version' IS DISTINCT FROM policy->>'admissionVersion'
 OR q.policy_document->>'admission_hash' IS DISTINCT FROM policy->>'admissionHash' THEN
  RAISE EXCEPTION 'qualification admission is a separate prerequisite' USING ERRCODE='DRV07';
 END IF;
 SELECT * INTO existing FROM dance_review_policy_versions_v1 WHERE policy_id=p_input->>'policy_id';
 IF existing.policy_id IS NOT NULL THEN
  IF existing.policy_hash IS DISTINCT FROM policy->>'hash' OR existing.review_policy IS DISTINCT FROM policy
  OR existing.operational_profile IS DISTINCT FROM profile OR existing.disposition_profile IS DISTINCT FROM disposition
  OR NOT EXISTS(SELECT 1 FROM dance_moderated_policy_disclosures_v1 d WHERE d.policy_id=existing.policy_id AND d.disclosure=p_input->'disclosure' AND d.safety_policy_snapshot=p_input->'safety_policy'
    AND d.admission_receipt=jsonb_build_object('accepted_by',p_input->>'accepted_by','acceptance_ref',p_input->>'acceptance_ref','acceptance_hash',p_input->>'acceptance_hash','producer_registration',p_input->'producer_registration')) THEN
   RAISE EXCEPTION 'immutable policy publication conflict' USING ERRCODE='DRV03';
  END IF;
 ELSE
  INSERT INTO dance_review_policy_versions_v1(policy_id,policy_hash,review_policy,operational_profile,disposition_profile,qualification_policy_version_id,accepted_by,valid_from,valid_until)
  VALUES(p_input->>'policy_id',policy->>'hash',policy,profile,disposition,q.qualification_policy_version_id,p_input->>'accepted_by',(p_input->>'valid_from')::TIMESTAMPTZ,(p_input->>'valid_until')::TIMESTAMPTZ);
  INSERT INTO dance_moderated_policy_disclosures_v1(policy_id,disclosure,safety_policy_snapshot,admission_receipt)
  VALUES(p_input->>'policy_id',p_input->'disclosure',p_input->'safety_policy',jsonb_build_object('accepted_by',p_input->>'accepted_by','acceptance_ref',p_input->>'acceptance_ref','acceptance_hash',p_input->>'acceptance_hash','producer_registration',p_input->'producer_registration'));
 END IF;
 -- The explicit, separately receipted producer registration is nonfinancial.
 -- This command does not enable Rewards, a custody policy, or a monetary lane.
 UPDATE activity_registry SET status=p_input->'producer_registration'->>'status',
 producer_version=CASE WHEN p_input->'producer_registration'->>'status'='active' THEN policy->>'producerId' ELSE NULL END,
 current_policy_version_id=CASE WHEN p_input->'producer_registration'->>'status'='active' THEN policy->>'qualificationVersion' ELSE NULL END,
 updated_at=clock_timestamp() WHERE activity_key='dance';
 INSERT INTO dance_review_policy_admissions_v1(community_id,policy_id,accepted,accepted_by,effective_at,valid_until)
 VALUES(p_input->>'community_id',p_input->>'policy_id',TRUE,p_input->>'accepted_by',(p_input->>'valid_from')::TIMESTAMPTZ,(p_input->>'valid_until')::TIMESTAMPTZ)
 ON CONFLICT(community_id) DO UPDATE SET policy_id=EXCLUDED.policy_id,accepted=EXCLUDED.accepted,accepted_by=EXCLUDED.accepted_by,effective_at=EXCLUDED.effective_at,valid_until=EXCLUDED.valid_until;
 RETURN policy->>'hash';
END $$;

CREATE OR REPLACE FUNCTION publish_moderated_dance_reference_v1(p_choreography TEXT,p_token TEXT,p_document JSONB,p_claims JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1; policy dance_review_policy_versions_v1; plan media_song_video_render_plans; master media_song_video_masters; song media_publication_projections; claim JSONB; prior dance_moderated_replay_claims_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 SELECT * INTO STRICT master FROM media_song_video_masters WHERE master_revision_id=command.master_revision_id;
 SELECT * INTO STRICT plan FROM media_song_video_render_plans WHERE plan_id=master.plan_id;
 SELECT * INTO STRICT song FROM media_publication_projections WHERE community_id=command.community_id AND post_id=command.song_post_id AND media_kind='song' AND audio_revision=plan.audio_revision;
 IF command.observation_token IS DISTINCT FROM p_token OR command.provider_job_id IS NULL OR command.worker_deadline<=clock_timestamp()
 OR command.segment_identity IS NULL OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(policy.operational_profile->'replayCompatibleEpochs')
 OR (p_document->>'referenceTermsHash'~'^[a-f0-9]{64}$' AND p_document->>'segmentTermsHash'~'^[a-f0-9]{64}$') IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM posts WHERE community_id=command.community_id AND post_id=command.reference_post_id AND status='published' AND visibility='public') THEN RAISE EXCEPTION 'reference publication unavailable' USING ERRCODE='DRV05'; END IF;
 IF jsonb_typeof(p_document->'publicFrames') IS DISTINCT FROM 'array' OR jsonb_array_length(p_document->'publicFrames') IS DISTINCT FROM ceil(plan.clip_duration_samples::NUMERIC/48000*(policy.operational_profile->>'normalizationFps')::NUMERIC)::INTEGER
 OR jsonb_array_length(p_document->'publicFrames') NOT BETWEEN 1 AND 3600
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_document->'publicFrames') frame WHERE jsonb_typeof(frame) IS DISTINCT FROM 'string' OR (frame#>>'{}')!~'^[a-f0-9]{64}$')
 OR (SELECT count(DISTINCT (c->>'epoch',c->>'kind')) FROM jsonb_array_elements(p_claims) c)<>jsonb_array_length(p_claims) THEN RAISE EXCEPTION 'public reference replay descriptor incomplete' USING ERRCODE='DRV06'; END IF;
 IF command.state='ready'  THEN IF command.reference_terms_hash IS DISTINCT FROM p_document->>'referenceTermsHash' THEN RAISE EXCEPTION 'reference terms changed' USING ERRCODE='DRV05'; END IF; RETURN; END IF;
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  IF (claim->>'digest'~'^[a-f0-9]{64}$' AND claim->>'kind' IN('raw','body') AND policy.operational_profile->'replayCompatibleEpochs' ? (claim->>'epoch')) IS NOT TRUE THEN RAISE EXCEPTION 'reference replay evidence invalid' USING ERRCODE='DRV06'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO prior FROM dance_moderated_replay_claims_v1 WHERE scope=policy.operational_profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF prior.source_id IS NOT NULL AND prior.source_kind<>'reference' THEN RAISE EXCEPTION 'reference recording already claimed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_replay_claims_v1 VALUES(policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','reference',p_choreography,clock_timestamp()+((policy.operational_profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond'),clock_timestamp()) ON CONFLICT(scope,key_epoch,kind,digest) DO UPDATE SET expires_at=greatest(dance_moderated_replay_claims_v1.expires_at,EXCLUDED.expires_at);
 END LOOP;
 INSERT INTO dance_song_segments(segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash)
 VALUES(command.segment_id,command.community_id,command.song_post_id,song.submission_id,plan.audio_revision,plan.clip_start_samples/48,(plan.clip_start_samples+plan.clip_duration_samples)/48,plan.song_duration_samples/48,command.segment_identity->>'key',command.segment_identity->>'sha256','canonical-pcm-excerpt-v1',song.canonical_audio_sha256,p_document->>'segmentTermsHash') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM dance_song_segments WHERE segment_id=command.segment_id AND community_id=command.community_id AND song_post_id=command.song_post_id AND audio_revision=plan.audio_revision AND start_ms=plan.clip_start_samples/48 AND end_ms=(plan.clip_start_samples+plan.clip_duration_samples)/48 AND canonical_segment_sha256=command.segment_identity->>'sha256' AND source_media_sha256=song.canonical_audio_sha256 AND segment_terms_hash=p_document->>'segmentTermsHash') THEN RAISE EXCEPTION 'canonical segment provenance conflict' USING ERRCODE='DRV05'; END IF;
 INSERT INTO dance_moderator_reference_revisions_v1(choreography_id,revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash)
 VALUES(p_choreography,1,command.community_id,command.song_post_id,plan.audio_revision,command.segment_id,command.reference_post_id,master.master_revision_id,master.master_sha256,
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','master_revision_id',master.master_revision_id,'plan_id',plan.plan_id,'source_sha256',master.master_sha256,'segment',command.segment_identity),
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','clip_start_samples',plan.clip_start_samples,'clip_duration_samples',plan.clip_duration_samples,'reference_body_start_ms',0,'reference_body_end_ms',plan.clip_duration_samples/48,'normalization_hash',policy.review_policy->>'normalizationHash'),p_document->>'referenceTermsHash');
 INSERT INTO dance_moderated_public_replay_v1(choreography_id,revision,scope,normalization_hash,source_sha256,frames)
 VALUES(p_choreography,1,policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',master.master_sha256,p_document->'publicFrames');
 INSERT INTO dance_moderated_public_replay_indexes_v1(choreography_id,revision,key_epoch,claims,valid_until)
 SELECT p_choreography,1,e.value,jsonb_agg(proof.value),min(c.expires_at)
 FROM jsonb_array_elements_text(policy.operational_profile->'replayCompatibleEpochs') e(value)
 CROSS JOIN LATERAL jsonb_array_elements(p_claims) proof(value) JOIN dance_moderated_replay_claims_v1 c
 ON c.scope=policy.operational_profile->>'replayScope' AND c.key_epoch=e.value AND c.kind=proof.value->>'kind' AND c.digest=proof.value->>'digest'
 WHERE proof.value->>'epoch'=e.value GROUP BY e.value;
 UPDATE dance_moderated_reference_commands_v1 SET state='ready' ,reference_terms_hash=p_document->>'referenceTermsHash',result=p_document-'publicFrames',observation_until=NULL WHERE choreography_id=p_choreography;
 UPDATE dance_moderated_reference_sources_v1 SET revoked_at=clock_timestamp() WHERE choreography_id=p_choreography AND revoked_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION load_moderated_dance_creation_facts_v1(p_actor TEXT,p_command JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE ref dance_moderator_reference_revisions_v1; seg dance_song_segments;
 policy dance_review_policy_versions_v1; admission dance_review_policy_admissions_v1;
 f dance_review_account_fences_v1; zone account_streak_clocks; disclosure dance_moderated_policy_disclosures_v1; now_at TIMESTAMPTZ:=clock_timestamp(); objectives JSONB;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_command->>'community_id',NULL,TRUE);
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO ref FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=p_command->>'choreography_id' AND revision=(p_command->>'choreography_revision')::BIGINT FOR SHARE;
 IF ref.choreography_id IS NULL OR ROW(ref.community_id,ref.song_post_id) IS DISTINCT FROM ROW(p_command->>'community_id',p_command->>'song_post_id')
 OR NOT active_activity_persona(p_actor,p_command->>'persona_id',ref.community_id)
 OR NOT can_account_access_activity_song(p_actor,ref.community_id,ref.song_post_id)
 OR NOT EXISTS(SELECT 1 FROM posts p WHERE p.community_id=ref.community_id AND p.post_id=ref.reference_post_id AND p.post_type='video' AND p.status='published' AND p.visibility='public' AND can_account_view_content_rating_v1(p_actor,p.content_rating))
 OR EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=ref.choreography_id AND revision=ref.revision) THEN
  RAISE EXCEPTION 'private Dance reference unavailable' USING ERRCODE='DRV02';
 END IF;
 SELECT * INTO seg FROM dance_song_segments WHERE segment_id=ref.segment_id;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=ref.community_id FOR SHARE;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id FOR SHARE;
 SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=p_actor;
 SELECT * INTO disclosure FROM dance_moderated_policy_disclosures_v1 WHERE policy_id=policy.policy_id;
 SELECT * INTO zone FROM account_streak_clocks WHERE account_id=p_actor FOR SHARE;
 IF admission.accepted IS DISTINCT FROM TRUE OR now_at<admission.effective_at OR now_at>=admission.valid_until
 OR now_at<policy.valid_from OR now_at>=policy.valid_until OR policy.policy_hash IS DISTINCT FROM p_command->>'expected_policy_hash'
 OR zone.account_id IS NULL OR disclosure.policy_id IS NULL OR (policy.disposition_profile->>'accepted')::BOOLEAN IS DISTINCT FROM TRUE
 OR (policy.disposition_profile->>'validUntilMs')::NUMERIC<=extract(epoch FROM now_at)*1000
 OR policy.operational_profile->>'version' IS DISTINCT FROM 'dance-moderated-intake-profile-v1' THEN
  RAISE EXCEPTION 'private Dance policy unavailable' USING ERRCODE='DRV07';
 END IF;
 -- Stabilize the shared offer while capturing objectives BEFORE any bytes.
 PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=ref.community_id AND post_id=ref.song_post_id FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',binding->>'objective_id','version',binding->>'qualification_policy_id',
  'termsHash',leg.shared_song_terms_v2->>'terms_hash','fundingPolicyHash',leg.shared_song_terms_v2->>'funding_policy_hash','gradingMode','moderator_verdict') ORDER BY binding->>'binding_id'),'[]'::JSONB)
 INTO objectives FROM jsonb_array_elements(current_shared_song_objectives_v2(p_actor,ref.community_id,ref.song_post_id,ref.audio_revision,'dance')) binding
 JOIN song_reward_offer_legs leg ON leg.qualification_family_v2='shared_song' AND leg.shared_song_terms_v2->'qualification_bindings' @> jsonb_build_array(binding)
 JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id AND offer.community_id=ref.community_id AND offer.post_id=ref.song_post_id AND offer.audio_revision=ref.audio_revision
 JOIN reward_song_slots_v2 slot ON slot.community_id=offer.community_id AND slot.post_id=offer.post_id AND slot.status='open' AND slot.target->>'offer_id'=offer.offer_id AND slot.target->>'pool_leg_id'=leg.leg_id
 WHERE policy.review_policy->>'admission'='money_admitted' AND binding->>'qualification_policy_id'=policy.qualification_policy_version_id;
 RETURN jsonb_build_object('nowMs',floor(extract(epoch FROM now_at)*1000)::BIGINT,'accountFenceRevision',f.revision,
 'accountId',p_actor,'personaId',p_command->>'persona_id','communityId',ref.community_id,'songPostId',ref.song_post_id,
 'audioRevision',ref.audio_revision,'choreographyId',ref.choreography_id,'choreographyRevision',ref.revision,
 'segmentId',ref.segment_id,'bodyDurationMs',seg.duration_ms,'timezone',zone.timezone,
 'timezoneVersion',to_char(zone.timezone_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'policyId',policy.policy_id,'policy',policy.review_policy,'profile',policy.operational_profile,
 'safetyPolicy',disclosure.safety_policy_snapshot,'disposition',policy.disposition_profile,
 'mediaReady',moderated_dance_public_replay_ready_v1(policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',policy.operational_profile->>'replayKeyEpoch') AND EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 ready WHERE ready.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND ready.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND ready.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND ready.observed_at<=now_at AND ready.valid_until>now_at),
 'objectives',coalesce(objectives,'[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION persist_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT,p_frames JSONB,p_claims JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 profile JSONB; claim JSONB; frame JSONB; old dance_moderated_replay_claims_v1; blocked BOOLEAN:=FALSE;
 normalized TEXT; until_at TIMESTAMPTZ; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 work:=lock_moderated_dance_processing_authority_v1(p_upload);
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 now_at:=clock_timestamp();
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 profile:=s.terms->'profile';
 IF NOT moderated_dance_public_replay_ready_v1(profile->>'replayScope',s.terms->'capture'->'policy'->>'normalizationHash',profile->>'replayKeyEpoch') THEN RAISE EXCEPTION 'known public replay index unavailable' USING ERRCODE='DRV07'; END IF;
 IF u.replay_retired_at IS NOT NULL OR EXISTS(SELECT 1 FROM dance_moderated_replay_retirements_v1 WHERE upload_id=p_upload)
 OR work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_job_id IS NULL
 OR work.provider_deadline<=now_at OR jsonb_array_length(p_frames) IS DISTINCT FROM 3
 OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(profile->'replayCompatibleEpochs')
 OR (SELECT count(DISTINCT frame->>'index') FROM jsonb_array_elements(p_frames) frame)<>3 THEN RAISE EXCEPTION 'normalization authority unavailable' USING ERRCODE='DRV05'; END IF;
 IF (SELECT count(DISTINCT (c->>'epoch',c->>'kind')) FROM jsonb_array_elements(p_claims) c)<>jsonb_array_length(p_claims)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) c WHERE (jsonb_typeof(c->'digest')='string' AND c->>'digest'~'^[a-f0-9]{64}$'
 AND c->>'kind' IN('raw','body') AND profile->'replayCompatibleEpochs' ? (c->>'epoch')) IS NOT TRUE) THEN
  RAISE EXCEPTION 'replay proof incomplete' USING ERRCODE='DRV06'; END IF;
 SELECT c->>'digest' INTO normalized FROM jsonb_array_elements(p_claims) c WHERE c->>'kind'='body' AND c->>'epoch'=profile->>'replayKeyEpoch';
 IF normalized IS NULL THEN RAISE EXCEPTION 'current replay proof missing' USING ERRCODE='DRV06'; END IF;
 until_at:=now_at+((profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond');
 -- Deterministic order and a UNIQUE global scope/epoch/kind/digest fence.
 -- Expiry does not authorize reuse here; only the reviewed retention drain may
 -- dispose a claim. Account/key/persona/policy changes cannot free it.
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO old FROM dance_moderated_replay_claims_v1 WHERE scope=profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF old.source_id IS NOT NULL AND (old.source_kind<>'attempt' OR old.source_id<>p_upload) THEN blocked:=TRUE;
  ELSE INSERT INTO dance_moderated_replay_claims_v1 VALUES(profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','attempt',p_upload,until_at,now_at) ON CONFLICT DO NOTHING; END IF;
 END LOOP;
 IF u.server_sha256=(SELECT reference_digest FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision) THEN blocked:=TRUE; END IF;
 FOR frame IN SELECT value FROM jsonb_array_elements(p_frames) LOOP
  IF (jsonb_typeof(frame->'index')='number' AND (frame->>'index')::INTEGER BETWEEN 0 AND 2
   AND frame->>'sha256'~'^[a-f0-9]{64}$' AND (frame->>'timestampMs')::BIGINT=CASE (frame->>'index')::INTEGER WHEN 0 THEN 0 WHEN 1 THEN floor((s.terms->'capture'->>'bodyStartMs')::NUMERIC/2) WHEN 2 THEN floor(((s.terms->'capture'->>'bodyStartMs')::NUMERIC+(s.terms->'capture'->>'bodyEndMs')::NUMERIC)/2) END
   AND frame->'identity'->>'key'='moderated-dance/derived/'||p_upload||'/frame-'||(frame->>'index')||'.jpg'
   AND (frame->'identity'->>'size')::BIGINT BETWEEN 1 AND (profile->>'maximumFrameBytes')::BIGINT
   AND length(frame->'identity'->>'version')>0 AND length(frame->'identity'->>'etag')>0) IS NOT TRUE THEN RAISE EXCEPTION 'private frame proof invalid' USING ERRCODE='DRV06'; END IF;
  IF EXISTS(SELECT 1 FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload AND frame_index=(frame->>'index')::INTEGER AND (object_identity IS DISTINCT FROM frame->'identity' OR sha256 IS DISTINCT FROM frame->>'sha256')) THEN RAISE EXCEPTION 'private frame changed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_frame_artifacts_v1 VALUES(p_upload,(frame->>'index')::INTEGER,frame->'identity',frame->>'sha256',(frame->>'timestampMs')::BIGINT,now_at) ON CONFLICT DO NOTHING;
 END LOOP;
 IF (SELECT count(*) FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload)<>3 THEN RAISE EXCEPTION 'private frames incomplete' USING ERRCODE='DRV06'; END IF;
 UPDATE dance_moderated_uploads_v1 SET state='sealed',sealed_at=bytes_sealed_at,normalized_digest=normalized,replay_expires_at=coalesce(replay_expires_at,until_at),
 normalization_version=s.terms->'capture'->'policy'->>'normalizationVersion',normalization_hash=s.terms->'capture'->'policy'->>'normalizationHash' WHERE upload_id=p_upload;
 UPDATE dance_moderated_processing_v1 SET result=jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END) WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at) VALUES(p_upload,'derived',jsonb_build_object('frames',p_frames),least(s.expires_at,now_at+((SELECT disposition_profile->>'temporaryCleanupWithinMs' FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id)::BIGINT*interval '1 millisecond')),'held',NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
 RETURN jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END);
END $$;

CREATE OR REPLACE FUNCTION read_moderated_dance_capture_options_v1(p_actor TEXT,p_community TEXT,p_post TEXT,p_cursor TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE admission dance_review_policy_admissions_v1; policy dance_review_policy_versions_v1;
 disclosure dance_moderated_policy_disclosures_v1; entries JSONB; available BOOLEAN; code TEXT; now_at TIMESTAMPTZ:=clock_timestamp(); public_policy JSONB; anchor_id TEXT; anchor_revision BIGINT; item RECORD; count_items INTEGER:=0; more BOOLEAN:=FALSE; next_cursor TEXT;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_community,NULL,FALSE);
 IF NOT can_account_access_activity_song(p_actor,p_community,p_post) THEN RAISE EXCEPTION 'song unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=p_community;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id;
 SELECT * INTO disclosure FROM dance_moderated_policy_disclosures_v1 WHERE policy_id=policy.policy_id;
 IF admission.accepted IS DISTINCT FROM TRUE OR admission.effective_at>now_at OR admission.valid_until<=now_at OR policy.valid_from>now_at OR policy.valid_until<=now_at OR disclosure.policy_id IS NULL THEN
  RETURN jsonb_build_object('version','dance-moderated-capture-options-v1','community_id',p_community,'song_post_id',p_post,'ready',FALSE,'unavailable_code','policy_unavailable','policy',NULL,'choreographies','[]'::JSONB,'next_cursor',NULL);
 END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,TRUE,FALSE) THEN RAISE EXCEPTION 'capture read limit reached' USING ERRCODE='DRV07'; END IF;
 public_policy:=jsonb_build_object('policy_hash',policy.policy_hash,'consent_version',policy.review_policy->>'consentVersion','consent_hash',policy.review_policy->>'consentHash','retention_hash',policy.review_policy->>'retentionHash','publication_disclosure_version',policy.review_policy->>'disclosureVersion','disclosure',disclosure.disclosure);
 IF p_cursor IS NOT NULL THEN
  SELECT r.choreography_id,r.revision INTO anchor_id,anchor_revision FROM dance_moderator_reference_revisions_v1 r
   WHERE r.community_id=p_community AND r.song_post_id=p_post
   AND encode(sha256(convert_to(jsonb_build_array(p_actor,p_community,p_post,policy.policy_hash,r.choreography_id,r.revision)::TEXT,'UTF8')),'hex')=p_cursor;
  IF anchor_id IS NULL THEN RAISE EXCEPTION 'invalid capture cursor' USING ERRCODE='DRV06'; END IF;
 END IF;
 entries:='[]';
 FOR item IN SELECT r.*,seg.duration_ms,seg.start_ms,seg.end_ms FROM dance_moderator_reference_revisions_v1 r
 JOIN dance_song_segments seg USING(segment_id) JOIN posts reference ON reference.community_id=r.community_id AND reference.post_id=r.reference_post_id
 WHERE r.community_id=p_community AND r.song_post_id=p_post AND reference.status='published' AND reference.visibility='public'
 AND can_account_view_content_rating_v1(p_actor,reference.content_rating)
 AND (p_cursor IS NULL OR (r.choreography_id,r.revision)>(anchor_id,anchor_revision))
 AND NOT EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 c WHERE c.choreography_id=r.choreography_id AND c.revision=r.revision)
 ORDER BY r.choreography_id,r.revision LIMIT 21 LOOP
  count_items:=count_items+1; IF count_items=21 THEN more:=TRUE; EXIT; END IF;
  entries:=entries||jsonb_build_array(jsonb_build_object('choreography_id',item.choreography_id,'revision',item.revision,'reference_post_id',item.reference_post_id,'segment_id',item.segment_id,'audio_revision',item.audio_revision,
   'body_duration_ms',item.duration_ms,'canonical_song_start_ms',item.start_ms,'canonical_song_end_ms',item.end_ms,
   'reference_body_start_ms',0,'reference_body_end_ms',item.duration_ms,'reference_terms_hash',item.terms_hash));
  next_cursor:=encode(sha256(convert_to(jsonb_build_array(p_actor,p_community,p_post,policy.policy_hash,item.choreography_id,item.revision)::TEXT,'UTF8')),'hex');
 END LOOP;
 SELECT moderated_dance_public_replay_ready_v1(policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',policy.operational_profile->>'replayKeyEpoch') AND EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 r WHERE r.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND r.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND r.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND r.observed_at<=now_at AND r.valid_until>now_at) INTO available;
 code:=CASE WHEN NOT available THEN 'processor_unavailable' WHEN jsonb_array_length(entries)=0 THEN 'reference_unavailable' ELSE NULL END;
 RETURN jsonb_build_object('version','dance-moderated-capture-options-v1','community_id',p_community,'song_post_id',p_post,'ready',code IS NULL,'unavailable_code',code,'policy',public_policy,'choreographies',entries,'next_cursor',CASE WHEN more THEN next_cursor ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION grant_moderated_dance_runtime_v1(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target RECORD; owner_oid OID; names TEXT[]; f RECORD; t RECORD; found_count INTEGER:=0;
BEGIN
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='dance_moderated_sessions_v1'::regclass;
 IF session_user<>pg_get_userbyid(owner_oid) THEN RAISE EXCEPTION 'runtime binding requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication INTO target FROM pg_roles WHERE rolname=p_role;
 IF target.oid IS NULL OR target.oid=owner_oid OR target.rolsuper OR target.rolbypassrls OR target.rolcreaterole OR target.rolcreatedb OR target.rolreplication THEN RAISE EXCEPTION 'runtime role is not confined' USING ERRCODE='DRV06'; END IF;
 FOR t IN SELECT c.oid FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN('r','p') AND
 (c.relname LIKE 'dance_moderated_%_v1' OR c.relname IN('dance_review_account_fences_v1','dance_review_policy_versions_v1','dance_review_policy_admissions_v1','dance_moderator_reference_revisions_v1','dance_moderator_reference_cutoffs_v1')) LOOP
  IF has_table_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'inherited/raw private table privilege must be reconciled first' USING ERRCODE='DRV06'; END IF;
 END LOOP;
 IF p_purpose='account' THEN
  names:=ARRAY['lock_moderated_dance_intake_command_v1','load_moderated_dance_creation_facts_v1','apply_moderated_dance_intake_v1','read_owned_moderated_dance_session_v1','read_moderated_dance_capture_options_v1','create_moderated_dance_reference_v1','read_owned_moderated_dance_reference_v1','issue_moderated_dance_media_lease_v1','resolve_moderated_dance_media_lease_v1',
   'lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1','read_owned_moderated_dance_review_v1','latest_owned_moderated_dance_review_v1','owner_moderated_dance_queue_v1','owner_moderated_dance_detail_v1'];
 ELSIF p_purpose='worker' THEN
  names:=ARRAY['next_moderated_dance_review_task_v1','lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1'];
 ELSIF p_purpose='media' THEN
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1','bind_moderated_dance_replay_keys_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

DO $acl$
DECLARE f RECORD; t TEXT; r RECORD; trusted TEXT:=current_schema();
BEGIN
 FOREACH t IN ARRAY ARRAY['dance_moderated_public_replay_v1','dance_moderated_public_replay_indexes_v1','dance_moderated_replay_epochs_v1','dance_moderated_replay_epoch_retirements_v1'] LOOP
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC CASCADE',t);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t::regclass AND a.grantee NOT IN(0,c.relowner) LOOP EXECUTE format('REVOKE ALL ON %I FROM %I CASCADE',t,r.name); END LOOP;
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname=ANY(ARRAY['bind_moderated_dance_replay_keys_v1','moderated_dance_replay_producer_profiles_v1','moderated_dance_public_replay_requirements_v1','moderated_dance_public_replay_ready_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1','retire_moderated_dance_replay_epoch_v1','guard_moderated_dance_replay_epoch_v1']) LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
 -- CREATE OR REPLACE clears function-local configuration. Restore the trusted
 -- path for every replaced entry point while preserving its restricted grants.
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('publish_moderated_dance_policy_v1','publish_moderated_dance_reference_v1','load_moderated_dance_creation_facts_v1','persist_moderated_dance_normalization_v1','read_moderated_dance_capture_options_v1','grant_moderated_dance_runtime_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
 END LOOP;
END $acl$;
