-- Private prepared guest Study capture. No serving-role grants or endpoint activation.
SELECT pg_advisory_xact_lock(83000003,1);


-- Exact public/current prepared-source query from actual reader, expanded only
-- with the shared projection whitelist plus accepted profile revision/ordinal.
-- No private grader, provider payload, credentials or generation authority.
CREATE FUNCTION guest_study_prepared_rows_v1(TEXT,TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
WITH public_resource AS (
  SELECT can_guest_access_activity_song_v1($1,$2) AS accessible
), source AS (
SELECT coalesce(publication.lyrics_status='ready'
                    AND submission.status='published'
                    AND publication.audio_revision=submission.audio_revision
                    AND publication.lyrics_revision=submission.current_lyrics_revision
                    AND lyrics.lyrics_revision IS NOT NULL, false) AS lyrics_ready,
                    coalesce(publication.language_status='ready', false) AS language_ready,
                    EXISTS(SELECT 1 FROM media_song_stems stem
                      WHERE stem.submission_id=publication.submission_id
                        AND stem.community_id=publication.community_id
                        AND stem.slot='instrumental_audio')
                    AND EXISTS(SELECT 1 FROM media_song_stems stem
                      WHERE stem.submission_id=publication.submission_id
                        AND stem.community_id=publication.community_id
                        AND stem.slot='vocal_audio') AS stems_ready
               FROM media_publication_projections publication
               JOIN media_post_submissions submission
                 ON submission.submission_id=publication.submission_id
                AND submission.community_id=publication.community_id
                AND submission.post_id=publication.post_id
               LEFT JOIN media_song_lyrics_revisions lyrics
                 ON lyrics.submission_id=submission.submission_id
                AND lyrics.lyrics_revision=publication.lyrics_revision
              WHERE publication.community_id=$1 AND publication.post_id=$2
                AND (SELECT accessible FROM public_resource)
), latest AS (
            SELECT DISTINCT ON (exercise.exercise_review_key)
              exercise.exercise_version_id, exercise.exercise_review_key,
              exercise.exercise_type, exercise.exercise_variant, exercise.community_id,
              exercise.post_id, exercise.audio_revision, exercise.lyrics_revision,
              exercise.lyric_line_id, exercise.line_version, exercise.line_source_hash,
              exercise.study_unit_id, exercise.learning_language, exercise.target_language,
              exercise.learner_band, accepted_profile.language_profile_revision,
              exercise.presentation, exercise.answer_visibility, exercise.feedback_release,
              exercise.grader_policy_revision, exercise.feedback_policy_revision,
              exercise.quality_policy_revision, membership.ordinal
              FROM study_exercise_versions exercise
              JOIN media_publication_projections publication
                ON publication.community_id=exercise.community_id AND publication.post_id=exercise.post_id
              JOIN media_post_submissions submission
                ON submission.submission_id=publication.submission_id
               AND submission.community_id=publication.community_id AND submission.post_id=publication.post_id
               AND submission.audio_revision=exercise.audio_revision
               AND submission.current_lyrics_revision=exercise.lyrics_revision
              JOIN media_song_lyrics_revisions lyrics
                ON lyrics.submission_id=submission.submission_id AND lyrics.lyrics_revision=exercise.lyrics_revision
              JOIN localization_lyrics_revision_lines membership
                ON membership.community_id=exercise.community_id AND membership.post_id=exercise.post_id
               AND membership.lyrics_revision=exercise.lyrics_revision AND membership.lyric_line_id=exercise.lyric_line_id
               AND membership.line_version=exercise.line_version
              JOIN localization_lyric_line_versions line
                ON line.community_id=membership.community_id AND line.post_id=membership.post_id
               AND line.lyric_line_id=membership.lyric_line_id AND line.line_version=membership.line_version
               AND line.source_hash=exercise.line_source_hash
              JOIN localization_lyric_line_study_units unit_binding
                ON unit_binding.community_id=membership.community_id AND unit_binding.post_id=membership.post_id
               AND unit_binding.lyric_line_id=membership.lyric_line_id AND unit_binding.line_version=membership.line_version
               AND unit_binding.study_unit_id=exercise.study_unit_id
              JOIN LATERAL (
                SELECT profile.language_profile_revision FROM study_language_profiles profile
                 WHERE profile.community_id=exercise.community_id AND profile.post_id=exercise.post_id
                   AND profile.lyrics_revision=exercise.lyrics_revision AND profile.source_hash=lyrics.lyrics_sha256
                   AND (exercise.language_profile_revision IS NULL OR profile.language_profile_revision=exercise.language_profile_revision)
                 ORDER BY profile.language_profile_revision DESC LIMIT 1
              ) accepted_profile ON TRUE
              JOIN study_language_profile_units unit
                ON unit.community_id=exercise.community_id AND unit.post_id=exercise.post_id
               AND unit.lyrics_revision=exercise.lyrics_revision AND unit.study_unit_id=exercise.study_unit_id
               AND unit.language_profile_revision=accepted_profile.language_profile_revision
             WHERE exercise.community_id=$1 AND exercise.post_id=$2 AND exercise.retired_at IS NULL
               AND publication.audio_revision=exercise.audio_revision AND publication.lyrics_revision=exercise.lyrics_revision
               AND publication.lyrics_status='ready' AND submission.status='published'
               AND EXISTS(SELECT 1 FROM source WHERE lyrics_ready AND language_ready AND stems_ready)
               AND (SELECT accessible FROM public_resource)
             ORDER BY exercise.exercise_review_key, exercise.content_revision DESC
 )
SELECT jsonb_build_object('accessible',public_resource.accessible,
 'source_rows',COALESCE((SELECT jsonb_agg(source) FROM source),'[]'::JSONB),
 'rows',COALESCE((SELECT jsonb_agg(latest ORDER BY exercise_review_key COLLATE "C") FROM latest),'[]'::JSONB))
FROM public_resource;
$$;


-- REVIEW PROPOSAL ONLY. No migration ordinal or serving-role grants assigned.
-- Apply only after accepted genuine0248..0251 plus controlled guest row admission,
-- successful-checkpoint closure, deletion fences and their populated PG fixtures.
-- No HTTP route/composition/paid provider invocation is activated by this packet.
-- All p_access metadata comes ONLY from trusted digest-verified LearningAccess.
-- An ID, browser boolean, session binding string or a client GUC is not proof.
-- Entrypoints alone may later receive reviewed runtime EXECUTE. Helpers stay private.
-- Caller owns one transaction spanning prepare -> pure shared TS projection -> commit.
-- No network/provider/archive work occurs inside this transaction.

-- Deliberately closed until root incorporates and independently accepts the actual
-- row-admission/checkpoint/deletion fences. Do not replace with RETURN/TRUE/flags.
CREATE FUNCTION require_guest_study_composition_v1() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RAISE EXCEPTION 'guest Study composition fences unavailable' USING ERRCODE='GP006'; END $$;

-- Never use caller source as resource ownership. Resolve source from the stored
-- resource first; this helper checks its captured proof after topology/owner locks.
-- Account->guest attachment access is deliberately closed until the actual accepted
-- association authority exists. An ordinary account ID alone cannot read a guest.
CREATE FUNCTION require_guest_study_learning_access_v1(p_access JSONB,p_source TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE credential guest_credentials%ROWTYPE; root TEXT;
BEGIN
 IF p_access IS NULL OR jsonb_typeof(p_access)<>'object'
   OR p_access->>'kind' IS DISTINCT FROM 'guest'
   OR NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=p_source AND kind='guest')
   OR p_access->>'ownerId' IS DISTINCT FROM resolve_guest_empty_owner_root_v1(p_source)
 THEN RAISE EXCEPTION 'learning source mismatch' USING ERRCODE='GP002'; END IF;
 PERFORM lock_guest_authority_sources_v1(p_access->>'origin',ARRAY[p_access->>'credentialId']);
 SELECT * INTO credential FROM guest_credentials WHERE credential_id=p_access->>'credentialId'
   AND origin=p_access->>'origin';
 IF NOT FOUND OR credential.state<>'confirmed' THEN
  RAISE EXCEPTION 'learning proof revoked' USING ERRCODE='GP001'; END IF;
 root:=resolve_guest_empty_owner_root_v1(credential.owner_id);
 -- Original aborted/absent keys remain readable through their proven empty alias.
 -- Accepted sessions/resources establish the source and cannot become empty aliases.
 IF root IS DISTINCT FROM resolve_guest_empty_owner_root_v1(p_source) THEN
  RAISE EXCEPTION 'learning source mismatch' USING ERRCODE='GP002'; END IF;
 IF credential.session_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'learning lease expired' USING ERRCODE='GP007'; END IF;
END $$;

-- Definition generated from the actual prepared reader's public/current-source
-- CTE below in prepared-source.sql. It returns only public projection fields,
-- never private_grader, provider payload, source owner, secret or nonce.
-- guest_study_prepared_rows_v1(text,text) must precede this definition.
-- Single private source selector extracted byte-for-byte from accepted0254.
-- Caller holds trusted source component/proof/resource lock order. This is not
-- a public count endpoint or a capability to dispatch/pay.
CREATE FUNCTION select_guest_study_start_plan_v1(
 p_source_id TEXT,p_community TEXT,p_post TEXT,p_target TEXT,p_band TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE snapshot JSONB; selected_rows JSONB; selected_target TEXT; selected_band TEXT;
 source_count INTEGER; helper_count INTEGER; paid_units INTEGER;
BEGIN
 IF p_band IS NOT NULL AND p_band NOT IN('A1','A2','B1','B2','C1','C2')
  OR p_target IS NOT NULL AND (char_length(p_target)>64 OR p_target='en') THEN
  RAISE EXCEPTION 'prepared selection unavailable' USING ERRCODE='GP006'; END IF;
 snapshot:=guest_study_prepared_rows_v1(p_community,p_post);
 IF snapshot->>'accessible' IS DISTINCT FROM 'true'
  OR jsonb_array_length(snapshot->'source_rows')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(snapshot->'source_rows')
    AS source(lyrics_ready BOOLEAN,language_ready BOOLEAN,stems_ready BOOLEAN)
    WHERE lyrics_ready AND language_ready AND stems_ready) THEN
  RAISE EXCEPTION 'prepared source unavailable' USING ERRCODE='GP006'; END IF;
 IF (SELECT count(DISTINCT prepared->>'target_language') FROM jsonb_array_elements(snapshot->'rows') prepared)>128
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'rows') prepared
    WHERE char_length(prepared->>'target_language')>64 OR prepared->>'learning_language'<>'en'
      OR NOT ((prepared->>'exercise_type'='say_it_back' AND prepared->>'target_language' IS NULL AND prepared->>'learner_band' IS NULL)
        OR (prepared->>'exercise_type'='translation_choice' AND prepared->>'target_language' IS NOT NULL
          AND prepared->>'target_language'<>'en' AND prepared->>'learner_band' IN('A1','A2','B1','B2','C1','C2')))) THEN
  RAISE EXCEPTION 'prepared catalogue exceeds policy' USING ERRCODE='GP006'; END IF;
 SELECT count(*)::INTEGER INTO source_count FROM jsonb_array_elements(snapshot->'rows') prepared
  WHERE prepared->>'exercise_type'='say_it_back' AND prepared->>'target_language' IS NULL AND prepared->>'learner_band' IS NULL;
 -- Do not pool independent helper languages/bands. Prefer source-only for the
 -- fully-null request when at least4 source cards already make a valid lesson.
 IF NOT(p_target IS NULL AND p_band IS NULL AND source_count>=4) THEN
  SELECT prepared->>'target_language',prepared->>'learner_band',count(*)::INTEGER
   INTO selected_target,selected_band,helper_count
   FROM jsonb_array_elements(snapshot->'rows') prepared
   WHERE prepared->>'exercise_type'='translation_choice'
    AND (p_target IS NULL OR prepared->>'target_language'=p_target)
    AND (p_band IS NULL OR prepared->>'learner_band'=p_band)
   GROUP BY prepared->>'target_language',prepared->>'learner_band'
   HAVING count(*)+source_count>=4
   ORDER BY (prepared->>'target_language') COLLATE "C",(prepared->>'learner_band') COLLATE "C" LIMIT 1;
 END IF;
 IF source_count+COALESCE(helper_count,0)<4 THEN
  RAISE EXCEPTION 'insufficient compatible prepared cards' USING ERRCODE='GP006'; END IF;
 SELECT jsonb_agg(candidate.prepared ORDER BY candidate.repetitions,candidate.last_reviewed_at NULLS FIRST,
   candidate.ordinal,(candidate.prepared->>'exercise_review_key') COLLATE "C") INTO selected_rows FROM (
  SELECT prepared,COALESCE(review.repetitions,0) AS repetitions,review.last_reviewed_at,
   (prepared->>'ordinal')::INTEGER AS ordinal
  FROM jsonb_array_elements(snapshot->'rows') prepared LEFT JOIN study_review_items review
    ON review.participation_owner_id=p_source_id
   AND review.post_id=p_post AND review.study_unit_id=prepared->>'study_unit_id'
   AND review.exercise_kind=prepared->>'exercise_type' AND review.learning_language=prepared->>'learning_language'
   AND review.target_language IS NOT DISTINCT FROM prepared->>'target_language'
   AND review.learner_band IS NOT DISTINCT FROM prepared->>'learner_band' AND review.lifecycle_status='active'
  WHERE (prepared->>'exercise_type'='say_it_back' AND prepared->>'target_language' IS NULL AND prepared->>'learner_band' IS NULL)
   OR (prepared->>'exercise_type'='translation_choice' AND prepared->>'target_language'=selected_target
     AND prepared->>'learner_band'=selected_band)
  ORDER BY COALESCE(review.repetitions,0),review.last_reviewed_at NULLS FIRST,(prepared->>'ordinal')::INTEGER,
    (prepared->>'exercise_review_key') COLLATE "C" LIMIT 10
 ) candidate;
 SELECT 2*LEAST(20,3*count(*)::INTEGER) INTO paid_units FROM jsonb_array_elements(selected_rows) prepared
  WHERE prepared->>'exercise_type'='say_it_back';
 RETURN jsonb_build_object(
  'targetLanguage',selected_target,'learnerBand',selected_band,'paidAttemptUnits',paid_units,
  'rows',selected_rows,'catalogue',(SELECT jsonb_agg(grouped ORDER BY exercise_type,target_language NULLS FIRST,learner_band NULLS FIRST) FROM (
    SELECT prepared->>'exercise_type' AS exercise_type,prepared->>'learning_language' AS learning_language,
     prepared->>'target_language' AS target_language,prepared->>'learner_band' AS learner_band,count(*)::INTEGER AS count
    FROM jsonb_array_elements(snapshot->'rows') prepared
    GROUP BY prepared->>'exercise_type',prepared->>'learning_language',prepared->>'target_language',prepared->>'learner_band'
  ) grouped));
