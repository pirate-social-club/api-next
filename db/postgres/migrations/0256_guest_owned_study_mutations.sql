-- Private original-source mutations; all effects remain uncomposed.
SELECT pg_advisory_xact_lock(83000003,1);

-- Private finite storage checks used by both answer kinds. No ordinal/grants.
-- Trusted adapters derive schedules with the actual shared domain function;
-- these checks close JSON/type/range identities without another scheduler.
CREATE FUNCTION require_guest_review_schedule_private_v1(p_schedule JSONB,p_accepted TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql STABLE AS $$
DECLARE key TEXT; number_value NUMERIC; due TIMESTAMPTZ;
BEGIN
 IF p_schedule IS NULL OR jsonb_typeof(p_schedule) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_schedule))<>6
  OR NOT(p_schedule ?& ARRAY['difficulty','dueAt','lapses','repetitions','stability','state'])
  OR jsonb_typeof(p_schedule->'state') IS DISTINCT FROM 'string'
  OR p_schedule->>'state' NOT IN('learning','relearning','review')
  OR jsonb_typeof(p_schedule->'dueAt') IS DISTINCT FROM 'string'
  OR p_accepted IS NULL OR NOT isfinite(p_accepted) THEN
  RAISE EXCEPTION 'closed shared review schedule required' USING ERRCODE='GP003'; END IF;
 FOREACH key IN ARRAY ARRAY['difficulty','stability','lapses','repetitions'] LOOP
  IF jsonb_typeof(p_schedule->key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'numeric shared review schedule required' USING ERRCODE='GP003'; END IF;
  number_value:=(p_schedule->>key)::NUMERIC;
  IF number_value::TEXT IN('NaN','Infinity','-Infinity')
   OR (key='difficulty' AND number_value NOT BETWEEN 1 AND 10)
   OR (key='stability' AND number_value NOT BETWEEN 0.25 AND 365)
   OR (key IN('lapses','repetitions') AND (number_value<0 OR number_value>9007199254740991 OR trunc(number_value)<>number_value))
   OR (key='repetitions' AND number_value<1) THEN
   RAISE EXCEPTION 'bounded shared review schedule required' USING ERRCODE='GP003'; END IF;
 END LOOP;
 due:=(p_schedule->>'dueAt')::TIMESTAMPTZ;
 IF NOT isfinite(due) OR due<=p_accepted OR due>p_accepted+INTERVAL '366 days' THEN
  RAISE EXCEPTION 'bounded shared review clock required' USING ERRCODE='GP003'; END IF;
END $$;

-- Reads original operation identity, never treats absence as an abort witness.
-- Runtime entrypoints must first resolve actual resource/capture and establish
-- source authority under the reviewed ordered locks. This helper is ungranted.
CREATE FUNCTION require_guest_answer_operation_private_v1(p_source TEXT,p_operation JSONB,
 p_operation_id TEXT,p_community TEXT,p_session TEXT,p_item TEXT,p_attempt INTEGER,p_kind TEXT)
RETURNS guest_participation_operations LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation guest_participation_operations%ROWTYPE;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO STRICT operation FROM guest_participation_operations WHERE operation_id=p_operation_id FOR UPDATE;
 IF ROW(operation.source_owner_id,operation.operation_kind,operation.idempotency_key,operation.request_hash,operation.resource_scope)
  IS DISTINCT FROM ROW(p_source,'study_answer',p_operation->>'idempotencyKey',p_operation->>'requestHash',
    guest_study_answer_resource_scope_v1(p_community,p_session,p_item,p_attempt,p_kind)) THEN
  RAISE EXCEPTION 'original answer identity changed' USING ERRCODE='GP005'; END IF;
 RETURN operation;
END $$;

-- Private source-captured stored-state projector. No new runtime grant.
-- Original provider acceptance authorizes its owning finalizer; this helper
-- cannot itself validate a browser, dispatch new work or grant resource access.
-- Its caller acquires shared topology -> actual global/edge/component -> session
-- before calling. Public live readers retain their own current access predicate.
CREATE FUNCTION project_owner_study_session_private_v1(p_source TEXT,p_community TEXT,p_session TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE session study_sessions_v2%ROWTYPE; items JSONB; source JSONB; public_session JSONB;
 count_cards INTEGER; answered INTEGER; correct INTEGER; resolved INTEGER;
 current_presentations INTEGER; at_created TEXT; at_completed TEXT; at_presented TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 SELECT * INTO session FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'captured Study source missing' USING ERRCODE='GP010'; END IF;
 IF session.participation_owner_kind='guest' THEN
  source:=jsonb_build_object('kind','guest','ownerId',session.participation_owner_id);
 ELSE
  source:=jsonb_build_object('kind','account','ownerId',session.participation_owner_id,
   'accountId',session.account_id,'personaId',session.persona_id);
 END IF;
 -- Caller already proved original capture/source and owns component/session locks.
 -- No current cookie/proof/lease/publication predicate is evaluated here.
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

-- Private proposal, no ordinal/grants/HTTP activation. Requires actual controlled
-- starter/row/audio phase and single exact scope definition owned by checkpoint
-- packet: guest_study_answer_resource_scope_v1(community,session,item,attempt,kind).
-- Trusted runtime context only; locators/plan booleans are not browser authority.
-- Caller owns ONE transaction: prepare -> shared pure choice -> write item facts
-- -> shared effectful continuation -> project/complete durable outcome -> COMMIT.

CREATE FUNCTION prepare_guest_json_answer_v1(
 p_access JSONB,p_operation JSONB,p_community TEXT,p_session TEXT,p_item TEXT,p_attempt INTEGER,p_answer JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE session study_sessions_v2%ROWTYPE; reservation guest_resource_session_reservations%ROWTYPE;
 operation guest_participation_operations%ROWTYPE; selected RECORD; total INTEGER; remaining INTEGER;
BEGIN
 PERFORM require_guest_study_composition_v1();
 -- Resolve actual immutable source BEFORE accepting caller operation/access.
 SELECT * INTO session FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community;
 IF NOT FOUND OR session.participation_owner_kind<>'guest' THEN
  RAISE EXCEPTION 'guest lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations WHERE reservation_id=session.guest_resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(session.participation_owner_id,reservation.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,session.participation_owner_id);
 PERFORM validate_guest_resource_operation_v1(session.participation_owner_id,p_operation,'study_answer');
 IF NOT can_guest_access_activity_song_v1(p_community,session.post_id) THEN
  RAISE EXCEPTION 'guest lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO operation FROM guest_participation_operations WHERE source_owner_id=session.participation_owner_id
  AND operation_kind='study_answer' AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  IF ROW(operation.request_hash,operation.resource_scope) IS DISTINCT FROM
   ROW(p_operation->>'requestHash',guest_study_answer_resource_scope_v1(p_community,p_session,p_item,p_attempt,'choice')) THEN
   RAISE EXCEPTION 'original answer changed' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state',operation.state,'operationId',operation.operation_id,'result',operation.result_snapshot);
 END IF;
 SELECT * INTO STRICT session FROM study_sessions_v2 WHERE session_id=p_session FOR UPDATE;
 IF session.status<>'active' OR session.expires_at<=clock_timestamp()
  OR session.guest_reward_mode IS DISTINCT FROM 'practice_only' OR session.guest_reward_terms IS NOT NULL
  OR session.current_session_item_id IS DISTINCT FROM p_item THEN
  RAISE EXCEPTION 'lesson attempt unavailable' USING ERRCODE='GP003'; END IF;
 SELECT i.item_snapshot,i.maximum_attempts,i.review_item_id,e.content_revision,e.private_grader,
  state.presentation_count,state.lesson_resolved,review.difficulty,review.lapses,review.repetitions,review.stability
 INTO selected FROM study_session_items_v2 i
 JOIN study_exercise_versions e ON e.exercise_version_id=i.exercise_version_id
 JOIN study_lesson_item_state_v2 state ON state.session_item_id=i.session_item_id AND state.session_id=i.session_id
 JOIN study_review_items review ON review.review_item_id=i.review_item_id AND review.participation_owner_id=i.participation_owner_id
 WHERE i.session_item_id=p_item AND i.session_id=p_session AND i.participation_owner_id=session.participation_owner_id
 FOR UPDATE OF i,state,review;
 IF NOT FOUND OR selected.item_snapshot->>'exercise_type' IS DISTINCT FROM 'translation_choice'
  OR selected.private_grader->>'kind' IS DISTINCT FROM 'exact_choice_v1' OR selected.maximum_attempts IS DISTINCT FROM 3
  OR selected.lesson_resolved IS DISTINCT FROM FALSE OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 3 OR p_attempt<>selected.presentation_count+1
  OR p_answer IS NULL OR jsonb_typeof(p_answer)<>'object' OR p_answer->>'kind' IS DISTINCT FROM 'single_select'
  OR p_answer-'kind'-'choice_key'<>'{}'::JSONB OR jsonb_typeof(p_answer->'choice_key') IS DISTINCT FROM 'string'
  OR jsonb_typeof(selected.private_grader->'correct_choice_key') IS DISTINCT FROM 'string'
  OR jsonb_typeof(selected.private_grader->'correct_text') IS DISTINCT FROM 'string'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(selected.item_snapshot->'presentation'->'choices') choice
    WHERE choice->>'choice_key'=p_answer->>'choice_key') THEN
  RAISE EXCEPTION 'lesson attempt unavailable' USING ERRCODE='GP003'; END IF;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE NOT lesson_resolved)::INTEGER INTO total,remaining
  FROM study_lesson_item_state_v2 WHERE session_id=p_session;
 RETURN jsonb_build_object('state','candidate','sourceOwnerId',session.participation_owner_id,
  'communityId',p_community,'sessionId',p_session,'sessionItemId',p_item,'attemptNumber',p_attempt,'answer',p_answer,
  'item',selected.item_snapshot,'reviewItemId',selected.review_item_id,'contentRevision',selected.content_revision,
  'grader',jsonb_build_object('correctChoiceKey',selected.private_grader->'correct_choice_key',
    'correctText',selected.private_grader->'correct_text','explanation',selected.private_grader->'explanation'),
  'review',jsonb_build_object('difficulty',selected.difficulty,'lapses',selected.lapses,'repetitions',selected.repetitions,'stability',selected.stability),
  'priorPresentationCount',session.presentation_count,'currentPresentedAt',session.current_presented_at,
  'acceptedAt',transaction_timestamp(),'totalCards',total,'remainingCards',remaining,
  'resourceReservationId',reservation.reservation_id);
END $$;

-- The finite persistence seam handles actual attempt/presentation/review/item
-- rows once. Decision is derived ONLY by shared evaluateStudyChoice in server;
-- SQL additionally verifies the exact-choice boolean/spent/reveal identities.
CREATE FUNCTION apply_guest_json_item_mutation_v1(
 p_access JSONB,p_operation JSONB,p_capture JSONB,p_decision JSONB,p_operation_id TEXT,p_attempt_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE checked JSONB; item JSONB; correct BOOLEAN; spent BOOLEAN; accepted TIMESTAMPTZ; schedule JSONB;
 source_id TEXT; sid TEXT; iid TEXT; attempt INTEGER; remaining INTEGER; total INTEGER;
BEGIN
 checked:=prepare_guest_json_answer_v1(p_access,p_operation,p_capture->>'communityId',p_capture->>'sessionId',
  p_capture->>'sessionItemId',(p_capture->>'attemptNumber')::INTEGER,p_capture->'answer');
 IF checked->>'state'<>'candidate' THEN RETURN checked; END IF;
 IF checked IS DISTINCT FROM p_capture THEN RAISE EXCEPTION 'locked choice facts changed' USING ERRCODE='GP003'; END IF;
 item:=checked->'item';source_id:=checked->>'sourceOwnerId';sid:=checked->>'sessionId';iid:=checked->>'sessionItemId';
 attempt:=(checked->>'attemptNumber')::INTEGER;accepted:=(checked->>'acceptedAt')::TIMESTAMPTZ;
 correct:=checked->'answer'->>'choice_key'=checked->'grader'->>'correctChoiceKey';spent:=correct OR attempt>=3;
 IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object'
  OR p_decision->>'outcome' IS DISTINCT FROM (CASE WHEN correct THEN 'correct' ELSE 'incorrect' END)
  OR p_decision->>'attemptState' IS DISTINCT FROM (CASE WHEN spent THEN 'spent' ELSE 'retryable' END)
  OR (p_decision->>'correct')::BOOLEAN IS DISTINCT FROM correct
  OR (p_decision->>'spent')::BOOLEAN IS DISTINCT FROM spent
  OR (p_decision->>'resolved')::BOOLEAN IS DISTINCT FROM spent
  OR (p_decision->>'firstPass')::BOOLEAN IS DISTINCT FROM (attempt=1)
  OR (NOT spent AND p_decision->'feedback' IS DISTINCT FROM '{"kind":"none"}'::JSONB)
  OR (spent AND p_decision->'feedback' IS DISTINCT FROM
    jsonb_build_object('kind','choice_reveal','correct_choice_key',checked->'grader'->'correctChoiceKey',
      'correct_text',checked->'grader'->'correctText')||CASE WHEN checked->'grader'->'explanation' IS NULL
      OR checked->'grader'->'explanation'='null'::JSONB THEN '{}'::JSONB ELSE
      jsonb_build_object('explanation',checked->'grader'->'explanation') END) THEN
  RAISE EXCEPTION 'shared choice decision invalid' USING ERRCODE='GP003'; END IF;
 schedule:=p_decision->'review';
 PERFORM require_guest_review_schedule_private_v1(schedule,accepted);
 INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
  VALUES(p_operation_id,source_id,'study_answer',guest_study_answer_resource_scope_v1(checked->>'communityId',sid,iid,attempt,'choice'),
   p_operation->>'idempotencyKey',p_operation->>'requestHash','reserved',clock_timestamp());
 INSERT INTO study_attempts_v2(attempt_id,session_item_id,attempt_number,submission_kind,submission_evidence,outcome,first_pass,
  attempt_state,feedback_kind,feedback_evidence,grader_policy_revision,feedback_policy_revision,accepted_at,idempotency_key,request_hash,
  study_unit_id,exercise_kind,learning_language,target_language,learner_band,source_line_revision,language_profile_revision,
  localization_revision,grading_revision,review_schedule_version,presented_at,answered_at)
 VALUES(p_attempt_id,iid,attempt,'single_select',checked->'answer',CASE WHEN correct THEN 'correct' ELSE 'incorrect' END,attempt=1,
  CASE WHEN spent THEN 'spent' ELSE 'retryable' END,p_decision->'feedback'->>'kind',p_decision->'feedback',
  item->>'grader_policy_revision',item->>'feedback_policy_revision',accepted,p_operation->>'idempotencyKey',p_operation->>'requestHash',
  item->'line'->>'study_unit_id','translation_choice',item->'languages'->>'learning_language',item->'languages'->>'target_language',item->>'learner_band',
  (item->'line'->>'line_version')::BIGINT,(item->>'language_profile_revision')::BIGINT,(checked->>'contentRevision')::BIGINT,
  item->>'grader_policy_revision','study_review_schedule_v1',(checked->>'currentPresentedAt')::TIMESTAMPTZ,accepted);
 INSERT INTO study_presentations_v2(presentation_id,session_id,session_item_id,presentation_number,queue_ordinal,presented_at,answered_at,outcome)
 VALUES('study-presentation-'||p_attempt_id,sid,iid,attempt,(checked->>'priorPresentationCount')::BIGINT,
  (checked->>'currentPresentedAt')::TIMESTAMPTZ,accepted,CASE WHEN correct THEN 'correct' ELSE 'incorrect' END);
 UPDATE study_review_items SET difficulty=(schedule->>'difficulty')::NUMERIC,due_at=(schedule->>'dueAt')::TIMESTAMPTZ,
  lapses=(schedule->>'lapses')::BIGINT,repetitions=(schedule->>'repetitions')::BIGINT,stability=(schedule->>'stability')::NUMERIC,
  review_state=schedule->>'state',last_reviewed_at=accepted,updated_at=accepted,
  scheduler_state=jsonb_build_object('difficulty',schedule->'difficulty','due_at',schedule->'dueAt','lapses',schedule->'lapses',
    'repetitions',schedule->'repetitions','stability',schedule->'stability','state',schedule->'state')
 WHERE review_item_id=checked->>'reviewItemId' AND participation_owner_id=source_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'review source changed' USING ERRCODE='GP003'; END IF;
 UPDATE study_lesson_item_state_v2 SET presentation_count=attempt,last_queue_ordinal=(checked->>'priorPresentationCount')::BIGINT,
  mastered=correct,lesson_resolved=spent,updated_at=accepted WHERE session_item_id=iid AND session_id=sid AND presentation_count=attempt-1;
 IF NOT FOUND THEN RAISE EXCEPTION 'presentation source changed' USING ERRCODE='GP003'; END IF;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE NOT lesson_resolved)::INTEGER INTO total,remaining FROM study_lesson_item_state_v2 WHERE session_id=sid;
 RETURN jsonb_build_object('state','mutated','operationId',p_operation_id,'capture',checked,'decision',p_decision,
  'totalCards',total,'remainingCards',remaining,'priorPresentationCount',(checked->>'priorPresentationCount')::INTEGER);
END $$;

-- Same continuation primitive for choice and ACCEPTED spoken checkpoints.
-- Server feeds shared deriveStudyPresentationTransition result; SQL bounds/
-- actual aggregate checks defend this stage without introducing a second engine.
CREATE FUNCTION apply_guest_lesson_transition_private_v1(p_source TEXT,p_session TEXT,p_prior INTEGER,
 p_kind TEXT,p_next INTEGER,p_completion TEXT,p_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE session study_sessions_v2%ROWTYPE; total INTEGER; remaining INTEGER; next_item TEXT;
BEGIN
 SELECT * INTO STRICT session FROM study_sessions_v2 WHERE session_id=p_session AND participation_owner_id=p_source
  AND participation_owner_kind='guest' FOR UPDATE;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE NOT lesson_resolved)::INTEGER INTO total,remaining
  FROM study_lesson_item_state_v2 WHERE session_id=p_session;
 IF session.status<>'active' OR session.presentation_count<>p_prior OR p_next<>p_prior+1
  OR p_next NOT BETWEEN 1 AND LEAST(20,3*total) THEN
  RAISE EXCEPTION 'lesson transition facts changed' USING ERRCODE='GP003'; END IF;
 IF p_kind='complete' THEN
  IF p_completion IS DISTINCT FROM (CASE WHEN remaining=0 THEN 'all_resolved' ELSE 'presentation_budget' END)
   OR NOT(remaining=0 OR p_next>=LEAST(20,3*total)) THEN
   RAISE EXCEPTION 'completion facts changed' USING ERRCODE='GP003'; END IF;
  UPDATE study_sessions_v2 SET status='completed',completed_at=p_at,presentation_count=p_next,
   completion_reason=p_completion,current_session_item_id=NULL,current_presented_at=NULL WHERE session_id=p_session;
 ELSIF p_kind='advance' THEN
  IF remaining=0 OR p_next>=LEAST(20,3*total) OR p_completion IS NOT NULL THEN
   RAISE EXCEPTION 'advance facts changed' USING ERRCODE='GP003'; END IF;
  SELECT session_item_id INTO STRICT next_item FROM study_lesson_item_state_v2 WHERE session_id=p_session AND NOT lesson_resolved
   ORDER BY CASE WHEN presentation_count=0 THEN 0 ELSE 1 END,last_queue_ordinal NULLS FIRST,original_ordinal LIMIT 1;
  UPDATE study_sessions_v2 SET current_session_item_id=next_item,current_presented_at=p_at,presentation_count=p_next WHERE session_id=p_session;
 ELSIF p_kind='keep_current' THEN
  IF remaining=0 OR p_next>=LEAST(20,3*total) OR p_completion IS NOT NULL THEN
   RAISE EXCEPTION 'retry facts changed' USING ERRCODE='GP003'; END IF;
  -- Choice retry retains its original presentation clock and current card.
  UPDATE study_sessions_v2 SET presentation_count=p_next WHERE session_id=p_session;
 ELSE RAISE EXCEPTION 'closed lesson transition required' USING ERRCODE='GP003'; END IF;
 -- NEVER insert activity_qualifications or touch account streak/token/ticket/
 -- credit/projection facts. Terminal resource release is separate and cannot
 -- release reserved/unknown calls merely because this learning row completed.
END $$;

-- Actual reserved answer/receipt binding around the shared continuation helper.
-- Caller invokes this in the SAME prepare/write transaction. It does not offer
-- an arbitrary source/session transition to the function-only runtime.
CREATE FUNCTION transition_guest_json_answer_v1(p_operation JSONB,p_operation_id TEXT,
 p_capture JSONB,p_decision JSONB,p_transition JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation guest_participation_operations%ROWTYPE; attempt study_attempts_v2%ROWTYPE;
BEGIN
 operation:=require_guest_answer_operation_private_v1(p_capture->>'sourceOwnerId',p_operation,p_operation_id,
  p_capture->>'communityId',p_capture->>'sessionId',p_capture->>'sessionItemId',(p_capture->>'attemptNumber')::INTEGER,'choice');
 IF operation.state IS DISTINCT FROM 'reserved' THEN
  RAISE EXCEPTION 'reserved answer required' USING ERRCODE='GP003'; END IF;
 SELECT a.* INTO STRICT attempt FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id)
  WHERE i.session_id=p_capture->>'sessionId' AND i.participation_owner_id=operation.source_owner_id
   AND a.session_item_id=p_capture->>'sessionItemId' AND a.attempt_number=(p_capture->>'attemptNumber')::INTEGER
   AND a.idempotency_key=operation.idempotency_key AND a.request_hash=operation.request_hash;
 IF attempt.submission_kind IS DISTINCT FROM 'single_select'
  OR attempt.submission_evidence IS DISTINCT FROM p_capture->'answer'
  OR attempt.feedback_evidence IS DISTINCT FROM p_decision->'feedback'
  OR attempt.accepted_at IS DISTINCT FROM (p_capture->>'acceptedAt')::TIMESTAMPTZ
  OR p_transition->>'kind' IS NULL OR p_transition->>'kind' NOT IN('complete','advance','keep_current')
  OR (attempt.attempt_state='retryable' AND p_transition->>'kind'='advance')
  OR (attempt.attempt_state='spent' AND p_transition->>'kind'='keep_current') THEN
  RAISE EXCEPTION 'actual shared continuation receipt changed' USING ERRCODE='GP003'; END IF;
 PERFORM apply_guest_lesson_transition_private_v1(operation.source_owner_id,p_capture->>'sessionId',
  (p_capture->>'priorPresentationCount')::INTEGER,p_transition->>'kind',(p_transition->>'nextPresentationCount')::INTEGER,
  p_transition->>'completionReason',attempt.accepted_at);
END $$;

CREATE FUNCTION finish_guest_json_answer_v1(p_operation JSONB,p_operation_id TEXT,p_capture JSONB,p_decision JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation guest_participation_operations%ROWTYPE; owned JSONB; result JSONB;
BEGIN
 SELECT * INTO STRICT operation FROM guest_participation_operations WHERE operation_id=p_operation_id FOR UPDATE;
 IF ROW(operation.source_owner_id,operation.operation_kind,operation.idempotency_key,operation.request_hash,operation.resource_scope)
  IS DISTINCT FROM ROW(p_capture->>'sourceOwnerId','study_answer',p_operation->>'idempotencyKey',p_operation->>'requestHash',
   guest_study_answer_resource_scope_v1(p_capture->>'communityId',p_capture->>'sessionId',p_capture->>'sessionItemId',(p_capture->>'attemptNumber')::INTEGER,'choice')) THEN
  RAISE EXCEPTION 'original answer identity changed' USING ERRCODE='GP005'; END IF;
 IF operation.state='completed' THEN RETURN jsonb_build_object('state','completed','operationId',operation.operation_id,'result',operation.result_snapshot); END IF;
 IF operation.state<>'reserved' OR NOT EXISTS(SELECT 1 FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id)
  WHERE a.idempotency_key=operation.idempotency_key AND a.request_hash=operation.request_hash
   AND i.participation_owner_id=operation.source_owner_id AND i.session_id=p_capture->>'sessionId'
   AND a.session_item_id=p_capture->>'sessionItemId' AND a.attempt_number=(p_capture->>'attemptNumber')::INTEGER) THEN
  RAISE EXCEPTION 'actual answer receipt missing' USING ERRCODE='GP003'; END IF;
 IF NOT EXISTS(SELECT 1 FROM study_sessions_v2 WHERE session_id=p_capture->>'sessionId'
   AND participation_owner_id=operation.source_owner_id
   AND presentation_count=(p_capture->>'priorPresentationCount')::BIGINT+1) THEN
  RAISE EXCEPTION 'shared lesson continuation receipt missing' USING ERRCODE='GP003'; END IF;
 owned:=project_owner_study_session_private_v1(operation.source_owner_id,p_capture->>'communityId',p_capture->>'sessionId');
 result:=jsonb_build_object('source',owned->'source','answer',jsonb_build_object('object','guest_study_answer_result_v1',
  'session_item_id',p_capture->'sessionItemId','attempt_number',p_capture->'attemptNumber','exercise_type','translation_choice',
  'outcome',p_decision->'outcome','first_pass',p_decision->'firstPass','attempt_state',p_decision->'attemptState',
  'feedback',p_decision->'feedback','session',owned->'session','participation',jsonb_build_object('state','practice_only')),
  'participation',jsonb_build_object('state','practice_only'));
 -- Release only the unspent plan after actual lesson completion. Existing
 -- reserved/unknown provider holds remain retained by the actual251 primitive.
 IF owned#>>'{session,status}'='completed' THEN
  PERFORM release_guest_resource_session_v1(operation.source_owner_id,p_operation,p_capture->>'sessionId',
   p_capture->>'resourceReservationId','completed'); END IF;
 UPDATE guest_participation_operations SET state='completed',result_snapshot=result,resolved_at=clock_timestamp() WHERE operation_id=p_operation_id;
 RETURN jsonb_build_object('state','completed','operationId',p_operation_id,'result',result);
END $$;

-- Private owner-aware spoken context/reserve/failure proposal. No serving
-- grants, ordinal or provider/storage I/O. Requires actual0254 + accepted
-- checkpoint packet in the SAME root-owned atomic composition.
CREATE FUNCTION read_guest_spoken_context_v1(p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT,p_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE; rsv guest_resource_session_reservations%ROWTYPE;
 item study_session_items_v2%ROWTYPE; exercise study_exercise_versions%ROWTYPE; profile study_language_profile_units%ROWTYPE;
 dominant TEXT; provenance JSONB;
BEGIN
 PERFORM require_guest_study_composition_v1();
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_kind='guest';
 IF NOT FOUND THEN RAISE EXCEPTION 'guest spoken lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=sess.guest_resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(sess.participation_owner_id,rsv.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,sess.participation_owner_id);
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=p_session FOR UPDATE;
 IF NOT can_guest_access_activity_song_v1(p_community,sess.post_id)
  OR NOT((sess.status='active' AND sess.expires_at>clock_timestamp() AND sess.current_session_item_id=p_item)
    OR EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE session_id=p_session AND session_item_id=p_item
      AND participation_owner_id=sess.participation_owner_id AND idempotency_key=p_key AND state='completed')) THEN
  RAISE EXCEPTION 'guest spoken lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT item FROM study_session_items_v2 WHERE session_id=p_session AND session_item_id=p_item
  AND participation_owner_id=sess.participation_owner_id;
 SELECT * INTO STRICT exercise FROM study_exercise_versions WHERE exercise_version_id=item.exercise_version_id;
 IF item.item_snapshot->>'exercise_type' IS DISTINCT FROM 'say_it_back'
  OR jsonb_typeof(exercise.private_grader->'reference_text') IS DISTINCT FROM 'string'
  OR NOT((exercise.private_grader->>'kind'='source_token_diff_v1' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_diff_v1')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v2' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v2')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v3' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v3')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v4' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v4')) THEN
  RAISE EXCEPTION 'supported spoken source required' USING ERRCODE='GP003'; END IF;
 SELECT * INTO profile FROM study_language_profile_units WHERE community_id=sess.community_id AND post_id=sess.post_id
  AND lyrics_revision=sess.lyrics_revision AND language_profile_revision=sess.language_profile_revision AND study_unit_id=exercise.study_unit_id;
 dominant:=CASE WHEN profile.mixed IS FALSE AND profile.confidence>=0.8 THEN profile.dominant_language END;
 provenance:=CASE WHEN dominant IS NULL THEN jsonb_build_object('kind','no_authoritative_evidence') ELSE
  jsonb_build_object('kind','unit_profile','community_id',profile.community_id,'post_id',profile.post_id,
   'lyrics_revision',profile.lyrics_revision,'language_profile_revision',profile.language_profile_revision,
   'study_unit_id',profile.study_unit_id,'confidence',profile.confidence,'dominant_language',dominant) END;
 RETURN jsonb_build_object('source',jsonb_build_object('kind','guest','ownerId',sess.participation_owner_id),
  'context',jsonb_build_object('item',item.item_snapshot,'referenceText',exercise.private_grader->>'reference_text',
    'dominantLanguage',dominant,'languageProvenance',provenance));
END $$;

-- Payload is strict-decoded in the trusted platform adapter; SQL closes its
-- finite shape/audio bounds as well. Fresh proof/config is required only for
-- NEW dispatch, and fresh authority is returned only after known COMMIT.
CREATE FUNCTION reserve_guest_spoken_answer_v1(p_access JSONB,p_operation JSONB,p_source TEXT,
 p_payload JSONB,p_reservation TEXT,p_fence BIGINT,p_policy JSONB,p_disclosure_version TEXT,
 p_rerecord_enabled BOOLEAN,p_provider_retention TEXT,p_operation_id TEXT,p_upload_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE; item study_session_items_v2%ROWTYPE; state study_lesson_item_state_v2%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE; main_op guest_participation_operations%ROWTYPE;
 cmd study_spoken_answer_commands%ROWTYPE; artifact learner_audio_artifacts%ROWTYPE;
 component TEXT[]; stored_policy JSONB; provider JSONB; captured JSONB; original_cmd TEXT; original_attempt TEXT; original_artifact TEXT;
 expected_ref TEXT; at_time TIMESTAMPTZ; retention_mode TEXT; artifact_expires TIMESTAMPTZ;
BEGIN
 PERFORM require_guest_study_composition_v1();
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_payload))<>13
  OR NOT(p_payload ?& ARRAY['sessionId','sessionItemId','attemptNumber','audioDigest','audioContentType','audioByteSize','audioDurationMs',
    'commandId','attemptId','artifactId','leaseToken','providerRetention','requestHash'])
  OR jsonb_typeof(p_payload->'audioDigest') IS DISTINCT FROM 'string' OR p_payload->>'audioDigest' !~ '^[0-9a-f]{64}$'
  OR p_payload->>'requestHash' IS DISTINCT FROM p_operation->>'requestHash'
  OR p_payload->>'audioContentType' IS NULL OR p_payload->>'audioContentType' NOT IN('audio/webm','audio/ogg','audio/mp4','audio/wav')
  OR p_provider_retention IS NULL OR p_provider_retention NOT IN('stored','not_stored')
  OR p_payload->>'providerRetention' IS DISTINCT FROM p_provider_retention
  OR jsonb_typeof(p_payload->'attemptNumber') IS DISTINCT FROM 'number' OR (p_payload->>'attemptNumber')::NUMERIC NOT BETWEEN 1 AND 3
  OR trunc((p_payload->>'attemptNumber')::NUMERIC)<>(p_payload->>'attemptNumber')::NUMERIC
  OR jsonb_typeof(p_payload->'audioByteSize') IS DISTINCT FROM 'number' OR (p_payload->>'audioByteSize')::NUMERIC NOT BETWEEN 1 AND 524288
  OR trunc((p_payload->>'audioByteSize')::NUMERIC)<>(p_payload->>'audioByteSize')::NUMERIC
  OR jsonb_typeof(p_payload->'audioDurationMs') IS DISTINCT FROM 'number' OR (p_payload->>'audioDurationMs')::NUMERIC NOT BETWEEN 1 AND 60000
  OR trunc((p_payload->>'audioDurationMs')::NUMERIC)<>(p_payload->>'audioDurationMs')::NUMERIC THEN
  RAISE EXCEPTION 'closed spoken request required' USING ERRCODE='GP003'; END IF;
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_payload->>'sessionId' AND participation_owner_id=p_source
  AND participation_owner_kind='guest';
 IF NOT FOUND THEN RAISE EXCEPTION 'guest spoken lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=sess.guest_resource_reservation_id;
 component:=lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,p_source);
 SELECT * INTO main_op FROM guest_participation_operations WHERE source_owner_id=p_source
  AND operation_kind='study_answer' AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  IF ROW(main_op.request_hash,main_op.resource_scope) IS DISTINCT FROM ROW(p_operation->>'requestHash',
   guest_study_answer_resource_scope_v1(sess.community_id,sess.session_id,p_payload->>'sessionItemId',(p_payload->>'attemptNumber')::INTEGER,'spoken')) THEN
   RAISE EXCEPTION 'original spoken request changed' USING ERRCODE='GP005'; END IF;
  -- Any existing key is observation only; it never reissues its old dispatch.
  IF main_op.state='completed' THEN RETURN jsonb_build_object('state','completed','result',main_op.result_snapshot); END IF;
  RETURN jsonb_build_object('state','pending_confirmation','operation',p_operation);
 END IF;
 PERFORM lock_learner_audio_sources_private_v1(component);
 IF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(component) AND active_delete_command_id IS NOT NULL) THEN
  RAISE EXCEPTION 'learner audio deletion in progress' USING ERRCODE='GP009'; END IF;
 INSERT INTO learner_audio_owner_fences(owner_id) VALUES(p_source) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM learner_audio_owner_fences WHERE owner_id=p_source AND revision=p_fence AND active_delete_command_id IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'new dispatch deletion fence changed' USING ERRCODE='GP009'; END IF;
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=sess.session_id FOR UPDATE;
 SELECT * INTO item FROM study_session_items_v2 WHERE session_id=sess.session_id AND session_item_id=p_payload->>'sessionItemId'
  AND participation_owner_id=p_source FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'spoken item unavailable' USING ERRCODE='GP003'; END IF;
 SELECT * INTO STRICT state FROM study_lesson_item_state_v2 WHERE session_item_id=item.session_item_id AND session_id=sess.session_id FOR UPDATE;
 IF sess.status<>'active' OR sess.expires_at<=clock_timestamp() OR sess.current_session_item_id IS DISTINCT FROM item.session_item_id
  OR item.item_snapshot->>'exercise_type' IS DISTINCT FROM 'say_it_back' OR item.maximum_attempts IS DISTINCT FROM 3
  OR state.lesson_resolved OR (p_payload->>'attemptNumber')::INTEGER<>state.presentation_count+1
  OR sess.guest_reward_mode IS DISTINCT FROM 'practice_only' OR sess.guest_reward_terms IS NOT NULL
  OR NOT can_guest_access_activity_song_v1(sess.community_id,sess.post_id)
  OR ROW(rsv.reservation_id,rsv.source_owner_id,rsv.session_id) IS DISTINCT FROM ROW(p_reservation,p_source,sess.session_id)
  OR sess.guest_disclosure_accepted IS DISTINCT FROM TRUE OR sess.guest_disclosure_version IS DISTINCT FROM p_disclosure_version THEN
  RAISE EXCEPTION 'current spoken admission unavailable' USING ERRCODE='GP003'; END IF;
 PERFORM validate_guest_resource_policy_v1(p_policy);
 SELECT policy INTO STRICT stored_policy FROM guest_resource_policy_snapshots WHERE policy_version=rsv.policy_version;
 IF stored_policy IS DISTINCT FROM p_policy OR rsv.cost_policy_version IS DISTINCT FROM p_policy->>'costPolicyVersion'
  OR rsv.unit_hold_micros IS DISTINCT FROM (p_policy->>'maximumProviderCallCostMicros')::NUMERIC THEN
  RAISE EXCEPTION 'captured resource policy changed' USING ERRCODE='GP006'; END IF;
 -- Required private plan closure owned by the separately reviewed forty-unit
 -- successor. It checks the ORIGINAL stored selected spoken-card allowance
 -- and policy: enabled rerecord needs two paid invocations per graded slot,
 -- while the shared graded presentation cap remains twenty. This helper is
 -- an explicit prerequisite and must stay closed on the actual old20 module.
 -- No permanent policy downgrade and no caller flag manufactures allowance.
 PERFORM require_guest_spoken_resource_plan_v1(p_source,sess.session_id,rsv.reservation_id,p_rerecord_enabled);
 SELECT * INTO cmd FROM study_spoken_answer_commands WHERE session_id=sess.session_id AND participation_owner_id=p_source
  AND session_item_id=item.session_item_id AND attempt_number=(p_payload->>'attemptNumber')::INTEGER AND result_kind='graded' FOR UPDATE;
 IF FOUND THEN
  -- No clock-expiry reclaim. Every retained dispatch must be definitively
  -- terminal, without accepted success, and its actual object absence closed.
  IF cmd.state='completed' OR NOT EXISTS(SELECT 1 FROM guest_study_spoken_captures WHERE command_id=cmd.command_id)
   OR EXISTS(SELECT 1 FROM guest_study_spoken_captures c JOIN guest_resource_provider_calls call_row ON call_row.call_id=c.provider_call_id
     JOIN learner_audio_upload_attempts u ON u.upload_attempt_id=c.upload_attempt_id
     LEFT JOIN guest_study_spoken_checkpoints cp ON cp.capture_id=c.capture_id
     WHERE c.command_id=cmd.command_id AND (cp.checkpoint_id IS NOT NULL OR call_row.disposition NOT IN('failed','not_invoked')
       OR u.io_state<>'closed' OR u.storage_disposition IS DISTINCT FROM 'absent' OR u.cleanup_required)) THEN
   RETURN jsonb_build_object('state','pending_confirmation','operation',p_operation); END IF;
  SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=cmd.learner_audio_artifact_id FOR UPDATE;
  IF artifact.recording_state NOT IN('pending','failed') OR artifact.deleted_at IS NOT NULL
   OR artifact.provider_retention IS DISTINCT FROM p_provider_retention
   OR EXISTS(SELECT 1 FROM study_attempts_v2 WHERE learner_audio_artifact_id=artifact.learner_audio_artifact_id) THEN
   RAISE EXCEPTION 'accepted artifact cannot be reclaimed' USING ERRCODE='GP003'; END IF;
  original_cmd:=cmd.command_id;original_attempt:=cmd.attempt_id;original_artifact:=cmd.learner_audio_artifact_id;
 ELSE
  original_cmd:=p_payload->>'commandId';original_attempt:=p_payload->>'attemptId';original_artifact:=p_payload->>'artifactId';
 END IF;
 IF p_payload->>'leaseToken' IS NULL OR char_length(p_payload->>'leaseToken') NOT BETWEEN 1 AND 256
  OR p_operation_id IS NULL OR char_length(p_operation_id) NOT BETWEEN 1 AND 128
  OR p_upload_id IS NULL OR char_length(p_upload_id) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'private generated command identity required' USING ERRCODE='GP003'; END IF;
 -- FUTURE recording generation uses the actual source preference. Exact
 -- accepted-key replay above performs no preference/expiry mutation. The whole
 -- source component is already locked, serializing the retention producer.
 SELECT mode INTO retention_mode FROM guest_learning_preferences WHERE owner_id=p_source FOR UPDATE;
 IF NOT FOUND THEN retention_mode:='private_learning'; END IF;
 IF retention_mode IS NULL OR retention_mode NOT IN('private_learning','ephemeral') THEN
  RAISE EXCEPTION 'closed learning retention preference required' USING ERRCODE='GP006'; END IF;
 at_time:=clock_timestamp();artifact_expires:=CASE WHEN retention_mode='ephemeral'
  THEN at_time+INTERVAL '24 hours' ELSE at_time+INTERVAL '24 months' END;
 expected_ref:='learner-audio/study/'||original_attempt||'/'||(p_payload->>'audioDigest');
 INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)
  VALUES(p_operation_id,p_source,'study_answer',guest_study_answer_resource_scope_v1(sess.community_id,sess.session_id,item.session_item_id,
    (p_payload->>'attemptNumber')::INTEGER,'spoken'),p_operation->>'idempotencyKey',p_operation->>'requestHash','reserved',at_time);
 IF cmd.command_id IS NULL THEN
  INSERT INTO study_spoken_answer_commands(command_id,account_id,participation_owner_id,participation_owner_kind,session_id,session_item_id,
   attempt_number,idempotency_key,request_hash,audio_digest,audio_content_type,audio_byte_size,audio_duration_ms,attempt_id,
   learner_audio_artifact_id,lease_token,lease_expires_at,state,reserved_at)
  VALUES(original_cmd,NULL,p_source,'guest',sess.session_id,item.session_item_id,(p_payload->>'attemptNumber')::INTEGER,
   p_operation->>'idempotencyKey',p_operation->>'requestHash',p_payload->>'audioDigest',p_payload->>'audioContentType',
   (p_payload->>'audioByteSize')::INTEGER,(p_payload->>'audioDurationMs')::INTEGER,original_attempt,original_artifact,
   p_payload->>'leaseToken',at_time+INTERVAL '60 seconds','reserved',at_time);
  INSERT INTO learner_audio_artifacts(learner_audio_artifact_id,account_id,participation_owner_id,participation_owner_kind,
   source_kind,attempt_ref,expected_object_ref,object_ref,content_digest,content_type,byte_size,duration_ms,platform_retention,
   provider_retention,recording_state,expires_at,created_at)
  VALUES(original_artifact,NULL,p_source,'guest','study',original_attempt,expected_ref,NULL,p_payload->>'audioDigest',p_payload->>'audioContentType',
   (p_payload->>'audioByteSize')::INTEGER,(p_payload->>'audioDurationMs')::INTEGER,retention_mode,p_provider_retention,'pending',artifact_expires,at_time);
 ELSE
  UPDATE study_spoken_answer_commands SET idempotency_key=p_operation->>'idempotencyKey',request_hash=p_operation->>'requestHash',
   audio_digest=p_payload->>'audioDigest',audio_content_type=p_payload->>'audioContentType',audio_byte_size=(p_payload->>'audioByteSize')::INTEGER,
   audio_duration_ms=(p_payload->>'audioDurationMs')::INTEGER,lease_token=p_payload->>'leaseToken',lease_expires_at=at_time+INTERVAL '60 seconds',
   state='reserved',provider_failure_kind=NULL,result_snapshot=NULL,completed_at=NULL,reserved_at=at_time WHERE command_id=original_cmd;
  UPDATE learner_audio_artifacts SET expected_object_ref=expected_ref,object_ref=NULL,content_digest=p_payload->>'audioDigest',
   content_type=p_payload->>'audioContentType',byte_size=(p_payload->>'audioByteSize')::INTEGER,duration_ms=(p_payload->>'audioDurationMs')::INTEGER,
   recording_state='pending',platform_retention=retention_mode,expires_at=artifact_expires WHERE learner_audio_artifact_id=original_artifact;
 END IF;
 provider:=reserve_guest_provider_call_v1(p_source,p_operation,sess.session_id,p_reservation,1,
  p_policy->>'maximumProviderCallCostMicros',p_policy->>'costPolicyVersion');
 IF provider#>>'{result,state}' IS DISTINCT FROM 'reserved' THEN
  RAISE EXCEPTION 'first fresh provider reservation required' USING ERRCODE='GP006'; END IF;
 PERFORM register_learner_audio_upload_private_v1(p_source,original_artifact,'study',original_attempt,original_cmd,p_reservation,expected_ref,p_upload_id,p_fence);
 captured:=capture_guest_spoken_dispatch_private_v1(p_source,p_operation,original_cmd,p_payload->>'leaseToken',
  provider#>>'{result,callId}',p_reservation,p_upload_id,p_fence,p_rerecord_enabled);
 IF captured->'fresh' IS DISTINCT FROM 'true'::JSONB THEN
  RAISE EXCEPTION 'first fresh captured dispatch required' USING ERRCODE='GP006'; END IF;
 RETURN jsonb_build_object('state','reserved','commandId',original_cmd,'leaseToken',p_payload->>'leaseToken',
  'attemptId',original_attempt,'artifactId',original_artifact,'resourceReservationId',p_reservation,'deletionFenceRevision',p_fence);
END $$;

-- Post-dispatch failure uses ONLY the accepted original capture/op/internal
-- lease. Current browser authority/expiry cannot turn known failure into unknown.
-- A provider timeout remains unknown. Caller disposition comes from the trusted
-- invoked provider adapter, never browser/body or a transport timeout inference.
CREATE FUNCTION fail_guest_spoken_answer_v1(p_source TEXT,p_operation JSONB,p_command TEXT,p_original_lease TEXT,
 p_reservation TEXT,p_disposition TEXT,p_failure TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cap guest_study_spoken_captures%ROWTYPE; rsv guest_resource_session_reservations%ROWTYPE;
 call_row guest_resource_provider_calls%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE; main_op guest_participation_operations%ROWTYPE;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE source_owner_id=p_source AND command_id=p_command
  AND original_lease_digest=encode(sha256(convert_to(p_original_lease,'UTF8')),'hex');
 IF ROW(cap.idempotency_key,cap.request_hash,cap.original_lease_token,cap.resource_reservation_id)
  IS DISTINCT FROM ROW(p_operation->>'idempotencyKey',p_operation->>'requestHash',p_original_lease,p_reservation) THEN
  RAISE EXCEPTION 'original failure identity changed' USING ERRCODE='GP005'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=cap.resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[p_source]);
 SELECT * INTO STRICT main_op FROM guest_participation_operations WHERE operation_id=cap.operation_id FOR UPDATE;
 SELECT * INTO STRICT call_row FROM guest_resource_provider_calls WHERE call_id=cap.provider_call_id FOR UPDATE;
 IF main_op.state='completed' OR EXISTS(SELECT 1 FROM guest_study_spoken_checkpoints WHERE capture_id=cap.capture_id)
  OR call_row.disposition='completed' THEN RAISE EXCEPTION 'successful command cannot fail' USING ERRCODE='GP005'; END IF;
 IF p_disposition IS NULL OR p_disposition NOT IN('not_invoked','failed','unknown')
  OR p_failure IS NULL OR p_failure NOT IN('invalid-response','misconfigured','rate-limited','timeout','unavailable') THEN
  RAISE EXCEPTION 'trusted closed failure disposition required' USING ERRCODE='GP003'; END IF;
 PERFORM complete_guest_provider_call_v1(p_source,p_operation,p_reservation,cap.provider_call_id,p_disposition);
 IF p_disposition='unknown' THEN RETURN jsonb_build_object('state','reserved','operationId',main_op.operation_id,'result',NULL); END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=cap.upload_attempt_id FOR UPDATE;
 -- Before accepted provider success this exact registered generation has never
 -- entered archive dispatch. A writing/unknown generation must not be inferred
 -- absent; leave it retained and block later command reclamation.
 IF upload.io_state='registered' THEN
  PERFORM settle_learner_audio_upload_private_v1(upload.upload_attempt_id,'absent',TRUE,NULL); END IF;
 UPDATE study_spoken_answer_commands SET state='retryable_failed',provider_failure_kind=p_failure,completed_at=clock_timestamp()
  WHERE command_id=p_command AND participation_owner_id=p_source AND lease_token=p_original_lease AND state='reserved';
 -- An old retained failure replay after a newer deliberate generation neither
 -- fails its command nor rewrites the newer artifact metadata.
 IF FOUND THEN UPDATE learner_audio_artifacts SET recording_state='failed'
  WHERE learner_audio_artifact_id=cap.artifact_id AND participation_owner_id=p_source AND recording_state='pending'; END IF;
 IF main_op.state='reserved' THEN UPDATE guest_participation_operations SET state='known_aborted',resolved_at=clock_timestamp()
  WHERE operation_id=main_op.operation_id; END IF;
 RETURN jsonb_build_object('state','known_aborted','operationId',main_op.operation_id,'result',NULL);
END $$;

-- Private accepted-checkpoint finalization. No proof/config/current-visibility/
-- one-hour or command-expiry check after accepted provider work. No provider,
-- regrading or invoice call. Caller owns ONE transaction through completion.
CREATE FUNCTION prepare_guest_spoken_finalization_v1(p_source TEXT,p_operation JSONB,p_checkpoint TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cp guest_study_spoken_checkpoints%ROWTYPE; cap guest_study_spoken_captures%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE; call_row guest_resource_provider_calls%ROWTYPE;
 main_op guest_participation_operations%ROWTYPE; cmd study_spoken_answer_commands%ROWTYPE;
 sess study_sessions_v2%ROWTYPE; item study_session_items_v2%ROWTYPE; state study_lesson_item_state_v2%ROWTYPE;
 review study_review_items%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE; artifact learner_audio_artifacts%ROWTYPE;
 fence learner_audio_owner_fences%ROWTYPE; prior_rerecord BOOLEAN; archive JSONB; total INTEGER; remaining INTEGER;
BEGIN
 PERFORM require_guest_study_composition_v1();
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO cp FROM guest_study_spoken_checkpoints WHERE checkpoint_id=p_checkpoint AND source_owner_id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'accepted successful checkpoint unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE capture_id=cp.capture_id;
 IF ROW(cap.source_owner_id,cap.idempotency_key,cap.request_hash,cp.provider_call_id,cp.resource_reservation_id)
  IS DISTINCT FROM ROW(p_source,p_operation->>'idempotencyKey',p_operation->>'requestHash',cap.provider_call_id,cap.resource_reservation_id) THEN
  RAISE EXCEPTION 'original checkpoint identity changed' USING ERRCODE='GP005'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=cap.resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[p_source]);
 main_op:=require_guest_answer_operation_private_v1(p_source,p_operation,cap.operation_id,
  cap.grading_context->>'communityId',cap.session_id,cap.session_item_id,cap.attempt_number,'spoken');
 SELECT * INTO STRICT cmd FROM study_spoken_answer_commands WHERE command_id=cap.command_id FOR UPDATE;
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=cap.session_id FOR UPDATE;
 SELECT * INTO STRICT call_row FROM guest_resource_provider_calls WHERE call_id=cap.provider_call_id FOR UPDATE;
 IF ROW(cmd.participation_owner_id,cmd.participation_owner_kind,cmd.account_id,cmd.session_id,cmd.session_item_id,
    cmd.attempt_number,cmd.attempt_id,cmd.learner_audio_artifact_id,cmd.idempotency_key,cmd.request_hash,cmd.lease_token)
  IS DISTINCT FROM ROW(p_source,'guest'::TEXT,NULL::TEXT,cap.session_id,cap.session_item_id,
    cap.attempt_number::BIGINT,cap.attempt_id,cap.artifact_id,cap.idempotency_key,cap.request_hash,cap.original_lease_token)
  OR ROW(sess.participation_owner_id,sess.participation_owner_kind,sess.guest_resource_reservation_id,sess.community_id)
    IS DISTINCT FROM ROW(p_source,'guest'::TEXT,cap.resource_reservation_id,cap.grading_context->>'communityId')
  OR ROW(call_row.source_owner_id,call_row.reservation_id,call_row.session_id,call_row.disposition,call_row.checkpoint_id)
    IS DISTINCT FROM ROW(p_source,cap.resource_reservation_id,cap.session_id,'completed'::TEXT,cp.checkpoint_id)
  OR cp.charged_cost_micros IS DISTINCT FROM call_row.actual_cost_micros
  OR cp.charged_cost_micros IS DISTINCT FROM call_row.maximum_provider_cost_micros
  OR cp.charge_basis IS DISTINCT FROM 'reserved_ceiling_v1' THEN
  RAISE EXCEPTION 'retained command/source/lease/call correlation changed' USING ERRCODE='GP005'; END IF;
 IF main_op.state='completed' THEN
  IF cmd.state IS DISTINCT FROM 'completed' OR cmd.result_snapshot IS DISTINCT FROM main_op.result_snapshot THEN
   RAISE EXCEPTION 'immutable completion receipts disagree' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state','completed','operationId',main_op.operation_id,'result',main_op.result_snapshot); END IF;
 IF main_op.state IS DISTINCT FROM 'reserved' OR cmd.state IS DISTINCT FROM 'reserved'
  OR sess.status IS DISTINCT FROM 'active' OR sess.current_session_item_id IS DISTINCT FROM cap.session_item_id
  OR sess.guest_reward_mode IS DISTINCT FROM 'practice_only' OR sess.guest_reward_terms IS NOT NULL THEN
  RAISE EXCEPTION 'accepted lesson finalization state unavailable' USING ERRCODE='GP003'; END IF;
 SELECT * INTO STRICT item FROM study_session_items_v2 WHERE session_item_id=cap.session_item_id
  AND session_id=cap.session_id AND participation_owner_id=p_source FOR UPDATE;
 SELECT * INTO STRICT state FROM study_lesson_item_state_v2 WHERE session_item_id=cap.session_item_id AND session_id=cap.session_id FOR UPDATE;
 SELECT * INTO STRICT review FROM study_review_items WHERE review_item_id=item.review_item_id AND participation_owner_id=p_source FOR UPDATE;
 IF item.item_snapshot IS DISTINCT FROM cap.grading_context->'item' OR item.maximum_attempts IS DISTINCT FROM 3
  OR state.lesson_resolved IS DISTINCT FROM FALSE OR state.presentation_count+1<>cap.attempt_number THEN
  RAISE EXCEPTION 'captured lesson item changed' USING ERRCODE='GP003'; END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=cap.upload_attempt_id FOR UPDATE;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=cap.artifact_id FOR UPDATE;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=p_source FOR UPDATE;
 IF ROW(upload.owner_id,upload.artifact_id,upload.source_kind,upload.attempt_ref,upload.command_ref,upload.reservation_ref,upload.captured_revision)
  IS DISTINCT FROM ROW(p_source,cap.artifact_id,'study'::TEXT,cap.attempt_id,cap.command_id,cap.resource_reservation_id,cap.deletion_fence_revision)
  OR ROW(artifact.participation_owner_id,artifact.source_kind,artifact.attempt_ref,artifact.content_digest,artifact.content_type,artifact.byte_size,artifact.duration_ms)
    IS DISTINCT FROM ROW(p_source,'study'::TEXT,cap.attempt_id,cap.audio_digest,cap.audio_content_type,cap.audio_byte_size::BIGINT,cap.audio_duration_ms::BIGINT)
  OR upload.object_ref IS DISTINCT FROM artifact.expected_object_ref THEN
  RAISE EXCEPTION 'retained upload/artifact source changed' USING ERRCODE='GP005'; END IF;
 IF upload.io_state IS DISTINCT FROM 'closed' THEN
  RETURN jsonb_build_object('state','reserved','operationId',main_op.operation_id,'result',NULL); END IF;
 -- Actual durable253 storage disposition, never caller result.archive. A
 -- later delete may invalidate publication without erasing successful learning.
 archive:=CASE WHEN upload.storage_disposition='stored' AND NOT upload.cleanup_required
   AND fence.revision=cap.deletion_fence_revision AND fence.active_delete_command_id IS NULL
   AND artifact.recording_state<>'deleted'
   AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects WHERE object_ref=upload.object_ref)
  THEN jsonb_build_object('state','stored','objectRef',upload.object_ref)
  ELSE jsonb_build_object('state','failed','objectRef',NULL) END;
 SELECT EXISTS(SELECT 1 FROM study_spoken_answer_commands prior WHERE prior.session_id=cap.session_id
  AND prior.session_item_id=cap.session_item_id AND prior.attempt_number=cap.attempt_number
  AND prior.participation_owner_id=p_source AND prior.result_kind='rerecord' AND prior.state='completed') INTO prior_rerecord;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE NOT lesson_resolved)::INTEGER INTO total,remaining
  FROM study_lesson_item_state_v2 WHERE session_id=cap.session_id;
 RETURN jsonb_build_object('state','candidate','checkpointId',cp.checkpoint_id,'captureId',cap.capture_id,'operationId',cap.operation_id,
  'sourceOwnerId',p_source,'result',cp.success_result,'item',item.item_snapshot,'reviewItemId',item.review_item_id,
  'review',jsonb_build_object('difficulty',review.difficulty,'lapses',review.lapses,'repetitions',review.repetitions,'stability',review.stability),
  'priorRerecordRecorded',prior_rerecord,'priorPresentationCount',sess.presentation_count,'currentPresentedAt',sess.current_presented_at,
  'totalCards',total,'remainingCards',remaining,'archive',archive,'resourceReservationId',cap.resource_reservation_id);
