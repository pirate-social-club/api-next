-- A fresh explicit command can recover the same published master after a
-- terminal preparation failure. Preserve every old command, receipt, consumed
-- purpose, deadline and provider disposition. Never turn uncertain work into
-- another provider grant; only a distinct attempt gets a fresh bounded budget.
DO $active_reference_constraint$
DECLARE existing RECORD; matches INTEGER:=0;
BEGIN
 FOR existing IN SELECT c.conname FROM pg_constraint c
 WHERE c.conrelid='dance_moderated_reference_commands_v1'::regclass AND c.contype='u'
 AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='community_id'),
  (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='reference_post_id'),
  (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='master_revision_id')]::SMALLINT[] LOOP
  EXECUTE format('ALTER TABLE dance_moderated_reference_commands_v1 DROP CONSTRAINT %I',existing.conname);
  matches:=matches+1;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION 'exact prior reference uniqueness required'; END IF;
END $active_reference_constraint$;
CREATE UNIQUE INDEX moderated_reference_active_master_v1
 ON dance_moderated_reference_commands_v1(community_id,reference_post_id,master_revision_id) WHERE state<>'failed';

-- A delayed successful provider result cannot resurrect the failed attempt,
-- including before its successor is allocated. Any earlier publication writes
-- roll back with this terminal-state fence in the same transaction.
CREATE FUNCTION guard_moderated_reference_failure_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='failed' AND NEW.state IS DISTINCT FROM OLD.state THEN
  RAISE EXCEPTION 'failed reference is terminal' USING ERRCODE='DRV05';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_reference_failure_terminal_v1 BEFORE UPDATE OF state ON dance_moderated_reference_commands_v1
 FOR EACH ROW EXECUTE FUNCTION guard_moderated_reference_failure_v1();