END $$;

-- Private atomic-start substep. The owning platform transaction must continue
-- through existing prepare -> pure shared projection -> existing commit. Returning
-- from this SQL function is NOT a COMMIT acknowledgment. Server-only edge/policy,
-- operation/session IDs and verified access are never client privilege witnesses.
CREATE FUNCTION reserve_guest_prepared_study_start_v1(
 p_access JSONB,p_operation JSONB,p_community TEXT,p_post TEXT,p_session_id TEXT,
 p_target TEXT,p_band TEXT,p_fingerprint TEXT,p_policy JSONB,p_operation_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT:=p_operation->>'sourceOwnerId';
 existing guest_resource_session_reservations%ROWTYPE;
 stored_operation guest_participation_operations%ROWTYPE;
 component_ids TEXT[]; fingerprint TEXT; plan JSONB; budget JSONB;
BEGIN
 PERFORM require_guest_study_composition_v1();
 PERFORM validate_guest_resource_operation_v1(source_id,p_operation,'study_start');
 PERFORM 1 FROM guest_resource_global_lock WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource global anchor unavailable' USING ERRCODE='GP006'; END IF;
 -- Immutable original edge precedes GLOBAL/EDGE/full component acquisition.
 -- No fresh edge/catalogue/policy/session draw replaces original receipt identity.
 SELECT * INTO existing FROM guest_resource_session_reservations
  WHERE source_owner_id=source_id AND operation_kind='study_start'
   AND idempotency_key=p_operation->>'idempotencyKey';
 -- A retained original abort/held key without resource has no edge to lock.
 -- Its read-only recovery must not insert a fresh edge or reserve a new plan.
 IF existing.reservation_id IS NULL THEN
  SELECT * INTO stored_operation FROM guest_participation_operations
   WHERE source_owner_id=source_id AND operation_kind='study_start'
    AND idempotency_key=p_operation->>'idempotencyKey';
  IF FOUND THEN
   -- GLOBAL was acquired before the actual credential/full-C proof helper.
   -- This original-source read permits the accepted empty-alias lookup only;
   -- NEW allocation below still uses canonical-only resource locking.
   PERFORM require_guest_study_learning_access_v1(p_access,source_id);
   SELECT * INTO STRICT stored_operation FROM guest_participation_operations
    WHERE source_owner_id=source_id AND operation_kind='study_start'
     AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
   IF ROW(stored_operation.request_hash,stored_operation.resource_scope)
     IS DISTINCT FROM ROW(p_operation->>'requestHash',guest_study_start_resource_scope_v1(p_community,p_post)) THEN
    RAISE EXCEPTION 'start operation identity changed' USING ERRCODE='GP005'; END IF;
   -- Original rights/clock/receipt remain; completed lesson content still needs
   -- the current public, published, general-audience resource authority.
   IF stored_operation.state='completed' AND NOT can_guest_access_activity_song_v1(p_community,p_post) THEN
    RAISE EXCEPTION 'public resource unavailable' USING ERRCODE='GP010'; END IF;
   RETURN jsonb_build_object('kind','start_outcome','outcome',jsonb_build_object(
    'state',stored_operation.state,'operationId',stored_operation.operation_id,'result',stored_operation.result_snapshot));
  END IF;
 END IF;
 fingerprint:=CASE WHEN existing.reservation_id IS NOT NULL THEN existing.edge_fingerprint ELSE p_fingerprint END;
 component_ids:=lock_guest_resource_budget_v1(source_id,fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,source_id);
 SELECT * INTO existing FROM guest_resource_session_reservations
  WHERE source_owner_id=source_id AND operation_kind='study_start'
   AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND AND existing.request_hash IS DISTINCT FROM p_operation->>'requestHash' THEN
  RAISE EXCEPTION 'start operation identity changed' USING ERRCODE='GP005'; END IF;
 SELECT * INTO stored_operation FROM guest_participation_operations
  WHERE source_owner_id=source_id AND operation_kind='study_start'
   AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  IF ROW(stored_operation.request_hash,stored_operation.resource_scope)
    IS DISTINCT FROM ROW(p_operation->>'requestHash',guest_study_start_resource_scope_v1(p_community,p_post)) THEN
   RAISE EXCEPTION 'start operation identity changed' USING ERRCODE='GP005'; END IF;
  IF existing.reservation_id IS NOT NULL AND existing.state='refused' THEN
   IF stored_operation.state<>'known_aborted' THEN
    RAISE EXCEPTION 'refused resource contradicts original start' USING ERRCODE='GP006'; END IF;
   RETURN jsonb_build_object('kind','resource_refused','operationId',stored_operation.operation_id,'plan',NULL,
    'reservation',jsonb_build_object('state','completed','outcome_id',existing.reservation_id,'result',existing.original_result));
  END IF;
  -- Positive main-row evidence, never absence or transport ambiguity. Original
  -- accepted/held/definitely aborted outcome wins before fresh source admission.
  -- Original rights/clock/receipt remain; completed lesson content still needs
  -- the current public, published, general-audience resource authority.
  IF stored_operation.state='completed' AND NOT can_guest_access_activity_song_v1(p_community,p_post) THEN
   RAISE EXCEPTION 'public resource unavailable' USING ERRCODE='GP010'; END IF;
  RETURN jsonb_build_object('kind','start_outcome','outcome',jsonb_build_object(
   'state',stored_operation.state,'operationId',stored_operation.operation_id,'result',stored_operation.result_snapshot));
 END IF;
 IF existing.reservation_id IS NOT NULL THEN
  -- A historical standalone resource receipt is retained, not overwritten or
  -- silently converted into a fabricated new main-abort row. Its original refusal
  -- is positive evidence; no absence of main is called an abort here.
  budget:=reserve_guest_resource_session_v1(source_id,p_operation,existing.session_id,
   existing.initial_units,existing.worst_case_cost_micros::TEXT,existing.edge_fingerprint,p_policy);
  RETURN jsonb_build_object('kind',CASE WHEN existing.state='refused' THEN 'resource_refused' ELSE 'reservation' END,
   'reservation',budget,'plan',NULL,'operationId',NULL);
 END IF;
 -- NEW only: current public resource, complete audio fence, exact current policy,
 -- one actual selector and no IO. Any later projection/disclosure/source refusal
 -- rolls the NEW resource back with the SAME outer transaction.
 IF NOT can_guest_access_activity_song_v1(p_community,p_post) THEN
  RAISE EXCEPTION 'public resource unavailable' USING ERRCODE='GP010'; END IF;
 PERFORM lock_learner_audio_sources_private_v1(component_ids);
 IF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(component_ids)
   AND active_delete_command_id IS NOT NULL) THEN
  RAISE EXCEPTION 'learner audio deletion in progress' USING ERRCODE='GP009'; END IF;
 PERFORM validate_guest_resource_policy_v1(p_policy);
 IF p_operation_id IS NULL OR char_length(p_operation_id) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'server start operation identity unavailable' USING ERRCODE='22023'; END IF;
 plan:=select_guest_study_start_plan_v1(source_id,p_community,p_post,p_target,p_band);
 budget:=reserve_guest_resource_session_v1(source_id,p_operation,p_session_id,
  (plan->>'paidAttemptUnits')::INTEGER,
  ((plan->>'paidAttemptUnits')::NUMERIC*(p_policy->>'maximumProviderCallCostMicros')::NUMERIC)::TEXT,
  p_fingerprint,p_policy);
 IF budget#>>'{result,state}'='reserved' THEN
  RETURN jsonb_build_object('kind','reservation','reservation',budget,'plan',plan,'operationId',NULL);
 END IF;
 IF budget#>>'{result,state}' IS NULL OR budget#>>'{result,state}' NOT IN('rate_limited','budget_refused') THEN
  RAISE EXCEPTION 'unexpected resource refusal' USING ERRCODE='GP006'; END IF;
 -- Definite refusal and its durable main-status witness are atomic. Refusal
 -- response is emitted only after actual outer COMMIT acknowledgment. Unknown
 -- COMMIT remains pending; exact status can later recover this ORIGINAL abort.
 SELECT * INTO STRICT existing FROM guest_resource_session_reservations
  WHERE reservation_id=budget->>'outcome_id' AND source_owner_id=source_id AND state='refused';
 INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,
  idempotency_key,request_hash,state,created_at,resolved_at)
 VALUES(p_operation_id,source_id,'study_start',guest_study_start_resource_scope_v1(p_community,p_post),
  p_operation->>'idempotencyKey',p_operation->>'requestHash','known_aborted',existing.created_at,clock_timestamp());
 RETURN jsonb_build_object('kind','resource_refused','reservation',budget,'plan',plan,'operationId',p_operation_id);