END $$;

CREATE FUNCTION apply_guest_spoken_item_mutation_v1(p_source TEXT,p_operation JSONB,p_checkpoint TEXT,
 p_capture JSONB,p_decision JSONB,p_feedback JSONB,p_token_diff JSONB,p_spoken JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE checked JSONB; result JSONB; item JSONB; source_id TEXT; sid TEXT; iid TEXT; attempt INTEGER;
 accepted TIMESTAMPTZ; correct BOOLEAN; rerecord BOOLEAN; actual_rerecord BOOLEAN; schedule JSONB; remaining INTEGER; total INTEGER;
BEGIN
 checked:=prepare_guest_spoken_finalization_v1(p_source,p_operation,p_checkpoint);
 IF checked->>'state'<>'candidate' THEN RETURN checked; END IF;
 IF checked IS DISTINCT FROM p_capture THEN RAISE EXCEPTION 'locked finalization facts changed' USING ERRCODE='GP003'; END IF;
 result:=checked->'result';item:=checked->'item';source_id:=checked->>'sourceOwnerId';sid:=result->>'sessionId';iid:=result->>'sessionItemId';
 attempt:=(result->>'attemptNumber')::INTEGER;accepted:=(result->>'acceptedAt')::TIMESTAMPTZ;
 correct:=(result#>>'{grade,correct}')::BOOLEAN;
 actual_rerecord:=result->'rerecordEnabled'='true'::JSONB AND correct IS FALSE
  AND COALESCE(result#>>'{rerecordAssessment,candidateReason}' IN('language_mismatch','low_voice_overlap','single_insertion'),FALSE)
  AND (checked->>'priorRerecordRecorded')::BOOLEAN IS FALSE;
 rerecord:=p_decision->>'kind'='ungraded_rerecord';
 IF p_decision IS NULL OR jsonb_typeof(p_decision) IS DISTINCT FROM 'object'
  OR correct IS NULL OR rerecord IS DISTINCT FROM actual_rerecord
  OR p_decision->>'kind' IS DISTINCT FROM (CASE WHEN actual_rerecord THEN 'ungraded_rerecord' ELSE 'graded' END)
  OR p_decision->>'outcome' IS DISTINCT FROM (CASE WHEN actual_rerecord THEN 'ungraded_rerecord' WHEN correct THEN 'correct' ELSE 'incorrect' END)
  OR p_decision->>'attemptState' IS DISTINCT FROM (CASE WHEN actual_rerecord THEN 'retryable' ELSE 'spent' END)
  OR (p_decision->>'firstPass')::BOOLEAN IS DISTINCT FROM (attempt=1)
  OR (p_decision->>'resolved')::BOOLEAN IS DISTINCT FROM (NOT actual_rerecord AND (correct OR attempt>=3))
  OR p_feedback->>'kind' IS DISTINCT FROM 'transcript_diff'
  OR p_feedback->>'heard_transcript' IS DISTINCT FROM result#>>'{grade,heardTranscript}'
  OR p_feedback->>'policy_revision' IS DISTINCT FROM result#>>'{grade,policyRevision}'
  OR p_spoken->'language_provenance' IS DISTINCT FROM result->'languageProvenance'
  OR p_spoken#>>'{rerecord_decision,kind}' IS DISTINCT FROM (CASE WHEN actual_rerecord THEN 'ungraded_rerecord' ELSE 'graded' END)
  OR p_spoken#>'{rerecord_decision,enabled}' IS DISTINCT FROM result->'rerecordEnabled'
  OR p_spoken#>'{rerecord_decision,reason}' IS DISTINCT FROM (CASE WHEN actual_rerecord
     THEN result#>'{rerecordAssessment,candidateReason}' ELSE 'null'::JSONB END) THEN
  RAISE EXCEPTION 'shared accepted spoken decision changed' USING ERRCODE='GP003'; END IF;
 IF (rerecord AND p_decision->'review' IS DISTINCT FROM 'null'::JSONB) THEN
  RAISE EXCEPTION 'rerecord cannot reschedule review' USING ERRCODE='GP003'; END IF;
 -- Publication is conditional on actual retained ledger/current fence. A deleted
 -- artifact remains deleted; no success/refinalization can resurrect it.
 UPDATE learner_audio_artifacts SET recording_state=checked#>>'{archive,state}',object_ref=checked#>>'{archive,objectRef}'
  WHERE learner_audio_artifact_id=result->>'artifactId' AND participation_owner_id=p_source AND recording_state='pending';
 IF NOT rerecord THEN
  schedule:=p_decision->'review';PERFORM require_guest_review_schedule_private_v1(schedule,accepted);
  INSERT INTO study_attempts_v2(attempt_id,session_item_id,attempt_number,submission_kind,submission_evidence,outcome,first_pass,
   attempt_state,feedback_kind,feedback_evidence,grader_policy_revision,feedback_policy_revision,accepted_at,idempotency_key,request_hash,
   study_unit_id,exercise_kind,learning_language,target_language,learner_band,source_line_revision,language_profile_revision,localization_revision,
   grading_revision,review_schedule_version,presented_at,answered_at,audio_byte_size,audio_duration_ms,provider_detected_language,
   provider_detected_language_confidence,token_diff,learner_audio_artifact_id)
  VALUES(result->>'attemptId',iid,attempt,'raw_audio',jsonb_build_object('audio_digest',result->'audioDigest','learner_audio_artifact_id',result->'artifactId'),
   CASE WHEN correct THEN 'correct' ELSE 'incorrect' END,attempt=1,'spent','transcript_diff',p_feedback,item->>'grader_policy_revision',
   item->>'feedback_policy_revision',accepted,result->>'commandId',result->>'requestHash',item#>>'{line,study_unit_id}','say_it_back',
   item#>>'{languages,learning_language}',NULL,NULL,(item#>>'{line,line_version}')::BIGINT,(item->>'language_profile_revision')::BIGINT,NULL,
   item->>'grader_policy_revision','study_review_schedule_v1',(checked->>'currentPresentedAt')::TIMESTAMPTZ,accepted,
   (result->>'audioByteSize')::INTEGER,(result->>'audioDurationMs')::INTEGER,result->>'providerDetectedLanguage',
   (result->>'providerDetectedLanguageConfidence')::NUMERIC,p_token_diff,result->>'artifactId');
  INSERT INTO study_presentations_v2(presentation_id,session_id,session_item_id,presentation_number,queue_ordinal,presented_at,answered_at,outcome)
  VALUES('study-presentation-'||(result->>'attemptId'),sid,iid,attempt,(checked->>'priorPresentationCount')::BIGINT,
   (checked->>'currentPresentedAt')::TIMESTAMPTZ,accepted,CASE WHEN correct THEN 'correct' ELSE 'incorrect' END);
  UPDATE study_review_items SET difficulty=(schedule->>'difficulty')::NUMERIC,due_at=(schedule->>'dueAt')::TIMESTAMPTZ,
   lapses=(schedule->>'lapses')::BIGINT,repetitions=(schedule->>'repetitions')::BIGINT,stability=(schedule->>'stability')::NUMERIC,
   review_state=schedule->>'state',last_reviewed_at=accepted,updated_at=accepted,
   scheduler_state=jsonb_build_object('difficulty',schedule->'difficulty','due_at',schedule->'dueAt','lapses',schedule->'lapses',
    'repetitions',schedule->'repetitions','stability',schedule->'stability','state',schedule->'state')
   WHERE review_item_id=checked->>'reviewItemId' AND participation_owner_id=p_source;
  IF NOT FOUND THEN RAISE EXCEPTION 'review source changed' USING ERRCODE='GP003'; END IF;
  UPDATE study_lesson_item_state_v2 SET presentation_count=attempt,last_queue_ordinal=(checked->>'priorPresentationCount')::BIGINT,
   mastered=correct,lesson_resolved=(p_decision->>'resolved')::BOOLEAN,updated_at=accepted
   WHERE session_item_id=iid AND session_id=sid AND presentation_count=attempt-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'presentation source changed' USING ERRCODE='GP003'; END IF;
 END IF;
 SELECT count(*)::INTEGER,count(*) FILTER(WHERE NOT lesson_resolved)::INTEGER INTO total,remaining FROM study_lesson_item_state_v2 WHERE session_id=sid;
 RETURN jsonb_build_object('state','mutated','operationId',checked->'operationId','capture',checked,'decision',p_decision,
  'feedback',p_feedback,'spoken',p_spoken,'totalCards',total,'remainingCards',remaining,'priorPresentationCount',checked->'priorPresentationCount');
END $$;

CREATE FUNCTION transition_guest_spoken_answer_v1(p_source TEXT,p_operation JSONB,p_checkpoint TEXT,
 p_capture JSONB,p_decision JSONB,p_transition JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE main_op guest_participation_operations%ROWTYPE; cp guest_study_spoken_checkpoints%ROWTYPE;
 cap guest_study_spoken_captures%ROWTYPE; result JSONB; sess study_sessions_v2%ROWTYPE;
BEGIN
 SELECT * INTO STRICT cp FROM guest_study_spoken_checkpoints WHERE checkpoint_id=p_checkpoint AND source_owner_id=p_source;
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE capture_id=cp.capture_id;
 result:=cp.success_result;
 main_op:=require_guest_answer_operation_private_v1(p_source,p_operation,cap.operation_id,
  cap.grading_context->>'communityId',cap.session_id,cap.session_item_id,cap.attempt_number,'spoken');
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=cap.session_id FOR UPDATE;
 IF main_op.state IS DISTINCT FROM 'reserved' OR p_capture->>'captureId' IS DISTINCT FROM cap.capture_id
  OR p_capture->'result' IS DISTINCT FROM result OR p_capture->>'operationId' IS DISTINCT FROM main_op.operation_id THEN
  RAISE EXCEPTION 'original continuation capture changed' USING ERRCODE='GP005'; END IF;
 IF p_decision->>'kind'='ungraded_rerecord' THEN
  IF p_transition->>'kind' IS DISTINCT FROM 'unchanged'
   OR (p_transition->>'nextPresentationCount')::INTEGER IS DISTINCT FROM sess.presentation_count::INTEGER
   OR (p_capture->>'priorPresentationCount')::INTEGER IS DISTINCT FROM sess.presentation_count::INTEGER
   OR EXISTS(SELECT 1 FROM study_attempts_v2 WHERE attempt_id=cap.attempt_id)
   OR EXISTS(SELECT 1 FROM study_presentations_v2 WHERE presentation_id='study-presentation-'||cap.attempt_id) THEN
   RAISE EXCEPTION 'rerecord cannot spend a lesson presentation' USING ERRCODE='GP003'; END IF;
  RETURN;
 END IF;
 IF p_decision->>'kind' IS DISTINCT FROM 'graded' OR p_transition->>'kind'='keep_current'
  OR NOT EXISTS(SELECT 1 FROM study_attempts_v2 WHERE attempt_id=cap.attempt_id AND session_item_id=cap.session_item_id
    AND attempt_number=cap.attempt_number AND submission_kind='raw_audio' AND attempt_state='spent'
    AND idempotency_key=cap.command_id AND request_hash=cap.request_hash AND learner_audio_artifact_id=cap.artifact_id) THEN
  RAISE EXCEPTION 'actual graded receipt missing' USING ERRCODE='GP003'; END IF;
 PERFORM apply_guest_lesson_transition_private_v1(p_source,cap.session_id,(p_capture->>'priorPresentationCount')::INTEGER,
  p_transition->>'kind',(p_transition->>'nextPresentationCount')::INTEGER,p_transition->>'completionReason',(result->>'acceptedAt')::TIMESTAMPTZ);
END $$;

CREATE FUNCTION finish_guest_spoken_answer_v1(p_source TEXT,p_operation JSONB,p_checkpoint TEXT,
 p_capture JSONB,p_decision JSONB,p_feedback JSONB,p_spoken JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cp guest_study_spoken_checkpoints%ROWTYPE; cap guest_study_spoken_captures%ROWTYPE;
 main_op guest_participation_operations%ROWTYPE; cmd study_spoken_answer_commands%ROWTYPE; owned JSONB; result JSONB;
BEGIN
 SELECT * INTO STRICT cp FROM guest_study_spoken_checkpoints WHERE checkpoint_id=p_checkpoint AND source_owner_id=p_source;
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE capture_id=cp.capture_id;
 main_op:=require_guest_answer_operation_private_v1(p_source,p_operation,cap.operation_id,
  cap.grading_context->>'communityId',cap.session_id,cap.session_item_id,cap.attempt_number,'spoken');
 IF main_op.state='completed' THEN RETURN jsonb_build_object('state','completed','operationId',main_op.operation_id,'result',main_op.result_snapshot); END IF;
 SELECT * INTO STRICT cmd FROM study_spoken_answer_commands WHERE command_id=cap.command_id FOR UPDATE;
 IF main_op.state IS DISTINCT FROM 'reserved' OR cmd.state IS DISTINCT FROM 'reserved'
  OR cmd.lease_token IS DISTINCT FROM cap.original_lease_token OR p_capture->'result' IS DISTINCT FROM cp.success_result
  OR p_capture->>'captureId' IS DISTINCT FROM cap.capture_id OR p_capture->>'operationId' IS DISTINCT FROM main_op.operation_id
  OR (p_decision->>'kind'='graded' AND NOT EXISTS(SELECT 1 FROM study_attempts_v2 WHERE attempt_id=cap.attempt_id))
  OR p_decision->>'kind' IS NULL OR p_decision->>'kind' NOT IN('graded','ungraded_rerecord') THEN
  RAISE EXCEPTION 'accepted actual completion receipts unavailable' USING ERRCODE='GP003'; END IF;
 IF NOT EXISTS(SELECT 1 FROM study_sessions_v2 s JOIN study_lesson_item_state_v2 state
  ON state.session_id=s.session_id AND state.session_item_id=cap.session_item_id
  WHERE s.session_id=cap.session_id AND s.participation_owner_id=p_source
   AND ((p_decision->>'kind'='graded' AND state.presentation_count=cap.attempt_number
     AND s.presentation_count=(p_capture->>'priorPresentationCount')::BIGINT+1)
    OR (p_decision->>'kind'='ungraded_rerecord' AND state.presentation_count=cap.attempt_number-1
     AND s.presentation_count=(p_capture->>'priorPresentationCount')::BIGINT
     AND s.current_session_item_id=cap.session_item_id AND NOT state.lesson_resolved))) THEN
  RAISE EXCEPTION 'shared lesson continuation receipt missing' USING ERRCODE='GP003'; END IF;
 owned:=project_owner_study_session_private_v1(p_source,cap.grading_context->>'communityId',cap.session_id);
 result:=jsonb_build_object('source',owned->'source','answer',jsonb_build_object('object','guest_study_answer_result_v1',
  'session_item_id',cap.session_item_id,'attempt_number',cap.attempt_number,'exercise_type','say_it_back',
  'outcome',p_decision->'outcome','first_pass',p_decision->'firstPass','attempt_state',p_decision->'attemptState',
  'feedback',p_feedback,'spoken',p_spoken,'session',owned->'session','participation',jsonb_build_object('state','practice_only')),
  'participation',jsonb_build_object('state','practice_only'));
 IF owned#>>'{session,status}'='completed' THEN
  PERFORM release_guest_resource_session_v1(p_source,p_operation,cap.session_id,cap.resource_reservation_id,'completed'); END IF;
 UPDATE study_spoken_answer_commands SET state='completed',result_kind=CASE WHEN p_decision->>'kind'='ungraded_rerecord' THEN 'rerecord' ELSE 'graded' END,
  result_snapshot=result,completed_at=(cp.success_result->>'acceptedAt')::TIMESTAMPTZ
  WHERE command_id=cap.command_id AND participation_owner_id=p_source AND lease_token=cap.original_lease_token AND state='reserved';
 IF NOT FOUND THEN RAISE EXCEPTION 'original command completion changed' USING ERRCODE='GP005'; END IF;
 UPDATE guest_participation_operations SET state='completed',result_snapshot=result,resolved_at=clock_timestamp()
  WHERE operation_id=main_op.operation_id AND state='reserved';
 RETURN jsonb_build_object('state','completed','operationId',main_op.operation_id,'result',result);
END $$;

-- Run LAST after all body/approved source/checkpoint/resource definitions exist
-- in the root-owned one atomic migration transaction. NO serving-role grants.
DO $bind_owner_study_mutations$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT; expected_owner OID;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT trusted_schema,expected_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
  RAISE EXCEPTION 'trusted owner mutation schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'require_guest_review_schedule_private_v1(jsonb,timestamptz)',
  'require_guest_answer_operation_private_v1(text,jsonb,text,text,text,text,integer,text)',
  'project_owner_study_session_private_v1(text,text,text)',
  'prepare_guest_json_answer_v1(jsonb,jsonb,text,text,text,integer,jsonb)',
  'apply_guest_json_item_mutation_v1(jsonb,jsonb,jsonb,jsonb,text,text)',
  'apply_guest_lesson_transition_private_v1(text,text,integer,text,integer,text,timestamptz)',
  'transition_guest_json_answer_v1(jsonb,text,jsonb,jsonb,jsonb)',
  'finish_guest_json_answer_v1(jsonb,text,jsonb,jsonb)',
  'read_guest_spoken_context_v1(jsonb,text,text,text,text)',
  'reserve_guest_spoken_answer_v1(jsonb,jsonb,text,jsonb,text,bigint,jsonb,text,boolean,text,text,text)',
  'fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)',
  'prepare_guest_spoken_finalization_v1(text,jsonb,text)',
  'apply_guest_spoken_item_mutation_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb)',
  'transition_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb)',
  'finish_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb)',
  'require_owner_guest_source_private_v1(jsonb)',
  'persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)',
  'read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)',
  'read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)',
  'acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
    WHERE f.oid=signature::regprocedure AND f.proowner=expected_owner AND n.nspname=trusted_schema) THEN
   RAISE EXCEPTION 'approved mutation routine owner required'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
 -- Existing core capture/persist/load/audio/plan primitives retain their own
 -- exact independent private bindings. This packet grants none of them.
END $bind_owner_study_mutations$;