CREATE OR REPLACE FUNCTION create_moderated_dance_reference_v1(p_actor TEXT,p_command JSONB,p_hash TEXT,p_choreography TEXT,p_segment TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE prior dance_moderated_reference_commands_v1; replay dance_moderated_reference_receipts_v1; receipt JSONB; admission dance_review_policy_admissions_v1;
 policy dance_review_policy_versions_v1; reference RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_command->>'community_id',NULL,TRUE);
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('moderated-dance-reference-command-v1',p_actor,p_command->>'idempotency_key')::TEXT,0));
 SELECT * INTO replay FROM dance_moderated_reference_receipts_v1 WHERE account_id=p_actor AND idempotency_key=p_command->>'idempotency_key';
 IF replay.account_id IS NOT NULL THEN
  IF replay.request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'reference command conflict' USING ERRCODE='DRV03'; END IF;
  RETURN replay.receipt;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF NOT active_activity_persona(p_actor,p_command->>'persona_id',p_command->>'community_id') OR NOT can_account_access_activity_song(p_actor,p_command->>'community_id',p_command->>'song_post_id') THEN RAISE EXCEPTION 'reference unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT p.*,r.master_revision_id,plan.clip_start_samples,plan.clip_duration_samples INTO reference FROM posts p
 JOIN communities reference_community ON reference_community.community_id=p.community_id AND reference_community.status='active'
 JOIN media_video_song_references r ON r.post_id=p.post_id AND r.song_community_id=p_command->>'community_id' AND r.song_post_id=p_command->>'song_post_id'
 JOIN media_song_video_masters master ON master.master_revision_id=r.master_revision_id
 JOIN media_song_video_accepted_masters accepted ON accepted.master_revision_id=master.master_revision_id AND accepted.plan_id=master.plan_id
 JOIN media_song_video_render_plans plan ON plan.plan_id=master.plan_id AND plan.plan_id=r.plan_id AND plan.submission_id=r.submission_id AND plan.song_post_id=r.song_post_id AND plan.audio_revision=r.audio_revision
 JOIN media_publication_projections video ON video.community_id=p.community_id AND video.post_id=p.post_id AND video.media_kind='video' AND video.song_video_master_revision_id=master.master_revision_id AND video.canonical_video_sha256=master.master_sha256
 JOIN media_publication_projections song ON song.community_id=r.song_community_id AND song.post_id=r.song_post_id AND song.media_kind='song' AND song.audio_revision=r.audio_revision
 JOIN media_song_video_pcm_references pcm ON pcm.song_post_id=r.song_post_id AND pcm.audio_revision=r.audio_revision AND pcm.canonical_audio_sha256=song.canonical_audio_sha256 AND pcm.duration_samples=plan.song_duration_samples
 WHERE p.post_id=p_command->>'reference_post_id' AND p.author_user_id=p_actor
 AND plan.submission_id=video.submission_id AND r.submission_id=video.submission_id AND r.operation_id=video.operation_id
 AND EXISTS(SELECT 1 FROM video_detail_access_v1(p_actor,p.post_id) access WHERE access.non_age_allowed AND access.age_allowed) AND p.post_type='video' AND p.status='published' AND p.visibility='public'
 AND can_account_view_content_rating_v1(p_actor,p.content_rating) AND plan.clip_start_samples%48=0 AND plan.clip_duration_samples%48=0 AND plan.clip_duration_samples BETWEEN 288000 AND 1440000 FOR SHARE OF p,reference_community;
 IF reference.post_id IS NULL THEN RAISE EXCEPTION 'canonical playable reference unavailable' USING ERRCODE='DRV07'; END IF;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=p_command->>'community_id' FOR SHARE;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id FOR SHARE;
 now_at:=clock_timestamp();
 IF admission.accepted IS DISTINCT FROM TRUE OR now_at<admission.effective_at OR now_at>=admission.valid_until OR now_at<policy.valid_from OR now_at>=policy.valid_until THEN RAISE EXCEPTION 'reference policy unavailable' USING ERRCODE='DRV07'; END IF;
 -- The family lock above serializes new commands. Lock the selected row too:
 -- processing/cleanup must not change its terminal state beneath this decision.
 SELECT * INTO prior FROM dance_moderated_reference_commands_v1
 WHERE community_id=p_command->>'community_id' AND reference_post_id=reference.post_id
 AND master_revision_id=reference.master_revision_id AND state<>'failed' FOR UPDATE;
 IF prior.choreography_id IS NULL THEN
  -- A failed attempt is never reset. Unknown consumed provider work must first
  -- reach a bound disposal receipt, including when its effect row is missing.
  IF EXISTS(SELECT 1 FROM dance_moderated_reference_commands_v1 old
   LEFT JOIN dance_moderated_provider_effects_v1 effect ON effect.choreography_id=old.choreography_id AND effect.purpose='normalization'
   WHERE old.community_id=p_command->>'community_id' AND old.reference_post_id=reference.post_id
   AND old.master_revision_id=reference.master_revision_id AND old.state='failed'
   AND (effect.state IS NOT NULL AND effect.state<>'completed'
    OR old.normalization_claimed_at IS NOT NULL AND effect.state IS DISTINCT FROM 'completed')) THEN
   RAISE EXCEPTION 'prior reference provider cleanup pending' USING ERRCODE='DRV07';
  END IF;
  IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,FALSE,FALSE) THEN RAISE EXCEPTION 'reference work limit reached' USING ERRCODE='DRV07'; END IF;
  INSERT INTO dance_moderated_reference_commands_v1(account_id,idempotency_key,request_hash,community_id,song_post_id,persona_id,reference_community_id,reference_post_id,master_revision_id,choreography_id,segment_id,policy_id,state)
  VALUES(p_actor,p_command->>'idempotency_key',p_hash,p_command->>'community_id',p_command->>'song_post_id',p_command->>'persona_id',reference.community_id,reference.post_id,reference.master_revision_id,p_choreography,p_segment,policy.policy_id,'pending')
  RETURNING * INTO prior;
 END IF;
 receipt:=jsonb_build_object('version','dance-moderated-reference-v1','choreography_id',prior.choreography_id,'reference_post_id',prior.reference_post_id,'status',prior.state);
 INSERT INTO dance_moderated_reference_receipts_v1 VALUES(p_actor,p_command->>'idempotency_key',p_hash,prior.choreography_id,receipt);
 RETURN receipt;
END $$;

-- CREATE OR REPLACE preserves the confined grants and owner; bind its trusted
-- path explicitly as for the preceding reference migrations.
DO $acl$
DECLARE trusted TEXT:=current_schema();
BEGIN
 EXECUTE format('ALTER FUNCTION create_moderated_dance_reference_v1(text,jsonb,text,text,text) SET search_path=%I,pg_catalog,pg_temp',trusted);
 EXECUTE format('ALTER FUNCTION guard_moderated_reference_failure_v1() SET search_path=%I,pg_catalog,pg_temp',trusted);
 REVOKE ALL ON FUNCTION guard_moderated_reference_failure_v1() FROM PUBLIC;
END $acl$;