END $$;

CREATE FUNCTION prepare_guest_study_start_v1(
 p_access JSONB,p_operation JSONB,p_community TEXT,p_post TEXT,p_reservation TEXT,
 p_target TEXT,p_band TEXT,p_policy JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE reservation guest_resource_session_reservations%ROWTYPE;
 operation guest_participation_operations%ROWTYPE; plan JSONB;
 component_ids TEXT[]; paid_units INTEGER; stored_policy JSONB;
BEGIN
 PERFORM require_guest_study_composition_v1();
 PERFORM validate_guest_resource_operation_v1(p_operation->>'sourceOwnerId',p_operation,'study_start');
 -- Read immutable edge metadata before row acquisition; lock helper acquires
 -- shared topology -> global budget -> edge -> C-sorted component owners FIRST.
 SELECT * INTO reservation FROM guest_resource_session_reservations
  WHERE reservation_id=p_reservation AND source_owner_id=p_operation->>'sourceOwnerId';
 IF NOT FOUND THEN RAISE EXCEPTION 'resource reservation unavailable' USING ERRCODE='GP006'; END IF;
 component_ids:=lock_guest_resource_budget_v1(reservation.source_owner_id,reservation.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,reservation.source_owner_id);
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations
  WHERE reservation_id=p_reservation FOR UPDATE;
 IF ROW(reservation.operation_kind,reservation.idempotency_key,reservation.request_hash)
   IS DISTINCT FROM ROW('study_start',p_operation->>'idempotencyKey',p_operation->>'requestHash') THEN
  RAISE EXCEPTION 'start operation identity changed' USING ERRCODE='GP005'; END IF;
 IF NOT can_guest_access_activity_song_v1(p_community,p_post) THEN
  RAISE EXCEPTION 'public resource unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO operation FROM guest_participation_operations
  WHERE source_owner_id=reservation.source_owner_id AND operation_kind='study_start'
   AND idempotency_key=reservation.idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF ROW(operation.request_hash,operation.resource_scope)
    IS DISTINCT FROM ROW(reservation.request_hash,
      guest_study_start_resource_scope_v1(p_community,p_post)) THEN
   RAISE EXCEPTION 'start operation identity changed' USING ERRCODE='GP005'; END IF;
  -- Accepted original snapshot wins over later preview, catalogue or policy.
  -- No new candidate, budget, clock, grading, secret or outcome is drawn.
  RETURN jsonb_build_object('state',operation.state,'operationId',operation.operation_id,
    'result',operation.result_snapshot);
 END IF;
 -- Accepted private deletion primitive: never raw owner-array EXECUTE for runtime.
 -- This derives the complete component from the already trusted/locked source.
 PERFORM lock_learner_audio_sources_private_v1(component_ids);
 IF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(component_ids)
   AND active_delete_command_id IS NOT NULL) THEN
  RAISE EXCEPTION 'learner audio deletion in progress' USING ERRCODE='GP009'; END IF;
 IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN
  RAISE EXCEPTION 'accepted paid policy unavailable' USING ERRCODE='GP006'; END IF;
 PERFORM validate_guest_resource_policy_v1(p_policy);
 SELECT policy INTO STRICT stored_policy FROM guest_resource_policy_snapshots
  WHERE policy_version=reservation.policy_version;
 IF stored_policy IS DISTINCT FROM p_policy
  OR reservation.cost_policy_version IS DISTINCT FROM p_policy->>'costPolicyVersion'
  OR reservation.unit_hold_micros IS DISTINCT FROM (p_policy->>'maximumProviderCallCostMicros')::NUMERIC
  OR reservation.state<>'active' OR reservation.reservation_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'accepted paid policy unavailable' USING ERRCODE='GP006'; END IF;
 plan:=select_guest_study_start_plan_v1(reservation.source_owner_id,p_community,p_post,p_target,p_band);
 paid_units:=(plan->>'paidAttemptUnits')::INTEGER;
 IF reservation.remaining_units<paid_units OR reservation.initial_units<paid_units
  OR EXISTS(SELECT 1 FROM guest_resource_provider_calls WHERE reservation_id=p_reservation) THEN
  RAISE EXCEPTION 'prepared paid attempt plan was not reserved' USING ERRCODE='GP006'; END IF;
 RETURN jsonb_build_object('state','candidate','reservationId',reservation.reservation_id,
  'sourceOwnerId',reservation.source_owner_id,'sessionId',reservation.session_id)||plan;
