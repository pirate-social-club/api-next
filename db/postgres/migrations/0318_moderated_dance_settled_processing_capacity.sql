-- Retire expired pre-review processing through normal maintenance after all custody is settled.
CREATE OR REPLACE FUNCTION record_moderated_dance_maintenance_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease_ms BIGINT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'maintenance purposes unavailable' USING ERRCODE='DRV02'; END IF;
 -- Expired pre-review work cannot dispatch again. Retire its capacity debt
 -- only after every owned fence and registered provider effect is complete.
 -- This sweep also covers sessions terminal before this migration; it never
 -- edits captured terms, deadlines, grants, usage or provider-purpose history.
 UPDATE dance_moderated_processing_v1 processing SET state='failed',completed_at=now_at,observation_until=NULL
 FROM dance_moderated_uploads_v1 upload JOIN dance_moderated_sessions_v1 session USING(session_id)
 WHERE processing.upload_id=upload.upload_id AND session.state='terminal' AND session.expires_at<=now_at
 AND processing.state IN('claimed','unknown') AND processing.completed_at IS NULL
 AND processing.provider_deadline<=now_at AND (processing.observation_until IS NULL OR processing.observation_until<=now_at)
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 review WHERE review.session_id=session.session_id)
 AND (SELECT count(*) FROM dance_moderated_media_dispositions_v1 disposition WHERE disposition.upload_id=upload.upload_id
  AND disposition.kind IN('ingress','original','derived') AND disposition.state='completed')=3
 -- No inner claim means no provider dispatch was authorized. A legacy row
 -- with a consumed inner claim still needs registered, completed custody.
 AND (EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect WHERE effect.upload_id=upload.upload_id AND effect.state='completed')
  OR processing.probe_phase='unclaimed' AND processing.probe_attempt IS NULL
   AND processing.normalization_claimed_at IS NULL AND processing.provider_job_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect WHERE effect.upload_id=upload.upload_id AND effect.state<>'completed');
 IF EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect
  LEFT JOIN dance_moderated_processing_v1 processing ON processing.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_uploads_v1 upload ON upload.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_reviews_v1 review ON review.session_id=upload.session_id
  WHERE effect.state<>'completed' AND CASE WHEN processing.state='held' OR review.status='held' THEN effect.hold_dispose_by ELSE effect.dispose_by END<=now_at) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1;
  DELETE FROM dance_moderated_processor_readiness_v1;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 WHERE normalized_digest IS NOT NULL AND replay_retired_at IS NULL AND replay_expires_at<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d WHERE d.state IN('pending','running','unknown') AND d.dispose_by<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d JOIN dance_moderated_uploads_v1 u USING(upload_id)
 JOIN dance_moderated_reviews_v1 r USING(session_id) JOIN dance_moderated_review_intents_v1 i USING(review_id)
 WHERE d.state='held' AND i.status<>'completed' AND i.deadline_at<=now_at AND
  (i.kind='hold_review' OR i.kind='cleanup_review' AND d.kind IN('ingress','original') OR i.kind='cleanup_temporary' AND d.kind='derived')) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_publication_inputs_v1 WHERE state='cleanup' OR state IN('preparing','stored') AND deadline_at<=now_at) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN;
 END IF;
 SELECT min((p.operational_profile->>'readinessLeaseMs')::BIGINT) INTO lease_ms FROM dance_review_policy_versions_v1 p
 JOIN dance_review_policy_admissions_v1 a USING(policy_id) WHERE a.accepted AND now_at>=a.effective_at AND now_at<a.valid_until AND now_at>=p.valid_from AND now_at<p.valid_until;
 IF lease_ms IS NULL OR lease_ms<=0 THEN RETURN; END IF;
 INSERT INTO dance_moderated_maintenance_readiness_v1 VALUES(TRUE,now_at,now_at+lease_ms*interval '1 millisecond')
 ON CONFLICT(singleton) DO UPDATE SET observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until;
END $$;

-- Preserve existing owner and confined grants; restore the same trusted path.
DO $path$ DECLARE trusted TEXT:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION record_moderated_dance_maintenance_v1() SET search_path=%I,pg_catalog,pg_temp',trusted);
END $path$;
