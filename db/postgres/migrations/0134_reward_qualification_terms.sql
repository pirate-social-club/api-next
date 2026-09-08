-- Freeze qualification rules only for newly created legs. Existing commitments
-- keep NULL policy evidence and their original terms hashes and admission rules.
ALTER TABLE song_reward_offer_legs ADD COLUMN qualification_policies JSONB;
ALTER TABLE song_reward_offer_legs ADD CONSTRAINT song_reward_leg_qualification_shape
  CHECK (qualification_policies IS NULL OR
    (jsonb_typeof(qualification_policies) = 'array' AND jsonb_array_length(qualification_policies) BETWEEN 1 AND 2));

CREATE FUNCTION reward_current_qualification_policies(activities TEXT[]) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = cardinality(activities) THEN
    jsonb_agg(jsonb_build_object('activity', registry.activity_key, 'policy',
      policy.policy_document || jsonb_build_object('kind', policy.policy_kind,
        'qualification_policy_version_id', policy.qualification_policy_version_id))
      ORDER BY registry.activity_key)
    ELSE NULL END
  FROM activity_registry registry
  JOIN qualification_policy_versions policy
    ON policy.qualification_policy_version_id = registry.current_policy_version_id
   AND policy.activity_key = registry.activity_key
  WHERE registry.activity_key = ANY(activities) AND registry.status = 'active'
    AND registry.activity_key IN ('study', 'karaoke')
$$;

CREATE FUNCTION freeze_reward_leg_qualification_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE activities TEXT[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.qualification_policies IS DISTINCT FROM OLD.qualification_policies THEN
      RAISE EXCEPTION 'reward qualification terms are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.leg_terms_hash IS NULL OR NEW.leg_terms_hash !~ '^0x[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'reward base terms hash must be canonical';
  END IF;
  activities := CASE WHEN NEW.kind = 'megapot_pool' THEN NEW.eligible_activities
    ELSE ARRAY['study', 'karaoke']::TEXT[] END;
  PERFORM activity_key FROM activity_registry WHERE activity_key = ANY(activities)
    ORDER BY activity_key FOR SHARE;
  NEW.qualification_policies := reward_current_qualification_policies(activities);
  IF NEW.qualification_policies IS NULL THEN
    RAISE EXCEPTION 'reward qualification policy unavailable';
  END IF;
  NEW.leg_terms_hash := '0x' || encode(sha256(convert_to(
    jsonb_build_array('reward_qualification_terms_v1', NEW.leg_terms_hash,
      NEW.qualification_policies)::TEXT, 'UTF8')), 'hex');
  RETURN NEW;
END
$$;
CREATE TRIGGER aaa_song_reward_leg_qualification_terms
  BEFORE INSERT OR UPDATE ON song_reward_offer_legs
  FOR EACH ROW EXECUTE FUNCTION freeze_reward_leg_qualification_terms();

CREATE FUNCTION reward_leg_accepts_qualification(leg_id_input TEXT, activity_input TEXT, version_input TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT leg.qualification_policies IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(leg.qualification_policies) entry
    WHERE entry->>'activity' = activity_input
      AND entry->'policy'->>'qualification_policy_version_id' = version_input)
    FROM song_reward_offer_legs leg WHERE leg.leg_id = leg_id_input), false)
$$;

CREATE FUNCTION guard_reward_bound_pool_share() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM activity_qualifications q
    WHERE q.qualification_id = NEW.qualification_id
      AND reward_leg_accepts_qualification(NEW.pool_leg_id, q.activity_key, q.qualification_policy_version_id)) THEN
    RAISE EXCEPTION 'reward qualification version does not match frozen leg terms';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_pool_share_qualification_binding
  BEFORE INSERT ON megapot_pool_shares FOR EACH ROW EXECUTE FUNCTION guard_reward_bound_pool_share();