END $$;

-- Actual current rows/public source are re-read in the SAME outer transaction.
-- Changed prepared revisions/filter/rank/policy/proof reject instead of swapping
-- the capture after shared TS projection. The session candidate is reservation's
-- original server draw; p_sessionId/new createdAt draws are intentionally absent.
CREATE FUNCTION commit_guest_study_start_v1(
 p_access JSONB,p_operation JSONB,p_community TEXT,p_post TEXT,p_reservation TEXT,
 p_target TEXT,p_band TEXT,p_policy JSONB,p_candidate JSONB,p_items JSONB,
 p_operation_id TEXT,p_timezone TEXT,p_disclosure_version TEXT,p_accepted_version TEXT,p_accepted BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE checked JSONB; item JSONB; exercise JSONB; ordinal INTEGER:=0; review_id TEXT;
 captured_created TIMESTAMPTZ; captured_expires TIMESTAMPTZ;
 session_id TEXT; source_id TEXT; at_time TIMESTAMPTZ; timezone_name TEXT; result JSONB;
BEGIN
 checked:=prepare_guest_study_start_v1(p_access,p_operation,p_community,p_post,p_reservation,p_target,p_band,p_policy);
 IF checked->>'state'<>'candidate' THEN RETURN checked; END IF;
 IF checked IS DISTINCT FROM p_candidate THEN
  RAISE EXCEPTION 'prepared source changed before capture' USING ERRCODE='GP006'; END IF;
 IF p_accepted IS DISTINCT FROM TRUE OR p_accepted_version IS DISTINCT FROM p_disclosure_version
  OR p_disclosure_version IS NULL OR char_length(p_disclosure_version) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'accepted microphone disclosure unavailable' USING ERRCODE='GP006'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array'
  OR jsonb_array_length(p_items)<>jsonb_array_length(checked->'rows')
  OR jsonb_array_length(p_items) NOT BETWEEN 4 AND 10 THEN
  RAISE EXCEPTION 'prepared public items invalid' USING ERRCODE='GP006'; END IF;
 session_id:=checked->>'sessionId';source_id:=checked->>'sourceOwnerId';at_time:=clock_timestamp();
 SELECT created_at,reservation_expires_at INTO STRICT captured_created,captured_expires
  FROM guest_resource_session_reservations WHERE reservation_id=p_reservation;
 SELECT timezone INTO timezone_name FROM participation_owner_clocks WHERE owner_id=source_id FOR UPDATE;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_timezone) THEN
   RAISE EXCEPTION 'timezone unavailable' USING ERRCODE='GP006'; END IF;
  timezone_name:=p_timezone;
  INSERT INTO participation_owner_clocks(owner_id,timezone,timezone_updated_at,next_change_allowed_at,created_at)
   VALUES(source_id,timezone_name,at_time,at_time+INTERVAL '168 hours',at_time);
 END IF;
 -- Root must wire the controlled row-admission guard for these definer writes;
 -- the deliberately closed composition helper above is not an admission bypass.
 INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,
   idempotency_key,request_hash,state,created_at)
  VALUES(p_operation_id,source_id,'study_start',guest_study_start_resource_scope_v1(p_community,p_post),
   p_operation->>'idempotencyKey',p_operation->>'requestHash','reserved',at_time);
 INSERT INTO study_sessions_v2(session_id,account_id,persona_id,participation_owner_id,participation_owner_kind,
   community_id,post_id,audio_revision,lyrics_revision,learning_language,target_language,learner_band,
   language_profile_revision,study_profile_revision,source_set_revision,selection_policy_revision,
   qualification_policy_revision,timezone,idempotency_key,request_hash,created_at,expires_at,
   current_session_item_id,current_presented_at,guest_reward_mode,guest_reward_terms,
   guest_start_operation_id,guest_disclosure_version,guest_disclosure_accepted,telegram_practice_only,guest_resource_reservation_id,guest_spoken_call_plan)
  VALUES(session_id,NULL,NULL,source_id,'guest',p_community,p_post,
   (checked->'rows'->0->>'audio_revision')::BIGINT,(checked->'rows'->0->>'lyrics_revision')::BIGINT,
   'en',checked->>'targetLanguage',checked->>'learnerBand',
   (checked->'rows'->0->>'language_profile_revision')::BIGINT,1,1,'study_selection_v1',
   'study_session_first_pass_v2@1',timezone_name,p_operation->>'idempotencyKey',p_operation->>'requestHash',
   captured_created,captured_expires,p_items->0->>'session_item_id',at_time,
   'practice_only',NULL,p_operation_id,p_disclosure_version,TRUE,FALSE,p_reservation,
   jsonb_build_object('policy_revision','study_spoken_rerecord_v1',
    'graded_presentation_cap',(checked->>'paidAttemptUnits')::INTEGER/2,
    'ungraded_rerecord_per_presentation',1,'maximum_paid_calls',(checked->>'paidAttemptUnits')::INTEGER));
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  exercise:=checked->'rows'->ordinal;
  -- SQL validates the shared projection's COMPLETE whitelist. Unknown fields,
  -- private grader leakage or a forged public item cannot pass this comparison.
  IF item IS DISTINCT FROM jsonb_build_object(
    'object','study_session_item_v2','session_item_id',session_id||'_item_'||(ordinal+1),
    'ordinal',ordinal,'exercise_review_key',exercise->'exercise_review_key',
    'exercise_version_id',exercise->'exercise_version_id','exercise_type',exercise->'exercise_type',
    'exercise_variant',exercise->'exercise_variant',
    'line',jsonb_build_object('post_id',exercise->'post_id','audio_revision',exercise->'audio_revision',
      'lyrics_revision',exercise->'lyrics_revision','lyric_line_id',exercise->'lyric_line_id',
      'study_unit_id',exercise->'study_unit_id','line_version',exercise->'line_version',
      'line_source_hash',exercise->'line_source_hash'),
    'languages',jsonb_build_object('learning_language',exercise->'learning_language','target_language',exercise->'target_language'),
    'learner_band',exercise->'learner_band','language_profile_revision',exercise->'language_profile_revision',
    'presentation',exercise->'presentation','answer_visibility',exercise->'answer_visibility',
    'feedback_release',exercise->'feedback_release','grader_policy_revision',exercise->'grader_policy_revision',
    'feedback_policy_revision',exercise->'feedback_policy_revision','quality_policy_revision',exercise->'quality_policy_revision',
    'maximum_attempts',3) THEN RAISE EXCEPTION 'public item projection changed' USING ERRCODE='GP006'; END IF;
  review_id:=session_id||'_review_'||(ordinal+1);
  INSERT INTO study_review_items(review_item_id,account_id,participation_owner_id,participation_owner_kind,
    exercise_review_key,current_exercise_version_id,scheduler_policy_revision,scheduler_state,
    community_id,post_id,study_unit_id,exercise_kind,learning_language,target_language,learner_band)
   VALUES(review_id,NULL,source_id,'guest',item->>'exercise_review_key',item->>'exercise_version_id',
    'study_review_schedule_v1','{}',p_community,p_post,item->'line'->>'study_unit_id',item->>'exercise_type',
    item->'languages'->>'learning_language',item->'languages'->>'target_language',item->>'learner_band')
   ON CONFLICT(participation_owner_id,exercise_review_key) DO UPDATE
    SET current_exercise_version_id=excluded.current_exercise_version_id,updated_at=clock_timestamp()
   RETURNING review_item_id INTO review_id;
  INSERT INTO study_session_items_v2(session_item_id,session_id,ordinal,exercise_review_key,exercise_version_id,
    review_item_id,item_snapshot,maximum_attempts,account_id,participation_owner_id,participation_owner_kind)
   VALUES(item->>'session_item_id',session_id,ordinal,item->>'exercise_review_key',item->>'exercise_version_id',
    review_id,item,3,NULL,source_id,'guest');
  INSERT INTO study_lesson_item_state_v2(session_item_id,session_id,original_ordinal)
   VALUES(item->>'session_item_id',session_id,ordinal);
  ordinal:=ordinal+1;
 END LOOP;
 UPDATE participation_owners SET state='established' WHERE owner_id=source_id AND state='empty';
 result:=read_guest_study_session_snapshot_v1(p_access,p_community,session_id);
 UPDATE guest_participation_operations SET state='completed',resolved_at=clock_timestamp(),result_snapshot=result
  WHERE operation_id=p_operation_id;
 RETURN jsonb_build_object('state','completed','operationId',p_operation_id,'result',result);
