-- Spec 015 §5.2a (ratified 2026-09-25): Megapot pool participants are verified
-- at claim, not at entry. A qualifying account receives a pool share without
-- Very evidence; its winnings become a custody credit that is paid only after
-- the account accepts a claim with current Very evidence. One Very subject may
-- accept at most one participant credit per (pool_leg_id, drawing_id). A
-- credit whose subject was already used in that scope is held in
-- subject_conflict and stays owed. Asset-bonus admission is unchanged.

-- The Very evidence check previously inlined in the projection triggers,
-- lifted so the claim can reuse it. input_valid_until caps the reported
-- evidence expiry and may be NULL (LEAST ignores NULL).
CREATE FUNCTION reward_account_very_evidence_v1(
  input_account_id TEXT,
  input_valid_until TIMESTAMPTZ
) RETURNS TABLE (
  subject_key_id TEXT,
  binding_event_id TEXT,
  binding_epoch BIGINT,
  evidence_receipt_id TEXT,
  evidence_hash TEXT,
  evidence_expires_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  evidence_count BIGINT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  checked_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  RETURN QUERY

  WITH exact_evidence AS (
    SELECT DISTINCT ON (subject.subject_key_id)
           subject.subject_key_id,
           active_binding.binding_event_id,
           active_binding.binding_epoch,
           receipt.evidence_receipt_id,
           receipt.evidence_hash,
           LEAST(
             input_valid_until,
             receipt.expires_at,
             personhood.expires_at,
             subject_unique.expires_at
           ) AS evidence_expires_at,
           receipt.observed_at
      FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = input_account_id
      JOIN assertion_bindings binding
        ON binding.user_id = input_account_id
       AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = subject.subject_key_id
       AND binding.subject_binding_event_id = active_binding.binding_event_id
       AND binding.subject_binding_epoch = active_binding.binding_epoch
      JOIN assertions personhood
        ON personhood.binding_group_id = binding.binding_group_id
       AND personhood.user_id = input_account_id
       AND personhood.subject_key_id = subject.subject_key_id
       AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
       AND personhood.assurance = 'provider_attested'
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = binding.binding_group_id
       AND subject_unique.user_id = input_account_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       AND subject_unique.assurance = 'provider_attested'
      JOIN evidence_receipts receipt
        ON receipt.evidence_receipt_id = personhood.evidence_receipt_id
       AND receipt.user_id = input_account_id
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
       AND session.actor_id = input_account_id
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
       AND (receipt.expires_at IS NULL OR receipt.expires_at > checked_at + interval '5 seconds')
       AND (personhood.expires_at IS NULL OR personhood.expires_at > checked_at + interval '5 seconds')
       AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > checked_at + interval '5 seconds')
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
  SELECT exact_evidence.subject_key_id, exact_evidence.binding_event_id,
         exact_evidence.binding_epoch::BIGINT, exact_evidence.evidence_receipt_id,
         exact_evidence.evidence_hash, exact_evidence.evidence_expires_at,
         exact_evidence.observed_at, count(*) OVER ()
    FROM exact_evidence
   ORDER BY exact_evidence.observed_at DESC, exact_evidence.subject_key_id
   LIMIT 1;
END
$$;

-- Admission without Very evidence. The candidate lookup, one-share-per-account
-- recheck and drawing lock are unchanged from 0134. No subject is consumed at
-- entry; verification moves to the participant claim.
CREATE OR REPLACE FUNCTION project_megapot_pool_share_from_qualification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate RECORD;
  decided_at TIMESTAMPTZ := clock_timestamp();
  decision_id TEXT;
  eligibility_id TEXT;
  identity_digest TEXT;
  admission_hash TEXT;
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

  -- The drawing lock serializes producers that qualify the same account
  -- concurrently; recheck so only the first commit emits a decision and share.
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
  -- The admitted facts, not provider evidence: entry requires none.
  admission_hash := encode(sha256(convert_to(jsonb_build_object(
    'admission', 'megapot_claim_time_verification_v1',
    'qualification_id', NEW.qualification_id,
    'pool_leg_id', candidate.leg_id,
    'drawing_id', candidate.drawing_id::text,
    'policy_hash', candidate.policy_hash
  )::text, 'UTF8')), 'hex');

  INSERT INTO decision_records (
    decision_record_id,community_id,user_id,policy_version_id,policy_hash,
    evaluation_mode,outcome,winning_witness,trace,request_id,created_at
  ) VALUES (
    decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
    candidate.policy_hash,'enforce','pass',
    -- A pass must name its witness: the qualification and admitted terms.
    jsonb_build_array(jsonb_build_object(
      'admission','megapot_claim_time_verification_v1',
      'qualification_id',NEW.qualification_id,
      'pool_leg_id',candidate.leg_id,
      'drawing_id',candidate.drawing_id::text
    )),
    jsonb_build_array(jsonb_build_object(
      'result','eligible','admission','megapot_claim_time_verification_v1'
    )),
    'pool-share:' || identity_digest,decided_at
  );
  INSERT INTO reward_eligibility_decisions (
    eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
    drawing_id,decision_record_id,outcome,policy_version,evidence_hash,decided_at,expires_at
  ) VALUES (
    eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'pool_share',
    NEW.qualification_id,candidate.drawing_id,decision_id,'eligible',
    candidate.reward_policy_version_id,admission_hash,decided_at,
    candidate.entry_cutoff_at
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

-- One claim record per participant credit. accepted is terminal; the only
-- transition is subject_conflict -> accepted, by a later claim with a
-- different unused subject or by an audited operator decision.
CREATE TABLE megapot_participant_claims (
  credit_id TEXT PRIMARY KEY REFERENCES reward_ledger_credits (credit_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  pool_leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  drawing_id NUMERIC(78, 0) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'subject_conflict')),
  subject_key_id TEXT REFERENCES subject_keys (subject_key_id),
  evidence_receipt_id TEXT,
  operator_actor_role TEXT,
  operator_reason TEXT,
  operator_evidence_reference TEXT,
  operator_decided_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT megapot_participant_claim_shape CHECK (
    (status = 'subject_conflict' AND accepted_at IS NULL AND subject_key_id IS NOT NULL
      AND operator_decided_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND (
      (operator_decided_at IS NULL AND subject_key_id IS NOT NULL AND evidence_receipt_id IS NOT NULL)
      OR (operator_decided_at IS NOT NULL AND operator_actor_role IS NOT NULL
        AND btrim(operator_actor_role) <> '' AND operator_reason IS NOT NULL
        AND btrim(operator_reason) <> '' AND operator_evidence_reference IS NOT NULL
        AND btrim(operator_evidence_reference) <> '')
    ))
  )
);

-- One Very subject may accept at most one participant credit per pool and
-- drawing. Append-only; an operator decision never inserts or releases a guard.
CREATE TABLE megapot_participant_claim_guards (
  pool_leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  drawing_id NUMERIC(78, 0) NOT NULL,
  subject_key_id TEXT NOT NULL REFERENCES subject_keys (subject_key_id),
  credit_id TEXT NOT NULL UNIQUE REFERENCES megapot_participant_claims (credit_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pool_leg_id, drawing_id, subject_key_id)
);

CREATE FUNCTION guard_megapot_participant_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'megapot participant claims are never deleted';
  END IF;
  IF NEW.credit_id <> OLD.credit_id OR NEW.account_id <> OLD.account_id
     OR NEW.pool_leg_id <> OLD.pool_leg_id OR NEW.drawing_id <> OLD.drawing_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'megapot participant claim identity is immutable';
  END IF;
  IF OLD.status = 'accepted' THEN
    RAISE EXCEPTION 'an accepted megapot participant claim is terminal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_participant_claims_guard
  BEFORE UPDATE OR DELETE ON megapot_participant_claims
  FOR EACH ROW EXECUTE FUNCTION guard_megapot_participant_claim();

CREATE FUNCTION guard_megapot_participant_claim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'megapot participant claim guards are append-only';
END
$$;
CREATE TRIGGER megapot_participant_claim_guards_append_only
  BEFORE UPDATE OR DELETE ON megapot_participant_claim_guards
  FOR EACH ROW EXECUTE FUNCTION guard_megapot_participant_claim_guard();

-- The participant claim. Idempotent per credit. Outcomes: accepted,
-- subject_conflict, verification_missing, verification_stale,
-- verification_failed, not_found. Evidence refusals write nothing, so the
-- credit stays claimable later.
CREATE FUNCTION accept_megapot_participant_claim_v1(
  input_credit_id TEXT,
  input_account_id TEXT
) RETURNS TABLE (outcome TEXT, claim_status TEXT)
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE
  target RECORD;
  existing megapot_participant_claims%ROWTYPE;
  evidence RECORD;
  guard_owner TEXT;
  result_reason TEXT;
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT credit.credit_id, credit.account_id, batch.pool_leg_id, batch.drawing_id
    INTO target
    FROM reward_ledger_credits credit
    JOIN megapot_allocations allocation
      ON allocation.credit_id = credit.credit_id
     AND allocation.allocation_kind = 'participant'
    JOIN megapot_allocation_batches batch
      ON batch.allocation_batch_id = allocation.allocation_batch_id
   WHERE credit.credit_id = input_credit_id
     AND credit.account_id = input_account_id
     AND credit.source_kind = 'megapot_allocation'
   FOR UPDATE OF credit;
  IF target.credit_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO existing FROM megapot_participant_claims claim
   WHERE claim.credit_id = input_credit_id FOR UPDATE;
  IF existing.status = 'accepted' THEN
    RETURN QUERY SELECT 'accepted'::TEXT, 'accepted'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO evidence FROM reward_account_very_evidence_v1(input_account_id, NULL);
  IF evidence.subject_key_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM subject_keys subject
        JOIN active_subject_key_bindings active_binding
          ON active_binding.subject_key_id = subject.subject_key_id
         AND active_binding.user_id = input_account_id
        JOIN assertions personhood
          ON personhood.subject_key_id = subject.subject_key_id
         AND personhood.user_id = input_account_id
         AND personhood.claim_id = 'human.personhood'
         AND personhood.assertion_value = '{"personhood": true}'::jsonb
        JOIN assertions subject_unique
          ON subject_unique.binding_group_id = personhood.binding_group_id
         AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
         AND subject_unique.subject_key_id = subject.subject_key_id
         AND subject_unique.user_id = input_account_id
         AND subject_unique.claim_id = 'credential.subject_unique'
         AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       WHERE subject.issuer = 'https://verify.very.org'
         AND subject.method = 'palm_web'
         AND subject.scope_kind = 'issuer_rp_scope'
         AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      result_reason := 'verification_stale';
    ELSIF EXISTS (
      SELECT 1
        FROM subject_keys subject
        JOIN active_subject_key_bindings active_binding
          ON active_binding.subject_key_id = subject.subject_key_id
         AND active_binding.user_id = input_account_id
       WHERE subject.issuer = 'https://verify.very.org'
         AND subject.method = 'palm_web'
         AND subject.scope_kind = 'issuer_rp_scope'
         AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      result_reason := 'verification_failed';
    ELSE
      result_reason := 'verification_missing';
    END IF;

    RETURN QUERY SELECT result_reason, existing.status;
    RETURN;
  END IF;
  IF evidence.evidence_count <> 1 THEN
    RETURN QUERY SELECT 'verification_failed'::TEXT, existing.status;
    RETURN;
  END IF;

  PERFORM 1 FROM subject_keys subject
   WHERE subject.subject_key_id = evidence.subject_key_id FOR UPDATE;
  SELECT guard.credit_id INTO guard_owner
    FROM megapot_participant_claim_guards guard
   WHERE guard.pool_leg_id = target.pool_leg_id
     AND guard.drawing_id = target.drawing_id
     AND guard.subject_key_id = evidence.subject_key_id;

  IF guard_owner IS NOT NULL AND guard_owner <> input_credit_id THEN
    IF existing.credit_id IS NULL THEN
      INSERT INTO megapot_participant_claims (
        credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id
      ) VALUES (
        input_credit_id, input_account_id, target.pool_leg_id, target.drawing_id,
        'subject_conflict', evidence.subject_key_id
      );
    ELSE
      UPDATE megapot_participant_claims claim
         SET subject_key_id = evidence.subject_key_id, updated_at = now_at
       WHERE claim.credit_id = input_credit_id;
    END IF;
    RETURN QUERY SELECT 'subject_conflict'::TEXT, 'subject_conflict'::TEXT;
    RETURN;
  END IF;

  IF existing.credit_id IS NULL THEN
    INSERT INTO megapot_participant_claims (
      credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
      evidence_receipt_id, accepted_at
    ) VALUES (
      input_credit_id, input_account_id, target.pool_leg_id, target.drawing_id,
      'accepted', evidence.subject_key_id, evidence.evidence_receipt_id, now_at
    );
  ELSE
    UPDATE megapot_participant_claims claim
       SET status = 'accepted', subject_key_id = evidence.subject_key_id,
           evidence_receipt_id = evidence.evidence_receipt_id,
           accepted_at = now_at, updated_at = now_at
     WHERE claim.credit_id = input_credit_id;
  END IF;
  IF guard_owner IS NULL THEN
    INSERT INTO megapot_participant_claim_guards (
      pool_leg_id, drawing_id, subject_key_id, credit_id, account_id, consumed_at
    ) VALUES (
      target.pool_leg_id, target.drawing_id, evidence.subject_key_id,
      input_credit_id, input_account_id, now_at
    );
  END IF;
  RETURN QUERY SELECT 'accepted'::TEXT, 'accepted'::TEXT;
END
$$;

-- The audited operator exception: only a subject_conflict claim can be moved
-- to accepted, through the same one-per-credit record. It never inserts or
-- releases a guard, so it cannot create a second claim or payout.
CREATE FUNCTION operator_accept_megapot_participant_claim_v1(
  input_credit_id TEXT,
  input_actor_role TEXT,
  input_reason TEXT,
  input_evidence_reference TEXT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  existing megapot_participant_claims%ROWTYPE;
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO existing FROM megapot_participant_claims
   WHERE credit_id = input_credit_id FOR UPDATE;
  IF existing.credit_id IS NULL OR existing.status <> 'subject_conflict' THEN
    RAISE EXCEPTION 'operator exception requires a subject_conflict claim';
  END IF;
  UPDATE megapot_participant_claims
     SET status = 'accepted', operator_actor_role = input_actor_role,
         operator_reason = input_reason,
         operator_evidence_reference = input_evidence_reference,
         operator_decided_at = now_at, accepted_at = now_at, updated_at = now_at
   WHERE credit_id = input_credit_id;
  RETURN 'accepted';
END
$$;

-- Database backstop for the payout gate: a participant credit cannot leave
-- credited (reservation for payout) without an accepted claim, whatever path
-- writes the row.
CREATE FUNCTION guard_megapot_participant_credit_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_kind = 'megapot_allocation' AND OLD.state = 'credited'
     AND NEW.state <> 'credited'
     AND NOT EXISTS (
       SELECT 1 FROM megapot_participant_claims claim
        WHERE claim.credit_id = NEW.credit_id AND claim.status = 'accepted'
     ) THEN
    RAISE EXCEPTION 'megapot participant credit requires an accepted claim before payout';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_ledger_credits_participant_claim_gate
  BEFORE UPDATE ON reward_ledger_credits
  FOR EACH ROW EXECUTE FUNCTION guard_megapot_participant_credit_claim();

-- Privilege contract. Claims and guards change only through the two routines
-- above, which run as their owner with a pinned search path. The runtime role
-- may execute the participant claim but never write either table directly,
-- and only the operator role may execute the audited exception, so the
-- serving role cannot write an operator decision directly. It can still write
-- identity evidence tables, so this is not a defence against a fully
-- compromised serving path. The
-- blanket default table privileges would otherwise reach both new tables, so
-- the migration revokes them in deployment order under the role-existence
-- guard; the role template states the same contract.
ALTER FUNCTION accept_megapot_participant_claim_v1(TEXT, TEXT) SECURITY DEFINER;
ALTER FUNCTION operator_accept_megapot_participant_claim_v1(TEXT, TEXT, TEXT, TEXT)
  SECURITY DEFINER;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'megapot claim-time verification migration requires a current schema';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.accept_megapot_participant_claim_v1(text,text) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.operator_accept_megapot_participant_claim_v1(text,text,text,text) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
END;
$$;

REVOKE ALL ON FUNCTION accept_megapot_participant_claim_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION operator_accept_megapot_participant_claim_v1(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC;

DO $megapot_claim_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE
      'REVOKE INSERT, UPDATE, DELETE ON TABLE megapot_participant_claims, megapot_participant_claim_guards FROM api_next_app';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION accept_megapot_participant_claim_v1(text,text) TO api_next_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_operator') THEN
    EXECUTE
      'GRANT EXECUTE ON FUNCTION operator_accept_megapot_participant_claim_v1(text,text,text,text) TO api_next_operator';
  END IF;
END;
$megapot_claim_privileges$;