CREATE FUNCTION guard_reward_bound_asset_claim_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM song_reward_bundle_claims claim
    JOIN activity_qualifications q ON q.qualification_id = claim.qualification_id
    WHERE claim.account_id = NEW.account_id AND claim.offer_id = NEW.offer_id
      AND reward_leg_accepts_qualification(NEW.leg_id, q.activity_key, q.qualification_policy_version_id)) THEN
    RAISE EXCEPTION 'reward qualification version does not match frozen leg terms';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_bundle_claim_leg_qualification_binding
  BEFORE INSERT ON song_reward_bundle_claim_legs FOR EACH ROW EXECUTE FUNCTION guard_reward_bound_asset_claim_leg();

CREATE OR REPLACE FUNCTION project_megapot_pool_share_from_qualification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate RECORD;
  evidence RECORD;
  existing_consumption reward_subject_consumptions%ROWTYPE;
  decided_at TIMESTAMPTZ := clock_timestamp();
  reason TEXT;
  decision_outcome TEXT;
  decision_id TEXT;
  eligibility_id TEXT;
  consumption_id TEXT;
  identity_digest TEXT;
BEGIN
  SELECT leg.leg_id, leg.offer_id, drawing.drawing_id, drawing.entry_cutoff_at,
         offer.community_id, offer.reward_policy_version_id,
         policy.policy_hash
    INTO candidate
    FROM song_reward_offers offer
    JOIN song_reward_offer_legs leg ON leg.offer_id = offer.offer_id
    JOIN megapot_pool_drawings drawing ON drawing.pool_leg_id = leg.leg_id
    JOIN policy_versions policy
      ON policy.community_id = offer.community_id
     AND policy.policy_version_id = offer.reward_policy_version_id
     AND policy.policy_purpose = 'reward'
     AND policy.uniqueness_authority_id = offer.offer_id
   WHERE offer.community_id = NEW.community_id
     AND offer.post_id = NEW.post_id
     AND offer.audio_revision = NEW.audio_revision
     AND offer.status = 'active'
     AND NEW.qualified_at >= offer.starts_at
     AND NEW.qualified_at < offer.ends_at
     AND leg.kind = 'megapot_pool'
     AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id)
     AND leg.status = 'active'
     AND NEW.qualified_at >= leg.participation_starts_at
     AND NEW.activity_key = ANY(leg.eligible_activities)
     AND NEW.score_bps >= leg.min_score_bps
     AND drawing.status = 'entry_open'
     AND drawing.drawing_id >= leg.participation_starts_drawing_id
     AND NEW.qualified_at < drawing.entry_cutoff_at
     AND decided_at < drawing.entry_cutoff_at
     AND NOT EXISTS (
       SELECT 1 FROM megapot_pool_shares share
        WHERE share.pool_leg_id = leg.leg_id
          AND share.drawing_id = drawing.drawing_id
          AND share.account_id = NEW.account_id
     )
   ORDER BY drawing.drawing_id DESC
   LIMIT 1
   FOR UPDATE OF drawing;

  IF candidate.leg_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The drawing lock serializes Study/Karaoke producers that qualify the same
  -- account concurrently. Recheck after acquiring it so only the first commit
  -- emits an eligibility decision and share.
  IF EXISTS (
    SELECT 1 FROM megapot_pool_shares share
     WHERE share.pool_leg_id = candidate.leg_id
       AND share.drawing_id = candidate.drawing_id
       AND share.account_id = NEW.account_id
  ) THEN
    RETURN NEW;
  END IF;

  identity_digest := md5(
    NEW.qualification_id || chr(31) || candidate.leg_id || chr(31) || candidate.drawing_id::text
  );
  decision_id := 'reward_decision_' || identity_digest;
  eligibility_id := 'reward_eligibility_' || identity_digest;
  consumption_id := 'reward_subject_' || identity_digest;

  WITH exact_evidence AS (
    SELECT DISTINCT ON (subject.subject_key_id)
           subject.subject_key_id,
           active_binding.binding_event_id,
           active_binding.binding_epoch,
           receipt.evidence_receipt_id,
           receipt.evidence_hash,
           LEAST(
             candidate.entry_cutoff_at,
             receipt.expires_at,
             personhood.expires_at,
             subject_unique.expires_at
           ) AS evidence_expires_at,
           receipt.observed_at
      FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      JOIN assertion_bindings binding
        ON binding.user_id = NEW.account_id
       AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = subject.subject_key_id
       AND binding.subject_binding_event_id = active_binding.binding_event_id
       AND binding.subject_binding_epoch = active_binding.binding_epoch
      JOIN assertions personhood
        ON personhood.binding_group_id = binding.binding_group_id
       AND personhood.user_id = NEW.account_id
       AND personhood.subject_key_id = subject.subject_key_id
       AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
       AND personhood.assurance = 'provider_attested'
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = binding.binding_group_id
       AND subject_unique.user_id = NEW.account_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       AND subject_unique.assurance = 'provider_attested'
      JOIN evidence_receipts receipt
        ON receipt.evidence_receipt_id = personhood.evidence_receipt_id
       AND receipt.user_id = NEW.account_id
       AND receipt.subject_key_id = subject.subject_key_id
       AND receipt.subject_binding_event_id = active_binding.binding_event_id
       AND receipt.subject_binding_epoch = active_binding.binding_epoch
       AND receipt.provider_id = 'very.web'
       AND receipt.issuer = 'https://verify.very.org'
       AND receipt.method = 'palm_web'
       AND receipt.scope_kind = 'issuer_rp_scope'
       AND receipt.issuer_rp_scope = 'pirate-social'
       AND receipt.issuer_rp_action_scope IS NULL
       AND receipt.protocol_version = 'very-web-v1'
       AND receipt.evidence_kind = 'very.web.server-verified.v1'
       AND receipt.provenance_kind = 'proof_session'
      JOIN proof_sessions session
        ON session.proof_session_id = receipt.proof_session_id
       AND session.actor_id = NEW.account_id
       AND session.status = 'completed'
       AND session.completed_at = session.terminal_at
       AND session.provider_id = receipt.provider_id
       AND session.issuer = receipt.issuer
       AND session.method = receipt.method
       AND session.scope_kind = receipt.scope_kind
       AND session.issuer_rp_scope = receipt.issuer_rp_scope
       AND session.issuer_rp_action_scope IS NOT DISTINCT FROM receipt.issuer_rp_action_scope
       AND session.protocol_version = receipt.protocol_version
       AND session.requested_requirements =
         '[{"claim_id":"credential.subject_unique"},{"claim_id":"human.personhood"}]'::jsonb
       AND session.requested_claim_ids =
         '["credential.subject_unique","human.personhood"]'::jsonb
     WHERE subject.issuer = 'https://verify.very.org'
       AND subject.method = 'palm_web'
       AND subject.scope_kind = 'issuer_rp_scope'
       AND subject.issuer_rp_scope = 'pirate-social'
       AND subject.issuer_rp_action_scope IS NULL
       AND (receipt.expires_at IS NULL OR receipt.expires_at > decided_at + interval '5 seconds')
       AND (personhood.expires_at IS NULL OR personhood.expires_at > decided_at + interval '5 seconds')
       AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > decided_at + interval '5 seconds')
       AND COALESCE((
         SELECT revalidation.outcome
           FROM assertion_revalidation_events revalidation
          WHERE revalidation.assertion_id = personhood.assertion_id
          ORDER BY revalidation.observed_at DESC,
                   revalidation.assertion_revalidation_event_id DESC LIMIT 1
       ), 'accepted') = 'accepted'
       AND COALESCE((
         SELECT revalidation.outcome
           FROM assertion_revalidation_events revalidation
          WHERE revalidation.assertion_id = subject_unique.assertion_id
          ORDER BY revalidation.observed_at DESC,
                   revalidation.assertion_revalidation_event_id DESC LIMIT 1
       ), 'accepted') = 'accepted'
     ORDER BY subject.subject_key_id, receipt.observed_at DESC, receipt.evidence_receipt_id DESC
  )
  SELECT exact_evidence.*, count(*) OVER () AS evidence_count
    INTO evidence
    FROM exact_evidence
   ORDER BY exact_evidence.observed_at DESC, exact_evidence.subject_key_id
   LIMIT 1;

  IF evidence.subject_key_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM subject_keys subject
        JOIN active_subject_key_bindings active_binding
          ON active_binding.subject_key_id = subject.subject_key_id
         AND active_binding.user_id = NEW.account_id
        JOIN assertions personhood
          ON personhood.subject_key_id = subject.subject_key_id
         AND personhood.user_id = NEW.account_id
         AND personhood.claim_id = 'human.personhood'
         AND personhood.assertion_value = '{"personhood": true}'::jsonb
        JOIN assertions subject_unique
          ON subject_unique.binding_group_id = personhood.binding_group_id
         AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
         AND subject_unique.subject_key_id = subject.subject_key_id
         AND subject_unique.user_id = NEW.account_id
         AND subject_unique.claim_id = 'credential.subject_unique'
         AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       WHERE subject.issuer = 'https://verify.very.org'
         AND subject.method = 'palm_web'
         AND subject.scope_kind = 'issuer_rp_scope'
         AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_stale';
      decision_outcome := 'needs_evidence';
    ELSIF EXISTS (
      SELECT 1
        FROM subject_keys subject
        JOIN active_subject_key_bindings active_binding
          ON active_binding.subject_key_id = subject.subject_key_id
         AND active_binding.user_id = NEW.account_id
       WHERE subject.issuer = 'https://verify.very.org'
         AND subject.method = 'palm_web'
         AND subject.scope_kind = 'issuer_rp_scope'
         AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_failed';
      decision_outcome := 'fail';
    ELSE
      reason := 'verification_missing';
      decision_outcome := 'needs_evidence';
    END IF;

    INSERT INTO decision_records (
      decision_record_id,community_id,user_id,policy_version_id,policy_hash,
      evaluation_mode,outcome,winning_witness,trace,indeterminate_reason,request_id,created_at
    ) VALUES (
      decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
      candidate.policy_hash,'enforce',decision_outcome,'[]'::jsonb,
      jsonb_build_array(jsonb_build_object('reason',reason)),reason,
      'pool-share:' || identity_digest,decided_at
    );
    INSERT INTO reward_eligibility_decisions (
      eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
      drawing_id,decision_record_id,outcome,reason,policy_version,evidence_hash,
      decided_at,expires_at
    ) VALUES (
      eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'pool_share',
      NEW.qualification_id,candidate.drawing_id,decision_id,'ineligible',reason,
      candidate.reward_policy_version_id,candidate.policy_hash,decided_at,
      candidate.entry_cutoff_at
    );
    RETURN NEW;
  END IF;

  IF evidence.evidence_count <> 1 THEN
    reason := 'verification_failed';
  ELSE
    PERFORM 1 FROM subject_keys
     WHERE subject_key_id = evidence.subject_key_id FOR UPDATE;
    SELECT * INTO existing_consumption
      FROM reward_subject_consumptions
     WHERE campaign_id = candidate.offer_id
       AND subject_key_id = evidence.subject_key_id
     FOR UPDATE;
    IF existing_consumption.reward_subject_consumption_id IS NULL THEN
      INSERT INTO reward_subject_consumptions (
        reward_subject_consumption_id,campaign_id,subject_key_id,user_id,
        binding_event_id,binding_epoch,evidence_receipt_id,consumed_at,created_at
      ) VALUES (
        consumption_id,candidate.offer_id,evidence.subject_key_id,NEW.account_id,
        evidence.binding_event_id,evidence.binding_epoch,evidence.evidence_receipt_id,
        decided_at,decided_at
      );
    ELSIF existing_consumption.user_id <> NEW.account_id THEN
      reason := 'subject_already_consumed';
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    INSERT INTO decision_records (
      decision_record_id,community_id,user_id,policy_version_id,policy_hash,
      evaluation_mode,outcome,winning_witness,trace,indeterminate_reason,request_id,created_at
    ) VALUES (
      decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
      candidate.policy_hash,'enforce','fail','[]'::jsonb,
      jsonb_build_array(jsonb_build_object('reason',reason)),reason,
      'pool-share:' || identity_digest,decided_at
    );
    INSERT INTO reward_eligibility_decisions (
      eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
      drawing_id,decision_record_id,outcome,reason,policy_version,evidence_hash,
      decided_at,expires_at
    ) VALUES (
      eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'pool_share',
      NEW.qualification_id,candidate.drawing_id,decision_id,'ineligible',reason,
      candidate.reward_policy_version_id,evidence.evidence_hash,decided_at,
      candidate.entry_cutoff_at
    );
    RETURN NEW;
  END IF;

  INSERT INTO decision_records (
    decision_record_id,community_id,user_id,policy_version_id,policy_hash,
    evaluation_mode,outcome,winning_witness,trace,request_id,created_at
  ) VALUES (
    decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
    candidate.policy_hash,'enforce','pass',
    jsonb_build_array(jsonb_build_object(
      'subject_key_id',evidence.subject_key_id,
      'evidence_receipt_id',evidence.evidence_receipt_id
    )),jsonb_build_array(jsonb_build_object('result','eligible')),
    'pool-share:' || identity_digest,decided_at
  );
  INSERT INTO reward_eligibility_decisions (
    eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
    drawing_id,decision_record_id,outcome,policy_version,evidence_hash,decided_at,expires_at
  ) VALUES (
    eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'pool_share',
    NEW.qualification_id,candidate.drawing_id,decision_id,'eligible',
    candidate.reward_policy_version_id,evidence.evidence_hash,decided_at,
    evidence.evidence_expires_at
  );
  INSERT INTO megapot_pool_shares (
    pool_leg_id,drawing_id,account_id,persona_id,qualification_id,
    eligibility_decision_id,qualified_at
  ) VALUES (
    candidate.leg_id,candidate.drawing_id,NEW.account_id,NEW.persona_id,
    NEW.qualification_id,eligibility_id,NEW.qualified_at
  ) ON CONFLICT (account_id,pool_leg_id,drawing_id) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION project_asset_bonus_claim_from_qualification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate RECORD;
  asset_leg RECORD;
  evidence RECORD;
  existing_consumption reward_subject_consumptions%ROWTYPE;
  decided_at TIMESTAMPTZ := clock_timestamp();
  reason TEXT;
  decision_outcome TEXT;
  decision_id TEXT;
  eligibility_id TEXT;
  consumption_id TEXT;
  identity_digest TEXT;
  credit_id TEXT;
BEGIN
  SELECT offer.offer_id, offer.community_id, offer.reward_policy_version_id,
         offer.ends_at, policy.policy_hash, leg.leg_id
    INTO candidate
    FROM song_reward_offers offer
    JOIN song_reward_offer_legs leg ON leg.offer_id = offer.offer_id
    JOIN policy_versions policy
      ON policy.community_id = offer.community_id
     AND policy.policy_version_id = offer.reward_policy_version_id
     AND policy.policy_purpose = 'reward'
     AND policy.uniqueness_authority_id = offer.offer_id
   WHERE offer.community_id = NEW.community_id
     AND offer.post_id = NEW.post_id
     AND offer.audio_revision = NEW.audio_revision
     AND offer.status = 'active'
     AND decided_at < offer.ends_at
     AND NEW.qualified_at >= offer.starts_at
     AND NEW.qualified_at < offer.ends_at
     AND leg.kind = 'asset_bonus'
     AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id) AND leg.status = 'active'
     AND NEW.qualified_at >= leg.participation_starts_at
     AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
     AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
       - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
   ORDER BY leg.leg_id
   LIMIT 1
   FOR UPDATE OF leg;

  IF candidate.offer_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.account_id || chr(31) || candidate.offer_id, 53000002
  ));
  IF EXISTS (
    SELECT 1 FROM song_reward_bundle_claims claim
     WHERE claim.account_id = NEW.account_id AND claim.offer_id = candidate.offer_id
  ) THEN
    RETURN NEW;
  END IF;

  identity_digest := md5(NEW.qualification_id || chr(31) || candidate.offer_id);
  decision_id := 'reward_decision_' || identity_digest;
  eligibility_id := 'reward_eligibility_' || identity_digest;
  consumption_id := 'reward_subject_' || identity_digest;

  WITH exact_evidence AS (
    SELECT DISTINCT ON (subject.subject_key_id)
           subject.subject_key_id, active_binding.binding_event_id,
           active_binding.binding_epoch, receipt.evidence_receipt_id,
           receipt.evidence_hash,
           LEAST(candidate.ends_at, receipt.expires_at,
             personhood.expires_at, subject_unique.expires_at) AS evidence_expires_at,
           receipt.observed_at
      FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      JOIN assertion_bindings binding
        ON binding.user_id = NEW.account_id AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = subject.subject_key_id
       AND binding.subject_binding_event_id = active_binding.binding_event_id
       AND binding.subject_binding_epoch = active_binding.binding_epoch
      JOIN assertions personhood
        ON personhood.binding_group_id = binding.binding_group_id
       AND personhood.user_id = NEW.account_id
       AND personhood.subject_key_id = subject.subject_key_id
       AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
       AND personhood.assurance = 'provider_attested'
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = binding.binding_group_id
       AND subject_unique.user_id = NEW.account_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       AND subject_unique.assurance = 'provider_attested'
      JOIN evidence_receipts receipt
        ON receipt.evidence_receipt_id = personhood.evidence_receipt_id
       AND receipt.user_id = NEW.account_id
       AND receipt.subject_key_id = subject.subject_key_id
       AND receipt.subject_binding_event_id = active_binding.binding_event_id
       AND receipt.subject_binding_epoch = active_binding.binding_epoch
       AND receipt.provider_id = 'very.web'
       AND receipt.issuer = 'https://verify.very.org'
       AND receipt.method = 'palm_web'
       AND receipt.scope_kind = 'issuer_rp_scope'
       AND receipt.issuer_rp_scope = 'pirate-social'
       AND receipt.issuer_rp_action_scope IS NULL
       AND receipt.protocol_version = 'very-web-v1'
       AND receipt.evidence_kind = 'very.web.server-verified.v1'
       AND receipt.provenance_kind = 'proof_session'
      JOIN proof_sessions session
        ON session.proof_session_id = receipt.proof_session_id
       AND session.actor_id = NEW.account_id
       AND session.status = 'completed' AND session.completed_at = session.terminal_at
       AND session.provider_id = receipt.provider_id AND session.issuer = receipt.issuer
       AND session.method = receipt.method AND session.scope_kind = receipt.scope_kind
       AND session.issuer_rp_scope = receipt.issuer_rp_scope
       AND session.issuer_rp_action_scope IS NOT DISTINCT FROM receipt.issuer_rp_action_scope
       AND session.protocol_version = receipt.protocol_version
       AND session.requested_requirements =
         '[{"claim_id":"credential.subject_unique"},{"claim_id":"human.personhood"}]'::jsonb
       AND session.requested_claim_ids =
         '["credential.subject_unique","human.personhood"]'::jsonb
     WHERE subject.issuer = 'https://verify.very.org'
       AND subject.method = 'palm_web' AND subject.scope_kind = 'issuer_rp_scope'
       AND subject.issuer_rp_scope = 'pirate-social'
       AND subject.issuer_rp_action_scope IS NULL
       AND (receipt.expires_at IS NULL OR receipt.expires_at > decided_at + interval '5 seconds')
       AND (personhood.expires_at IS NULL OR personhood.expires_at > decided_at + interval '5 seconds')
       AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > decided_at + interval '5 seconds')
       AND COALESCE((SELECT revalidation.outcome
          FROM assertion_revalidation_events revalidation
         WHERE revalidation.assertion_id = personhood.assertion_id
         ORDER BY revalidation.observed_at DESC,
                  revalidation.assertion_revalidation_event_id DESC LIMIT 1), 'accepted') = 'accepted'
       AND COALESCE((SELECT revalidation.outcome
          FROM assertion_revalidation_events revalidation
         WHERE revalidation.assertion_id = subject_unique.assertion_id
         ORDER BY revalidation.observed_at DESC,
                  revalidation.assertion_revalidation_event_id DESC LIMIT 1), 'accepted') = 'accepted'
     ORDER BY subject.subject_key_id, receipt.observed_at DESC,
              receipt.evidence_receipt_id DESC
  )
  SELECT exact_evidence.*, count(*) OVER () AS evidence_count
    INTO evidence FROM exact_evidence
   ORDER BY exact_evidence.observed_at DESC, exact_evidence.subject_key_id LIMIT 1;

  IF evidence.subject_key_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      JOIN assertions personhood ON personhood.subject_key_id = subject.subject_key_id
       AND personhood.user_id = NEW.account_id AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = personhood.binding_group_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.user_id = NEW.account_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
      WHERE subject.issuer = 'https://verify.very.org' AND subject.method = 'palm_web'
        AND subject.scope_kind = 'issuer_rp_scope'
        AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_stale'; decision_outcome := 'needs_evidence';
    ELSIF EXISTS (
      SELECT 1 FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      WHERE subject.issuer = 'https://verify.very.org' AND subject.method = 'palm_web'
        AND subject.scope_kind = 'issuer_rp_scope'
        AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_failed'; decision_outcome := 'fail';
    ELSE
      reason := 'verification_missing'; decision_outcome := 'needs_evidence';
    END IF;
  ELSIF evidence.evidence_count <> 1 THEN
    reason := 'verification_failed'; decision_outcome := 'fail';
  ELSE
    PERFORM 1 FROM subject_keys WHERE subject_key_id = evidence.subject_key_id FOR UPDATE;
    SELECT * INTO existing_consumption FROM reward_subject_consumptions
     WHERE campaign_id = candidate.offer_id AND subject_key_id = evidence.subject_key_id
     FOR UPDATE;
    IF existing_consumption.reward_subject_consumption_id IS NULL THEN
      INSERT INTO reward_subject_consumptions (
        reward_subject_consumption_id,campaign_id,subject_key_id,user_id,
        binding_event_id,binding_epoch,evidence_receipt_id,consumed_at,created_at
      ) VALUES (
        consumption_id,candidate.offer_id,evidence.subject_key_id,NEW.account_id,
        evidence.binding_event_id,evidence.binding_epoch,evidence.evidence_receipt_id,
        decided_at,decided_at
      );
    ELSIF existing_consumption.user_id <> NEW.account_id THEN
      reason := 'subject_already_consumed'; decision_outcome := 'fail';
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    INSERT INTO decision_records (
      decision_record_id,community_id,user_id,policy_version_id,policy_hash,
      evaluation_mode,outcome,winning_witness,trace,indeterminate_reason,request_id,created_at
    ) VALUES (
      decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
      candidate.policy_hash,'enforce',decision_outcome,'[]'::jsonb,
      jsonb_build_array(jsonb_build_object('reason',reason)),reason,
      'asset-claim:' || identity_digest,decided_at
    );
    INSERT INTO reward_eligibility_decisions (
      eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
      decision_record_id,outcome,reason,policy_version,evidence_hash,decided_at,expires_at
    ) VALUES (
      eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'asset_claim',
      NEW.qualification_id,decision_id,'ineligible',reason,
      candidate.reward_policy_version_id,COALESCE(evidence.evidence_hash,candidate.policy_hash),
      decided_at,candidate.ends_at
    );
    INSERT INTO song_reward_bundle_claims (
      account_id,offer_id,persona_id,qualification_id,eligibility_decision_id,
      state,terminal_reason,created_at,updated_at
    ) VALUES (
      NEW.account_id,candidate.offer_id,NEW.persona_id,NEW.qualification_id,
      eligibility_id,'ineligible',reason,decided_at,decided_at
    );
    FOR asset_leg IN
      SELECT leg.* FROM song_reward_offer_legs leg
       WHERE leg.offer_id = candidate.offer_id AND leg.kind = 'asset_bonus'
     AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id)
         AND leg.status = 'active' AND NEW.qualified_at >= leg.participation_starts_at
         AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
         AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
           - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
       ORDER BY leg.leg_id FOR UPDATE
    LOOP
      INSERT INTO song_reward_bundle_claim_legs (
        account_id,offer_id,leg_id,amount_atomic,state,terminal_reason,created_at
      ) VALUES (
        NEW.account_id,candidate.offer_id,asset_leg.leg_id,
        asset_leg.amount_per_claim_atomic,'unavailable',reason,decided_at
      );
    END LOOP;
    RETURN NEW;
  END IF;

  INSERT INTO decision_records (
    decision_record_id,community_id,user_id,policy_version_id,policy_hash,
    evaluation_mode,outcome,winning_witness,trace,request_id,created_at
  ) VALUES (
    decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
    candidate.policy_hash,'enforce','pass',
    jsonb_build_array(jsonb_build_object('subject_key_id',evidence.subject_key_id,
      'evidence_receipt_id',evidence.evidence_receipt_id)),
    jsonb_build_array(jsonb_build_object('result','eligible')),
    'asset-claim:' || identity_digest,decided_at
  );
  INSERT INTO reward_eligibility_decisions (
    eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
    decision_record_id,outcome,policy_version,evidence_hash,decided_at,expires_at
  ) VALUES (
    eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'asset_claim',
    NEW.qualification_id,decision_id,'eligible',candidate.reward_policy_version_id,
    evidence.evidence_hash,decided_at,evidence.evidence_expires_at
  );
  INSERT INTO song_reward_bundle_claims (
    account_id,offer_id,persona_id,qualification_id,eligibility_decision_id,
    state,created_at,updated_at
  ) VALUES (
    NEW.account_id,candidate.offer_id,NEW.persona_id,NEW.qualification_id,
    eligibility_id,'credited',decided_at,decided_at
  );

  FOR asset_leg IN
    SELECT leg.* FROM song_reward_offer_legs leg
     WHERE leg.offer_id = candidate.offer_id AND leg.kind = 'asset_bonus'
     AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id)
       AND leg.status = 'active' AND NEW.qualified_at >= leg.participation_starts_at
       AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
       AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
         - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
     ORDER BY leg.leg_id FOR UPDATE
  LOOP
    credit_id := 'reward_credit_' || md5(
      NEW.account_id || chr(31) || asset_leg.leg_id || chr(31) || NEW.qualification_id
    );
    INSERT INTO reward_ledger_credits (
      credit_id,account_id,payout_persona_id,chain_id,token_address,amount_atomic,
      source_kind,source_reference,state,created_at,updated_at
    ) VALUES (
      credit_id,NEW.account_id,NEW.persona_id,asset_leg.chain_id,
      asset_leg.token_address,asset_leg.amount_per_claim_atomic,'asset_bonus',
      asset_leg.leg_id || ':' || NEW.qualification_id,'credited',decided_at,decided_at
    );
    INSERT INTO song_reward_bundle_claim_legs (
      account_id,offer_id,leg_id,amount_atomic,credit_id,state,created_at
    ) VALUES (
      NEW.account_id,candidate.offer_id,asset_leg.leg_id,
      asset_leg.amount_per_claim_atomic,credit_id,'credited',decided_at
    );
    UPDATE song_reward_offer_legs
       SET fulfilled_atomic = fulfilled_atomic + asset_leg.amount_per_claim_atomic,
           status = CASE
             WHEN (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    / amount_per_claim_atomic >= max_claims
               OR funded_atomic - reserved_atomic - spent_atomic - refunded_atomic
                    - (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    < amount_per_claim_atomic
             THEN 'exhausted' ELSE status END,
           participation_ends_at = CASE
             WHEN (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    / amount_per_claim_atomic >= max_claims
               OR funded_atomic - reserved_atomic - spent_atomic - refunded_atomic
                    - (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    < amount_per_claim_atomic
             THEN decided_at ELSE participation_ends_at END,
           updated_at = decided_at
     WHERE leg_id = asset_leg.leg_id;
  END LOOP;
  RETURN NEW;
END
$$;