END $$;

-- Read-only original-key lookup. Absence is pending_confirmation, never a fence,
-- known abort, reservation allocation or replacement-owner/session start.
CREATE FUNCTION find_guest_study_start_operation_v1(p_access JSONB,p_source TEXT,p_community TEXT,p_post TEXT,p_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation guest_participation_operations%ROWTYPE;
BEGIN
 PERFORM require_guest_study_learning_access_v1(p_access,p_source);
 IF NOT can_guest_access_activity_song_v1(p_community,p_post) THEN
  RAISE EXCEPTION 'public resource unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO operation FROM guest_participation_operations
  WHERE source_owner_id=p_source AND operation_kind='study_start' AND idempotency_key=p_key;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','pending_confirmation','session',NULL); END IF;
 IF operation.resource_scope IS DISTINCT FROM guest_study_start_resource_scope_v1(p_community,p_post) THEN
  RAISE EXCEPTION 'start resource mismatch' USING ERRCODE='GP002'; END IF;
 IF operation.state='completed' THEN
  RETURN jsonb_build_object('state','completed','session',operation.result_snapshot->'session'); END IF;
 RETURN jsonb_build_object('state',CASE WHEN operation.state='known_aborted' THEN 'not_started'
  ELSE 'pending_confirmation' END,'session',NULL);
END $$;

-- Root installs all definitions, then binds pinned trusted search_path and revokes
-- PUBLIC plus inherited nonowner function grants as in actual0248..0251. Explicit
-- entrypoint grants stay absent until full module acceptance. No raw-table grants.


-- Private whitelist projection of the CURRENT stored lesson state. No lesson
-- engine/scoring/scheduler mutation. Existing account resource access is retained;
-- account->guest association access is closed until accepted binding authority.
CREATE FUNCTION read_owner_study_session_snapshot_v1(p_access JSONB,p_community TEXT,p_session TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE session study_sessions_v2%ROWTYPE; items JSONB; source JSONB; public_session JSONB;
 count_cards INTEGER; answered INTEGER; correct INTEGER; resolved INTEGER;
 current_presentations INTEGER; at_created TEXT; at_completed TEXT; at_presented TEXT;
BEGIN
 -- Immutable source is read from resource, never supplied by caller.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 SELECT * INTO session FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF session.participation_owner_kind='guest' THEN
  IF p_access->>'kind' IS DISTINCT FROM 'guest'
   OR p_access->>'ownerId' IS DISTINCT FROM session.participation_owner_id
   OR NOT can_guest_access_activity_song_v1(session.community_id,session.post_id) THEN RETURN NULL; END IF;
  PERFORM require_guest_study_learning_access_v1(p_access,session.participation_owner_id);
  -- Every future guest answer/finalizer must hold this same component lock.
  -- Re-read after acquisition so session, items and progress cannot mix states.
  SELECT * INTO STRICT session FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community;
  IF NOT can_guest_access_activity_song_v1(session.community_id,session.post_id) THEN RETURN NULL; END IF;
  source:=jsonb_build_object('kind','guest','ownerId',session.participation_owner_id);
 ELSE
  IF p_access->>'kind' IS DISTINCT FROM 'account'
   OR p_access->>'accountId' IS DISTINCT FROM session.account_id
   OR NOT active_activity_persona(session.account_id,session.persona_id,session.community_id)
   OR NOT can_account_access_activity_song(session.account_id,session.community_id,session.post_id)
   THEN RETURN NULL; END IF;
  source:=jsonb_build_object('kind','account','ownerId',session.participation_owner_id,
   'accountId',session.account_id,'personaId',session.persona_id);
 END IF;
 -- One state snapshot for stored items, attempts and lesson progress, preserving
 -- the existing readSession calculations. No account-only descendant filters.
 WITH item_rows AS MATERIALIZED (
  SELECT i.* FROM study_session_items_v2 i WHERE i.session_id=session.session_id
   AND i.participation_owner_id=session.participation_owner_id
 ), progress AS (
  SELECT count(*)::INTEGER AS cards,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM study_attempts_v2 a
     WHERE a.session_item_id=i.session_item_id AND a.attempt_state='spent'))::INTEGER AS answered,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM study_attempts_v2 a
     WHERE a.session_item_id=i.session_item_id AND a.attempt_number=1 AND a.outcome='correct'))::INTEGER AS correct
  FROM item_rows i
 ), lesson AS (
  SELECT count(*) FILTER(WHERE lesson_resolved)::INTEGER AS resolved,
   COALESCE(max(presentation_count) FILTER(WHERE session_item_id=session.current_session_item_id),0)::INTEGER AS presented
  FROM study_lesson_item_state_v2 WHERE session_id=session.session_id
 ) SELECT COALESCE((SELECT jsonb_agg(item_snapshot ORDER BY ordinal) FROM item_rows),'[]'),
   progress.cards,progress.answered,progress.correct,lesson.resolved,lesson.presented
  INTO items,count_cards,answered,correct,resolved,current_presentations FROM progress CROSS JOIN lesson;
 IF count_cards NOT BETWEEN 4 AND 10 THEN
  RAISE EXCEPTION 'stored Study item closure invalid' USING ERRCODE='GP006'; END IF;
 at_created:=to_char(session.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 at_completed:=CASE WHEN session.completed_at IS NULL THEN NULL ELSE
  to_char(session.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
 at_presented:=CASE WHEN session.current_presented_at IS NULL THEN NULL ELSE
  to_char(session.current_presented_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
 public_session:=jsonb_build_object(
  'object','study_session_v2','session_id',session.session_id,'persona_id',session.persona_id,
  'community_id',session.community_id,'post_id',session.post_id,
  'audio_revision',session.audio_revision,'lyrics_revision',session.lyrics_revision,
  'languages',jsonb_build_object('learning_language',session.learning_language,'target_language',session.target_language),
  'learner_band',session.learner_band,'study_profile_revision',session.study_profile_revision,
  'language_profile_revision',session.language_profile_revision,'source_set_revision',session.source_set_revision,
  'selection_policy_revision',session.selection_policy_revision,'qualification_policy_revision',session.qualification_policy_revision,
  'timezone',session.timezone,'status',session.status,'items',items,
  'progress',jsonb_build_object('qualifying_exercise_count',count_cards,'answered_exercise_count',answered,
   'first_pass_correct',correct,'required_correct',GREATEST(1,ceil(7.0*count_cards/10)::INTEGER),
   'score_bps',CASE WHEN answered=count_cards THEN floor(10000.0*correct/count_cards)::INTEGER ELSE NULL END),
  'lesson',jsonb_build_object('current',CASE WHEN session.current_session_item_id IS NULL THEN NULL ELSE
   jsonb_build_object('session_item_id',session.current_session_item_id,
    'presentation_number',current_presentations+1,'is_reappearance',current_presentations>0,
    'presented_at',at_presented) END,
   'resolved_card_count',resolved,'total_card_count',count_cards,
   'presentation_count',session.presentation_count,'presentation_cap',LEAST(20,3*count_cards),
   'completion_reason',session.completion_reason),
  'created_at',at_created,'completed_at',at_completed);
 IF session.participation_owner_kind='guest' THEN
  IF session.guest_reward_mode IS DISTINCT FROM 'practice_only' OR session.guest_reward_terms IS NOT NULL THEN
   RAISE EXCEPTION 'guest reward composition unavailable' USING ERRCODE='GP006'; END IF;
  public_session:=(public_session-'persona_id')||jsonb_build_object(
   'object','guest_study_session_v1','actor',jsonb_build_object('kind','guest'),
   'owner_id',session.participation_owner_id,
   'expires_at',to_char(session.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'reward_mode','practice_only','reward_terms',NULL,'participation',jsonb_build_object('state','practice_only'));
 END IF;
 RETURN jsonb_build_object('source',source,'session',public_session);
END $$;

CREATE FUNCTION read_guest_study_session_snapshot_v1(p_access JSONB,p_community TEXT,p_session TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
 result:=read_owner_study_session_snapshot_v1(p_access,p_community,p_session);
 IF result IS NULL OR result->'source'->>'kind' IS DISTINCT FROM 'guest' THEN
  RAISE EXCEPTION 'guest session unavailable' USING ERRCODE='GP010'; END IF;
 RETURN result;
END $$;


-- Run only after every function body exists, in the migration's one transaction.
-- Private default and inherited grants are both stripped. No serving-role grant.
-- PRIVATE readonly immutable-plan correlation. Accepted owned callers acquire
-- topology/global/full-component/source/command locks in their prescribed order.
-- This helper acquires no later global lock and grants no dispatch authority.
-- In particular post-I/O capture persistence MUST survive expired session/proof,
-- zero remaining units, and changes to current configured policy. No settlement.
CREATE FUNCTION require_guest_spoken_resource_plan_v1(
 p_source_id TEXT,p_session_id TEXT,p_reservation_id TEXT,p_rerecord_enabled BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE;
 stored_policy JSONB; stored_unit_cost NUMERIC; item_count INTEGER;
 spoken_count INTEGER; presentation_cap INTEGER; expected_plan JSONB;
BEGIN
 IF p_source_id IS NULL OR p_session_id IS NULL OR p_reservation_id IS NULL
  OR p_rerecord_enabled IS NULL THEN
  RAISE EXCEPTION 'captured spoken plan identity required' USING ERRCODE='GP006'; END IF;
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_session_id
  AND participation_owner_id=p_source_id AND participation_owner_kind='guest'
  AND account_id IS NULL AND persona_id IS NULL;
 IF NOT FOUND OR sess.guest_spoken_call_plan IS NULL
  OR sess.guest_resource_reservation_id IS DISTINCT FROM p_reservation_id THEN
  RAISE EXCEPTION 'captured spoken call plan unavailable' USING ERRCODE='GP006'; END IF;
 SELECT * INTO rsv FROM guest_resource_session_reservations WHERE reservation_id=p_reservation_id
  AND source_owner_id=p_source_id AND session_id=p_session_id;
 IF NOT FOUND OR ROW(rsv.operation_kind,rsv.idempotency_key,rsv.request_hash,rsv.created_at,rsv.reservation_expires_at)
   IS DISTINCT FROM ROW('study_start'::TEXT,sess.idempotency_key,sess.request_hash,sess.created_at,sess.expires_at) THEN
  RAISE EXCEPTION 'original spoken reservation mismatch' USING ERRCODE='GP006'; END IF;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE item_snapshot->>'exercise_type'='say_it_back')::INTEGER
  INTO item_count,spoken_count FROM study_session_items_v2
  WHERE session_id=p_session_id AND participation_owner_id=p_source_id AND participation_owner_kind='guest';
 IF item_count NOT BETWEEN 4 AND 10 THEN
  RAISE EXCEPTION 'captured spoken lesson shape unavailable' USING ERRCODE='GP006'; END IF;
 presentation_cap:=LEAST(20,3*spoken_count);
 expected_plan:=jsonb_build_object('policy_revision','study_spoken_rerecord_v1',
  'graded_presentation_cap',presentation_cap,'ungraded_rerecord_per_presentation',1,
  'maximum_paid_calls',2*presentation_cap);
 -- Conservative full v1 headroom is held even when trusted current mode has
 -- rerecord disabled. The per-command captured mode decides whether to use it;
 -- an untrusted request boolean is never a budget or SQL privilege witness.
 IF sess.guest_spoken_call_plan IS DISTINCT FROM expected_plan
  OR rsv.initial_units<2*presentation_cap THEN
  RAISE EXCEPTION 'original spoken plan not fully reserved' USING ERRCODE='GP006'; END IF;
 SELECT policy INTO stored_policy FROM guest_resource_policy_snapshots WHERE policy_version=rsv.policy_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'original spoken resource policy absent' USING ERRCODE='GP006'; END IF;
 SELECT maximum_provider_cost_micros INTO stored_unit_cost FROM guest_resource_cost_policy_snapshots
  WHERE cost_policy_version=rsv.cost_policy_version;
 IF NOT FOUND OR stored_policy->>'costPolicyVersion' IS DISTINCT FROM rsv.cost_policy_version
  OR (stored_policy->>'maximumProviderCallCostMicros')::NUMERIC IS DISTINCT FROM rsv.unit_hold_micros
  OR stored_unit_cost IS DISTINCT FROM rsv.unit_hold_micros
  OR rsv.worst_case_cost_micros IS DISTINCT FROM rsv.initial_units*rsv.unit_hold_micros THEN
  RAISE EXCEPTION 'original spoken cost lineage mismatch' USING ERRCODE='GP006'; END IF;
END $$;

DO $bind_guest_study_starter$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
  RAISE EXCEPTION 'trusted guest Study schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'require_guest_study_composition_v1()',
  'require_guest_spoken_resource_plan_v1(text,text,text,boolean)',
  'select_guest_study_start_plan_v1(text,text,text,text,text)',
  'reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)',
  'require_guest_study_learning_access_v1(jsonb,text)',
  'guest_study_prepared_rows_v1(text,text)',
  'prepare_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb)',
  'commit_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text,text,boolean)',
  'read_owner_study_session_snapshot_v1(jsonb,text,text)',
  'read_guest_study_session_snapshot_v1(jsonb,text,text)',
  'find_guest_study_start_operation_v1(jsonb,text,text,text,text)'
 ] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $bind_guest_study_starter$;


-- PRIVATE REVIEW PROPOSAL; no ordinal, migration, serving grant or endpoint.
-- Install after actual audio foundation and corrected row admission, before
-- starter use. This replaces the starter's unconditional composition refusal
-- for PRIVATE ROW CAPTURE ONLY. Successful provider settlement stays closed by
-- actual require_guest_resource_success_checkpoint_v1; no answer/provider call
-- or deletion worker is composed or accepted by this catalogue closure.
-- The root must atomically extend the actual schema phase/history inventory
-- for every audio foundation relation before this helper can succeed.
CREATE OR REPLACE FUNCTION require_guest_study_composition_v1() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE expected_owner OID; namespace_id OID; trusted_schema TEXT;
 relation_name TEXT; relation_id OID; gate_name TEXT; signature TEXT; function_id OID;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 SELECT c.relowner,c.relnamespace,n.nspname INTO STRICT expected_owner,namespace_id,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 -- This is the actual positive source/history inventory, not relation-absence
 -- evidence, a mutable caller flag, GUC, current_user witness or SQL role claim.
 PERFORM require_guest_practice_only_schema_phase_v1();
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts',
  'study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'
 ] LOOP
  relation_id:=to_regclass(relation_name);
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation_id
    AND relowner=expected_owner AND relnamespace=namespace_id
    AND relrowsecurity AND NOT relforcerowsecurity) THEN
   RAISE EXCEPTION 'private capture row boundary unavailable' USING ERRCODE='GP006'; END IF;
  gate_name:=CASE WHEN relation_name IN('study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2')
   THEN 'guest_raw_account_child_gate_v1' ELSE 'guest_raw_account_gate_v1' END;
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation_id AND polname=gate_name
    AND NOT polpermissive AND polcmd='*' AND polroles=ARRAY[0::OID]
    AND polqual IS NOT NULL AND polwithcheck IS NOT NULL) THEN
   RAISE EXCEPTION 'private capture restrictive policy unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
 -- The exact policy bodies and original account guard are source-review and
 -- genuine-baseline PG obligations, not inferred from their names at runtime.
 FOREACH relation_name IN ARRAY ARRAY[
  'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources',
  'learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts',
  'learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects',
  'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(relation_name)
     AND relowner=expected_owner AND relnamespace=namespace_id AND relkind IN('r','p')) THEN
   RAISE EXCEPTION 'private capture source fence unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
  'require_guest_spoken_resource_plan_v1(text,text,text,boolean)',
  'select_guest_study_start_plan_v1(text,text,text,text,text)',
  'validate_guest_alias_state_v1()', 'validate_study_command_audio_source_v1()',
  'lock_learner_audio_sources_private_v1(text[])','require_guest_learning_runtime_role_v1(regrole)'
 ] LOOP
  function_id:=to_regprocedure(signature);
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=function_id AND proowner=expected_owner
    AND pronamespace=namespace_id AND prosecdef
    AND proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',trusted_schema)])
   OR EXISTS(SELECT 1 FROM pg_proc f
    CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
    WHERE f.oid=function_id AND a.grantee<>f.proowner AND a.privilege_type='EXECUTE') THEN
   RAISE EXCEPTION 'private capture deferred/fence closure unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='study_sessions_v2'::regclass
   AND conname='study_guest_resource_exact_source_session_fk_v1' AND contype='f' AND convalidated
   AND confrelid='guest_resource_session_reservations'::regclass)
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='study_sessions_v2'::regclass
    AND conname='study_guest_spoken_call_plan_shape_v1' AND contype='c' AND convalidated)
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='study_sessions_v2'::regclass
    AND conname='study_guest_disclosure_true_v1' AND contype='c' AND convalidated)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='study_sessions_v2'::regclass
    AND tgname='study_sessions_v2_controlled_guest_authority_v1' AND tgenabled='O'
    AND tgtype=23 AND tgfoid='guard_controlled_guest_study_session_v1()'::regprocedure)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='study_sessions_v2'::regclass
    AND tgname='study_sessions_v2_activity_authority' AND tgenabled='O'
    AND tgtype=23 AND tgfoid='guard_study_v2_activity_authority()'::regprocedure) THEN
  RAISE EXCEPTION 'private capture immutable source admission unavailable' USING ERRCODE='GP006'; END IF;
END $$;

DO $bind_private_capture_readiness$
DECLARE trusted_schema TEXT; expected_owner OID; grantee_name TEXT;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT trusted_schema,expected_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp'
   OR (SELECT proowner FROM pg_proc WHERE oid='require_guest_study_composition_v1()'::regprocedure)<>expected_owner THEN
  RAISE EXCEPTION 'trusted private capture routine owner required'; END IF;
 EXECUTE format('ALTER FUNCTION require_guest_study_composition_v1() SET search_path TO pg_catalog,%I,pg_temp',trusted_schema);
 REVOKE ALL ON FUNCTION require_guest_study_composition_v1() FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid='require_guest_study_composition_v1()'::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION require_guest_study_composition_v1() FROM %I',grantee_name);
 END LOOP;
END $bind_private_capture_readiness$;
