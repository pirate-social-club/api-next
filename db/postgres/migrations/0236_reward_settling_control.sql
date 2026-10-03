-- Expand the incident brake without recalling already-admitted transactions.
-- Historical state is derived from the unchanged paused evidence. The migration
-- runner owns this atomic schema transaction; no runtime can write these rows.
DROP TRIGGER reward_operations_control_change_guard ON reward_operations_control;
DROP TRIGGER reward_operations_control_events_change_guard ON reward_operations_control_events;
ALTER TABLE reward_operations_control ADD COLUMN state TEXT;
ALTER TABLE reward_operations_control_events ADD COLUMN state TEXT;
UPDATE reward_operations_control SET state=CASE WHEN paused THEN 'paused' ELSE 'running' END;
UPDATE reward_operations_control_events SET state=CASE WHEN paused THEN 'paused' ELSE 'running' END;
ALTER TABLE reward_operations_control ALTER COLUMN state SET NOT NULL;
ALTER TABLE reward_operations_control ALTER COLUMN state SET DEFAULT 'paused';
ALTER TABLE reward_operations_control_events ALTER COLUMN state SET NOT NULL;
ALTER TABLE reward_operations_control ADD CONSTRAINT reward_operations_control_state_shape
  CHECK (state IN ('running','settling','paused') AND paused=(state <> 'running'));
ALTER TABLE reward_operations_control_events ADD CONSTRAINT reward_operations_events_state_shape
  CHECK (state IN ('running','settling','paused') AND paused=(state <> 'running'));

CREATE OR REPLACE FUNCTION guard_reward_operations_control() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.state='paused' AND NEW.paused AND NEW.revision=0
     AND NEW.reason='environment_initially_paused' THEN RETURN NEW; END IF;
  IF TG_OP <> 'UPDATE' OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.revision <> OLD.revision+1 OR NEW.changed_at <= OLD.changed_at
     OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'invalid reward operations control transition' USING ERRCODE='PR002';
  END IF;
  INSERT INTO reward_operations_control_events(revision,paused,reason,operator_role,changed_at,state)
  VALUES(NEW.revision,NEW.paused,NEW.reason,session_user,NEW.changed_at,NEW.state);
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_operations_control_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_operations_control
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_control();
CREATE TRIGGER reward_operations_control_events_change_guard
BEFORE UPDATE OR DELETE ON reward_operations_control_events
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_control_event();

CREATE FUNCTION set_reward_operations_state_v2(
  expected_revision BIGINT, requested_state TEXT, operator_reason TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR UPDATE;
  IF NOT FOUND OR expected_revision IS NULL OR control_record.revision <> expected_revision
     OR requested_state IS NULL OR requested_state NOT IN ('running','settling','paused')
     OR operator_reason IS NULL OR octet_length(btrim(operator_reason)) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'reward operations control conflict' USING ERRCODE='PR002';
  END IF;
  IF control_record.state=requested_state THEN RETURN control_record.revision; END IF;
  UPDATE reward_operations_control
     SET state=requested_state, paused=(requested_state <> 'running'), revision=revision+1,
         reason=btrim(operator_reason), changed_at=clock_timestamp()
   WHERE singleton;
  RETURN control_record.revision+1;
END
$$;

-- The existing explicitly granted pause/resume authority keeps working. Pause
-- from settling performs a real transition even though paused is already true.
CREATE OR REPLACE FUNCTION set_reward_operations_paused_v1(
  expected_revision BIGINT, requested_paused BOOLEAN, operator_reason TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN set_reward_operations_state_v2(expected_revision,
    CASE WHEN requested_paused IS NULL THEN NULL
         WHEN requested_paused THEN 'paused' ELSE 'running' END,operator_reason);
END
$$;

-- Trigger WHEN predicates must not erase ordinary qualification or streaks.
-- This read/lock routine grants no operator or financial write authority.
CREATE FUNCTION reward_operations_running_v2() RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR SHARE;
  RETURN FOUND AND control_record.state='running' AND control_record.paused=FALSE;
END
$$;
DROP TRIGGER activity_qualifications_project_asset_bonus_claim ON activity_qualifications;
CREATE TRIGGER activity_qualifications_project_asset_bonus_claim
AFTER INSERT ON activity_qualifications FOR EACH ROW
WHEN (reward_operations_running_v2())
EXECUTE FUNCTION project_asset_bonus_claim_from_qualification();
DROP TRIGGER activity_qualifications_project_megapot_share ON activity_qualifications;
CREATE TRIGGER activity_qualifications_project_megapot_share
AFTER INSERT ON activity_qualifications FOR EACH ROW
WHEN (reward_operations_running_v2())
EXECUTE FUNCTION project_megapot_pool_share_from_qualification();

CREATE OR REPLACE FUNCTION guard_reward_http_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT reward_operations_running_v2() THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
-- Direct SQL cannot bypass the gated qualification projections.
CREATE TRIGGER reward_entries_admission_guard BEFORE INSERT ON megapot_pool_shares
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
CREATE TRIGGER reward_entries_admission_guard BEFORE INSERT ON song_reward_bundle_claims
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
CREATE TRIGGER reward_entries_admission_guard BEFORE INSERT ON song_reward_bundle_claim_legs
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
CREATE TRIGGER reward_entries_admission_guard BEFORE INSERT ON reward_ledger_credits
FOR EACH ROW WHEN (NEW.source_kind='asset_bonus')
EXECUTE FUNCTION guard_reward_http_admission();

CREATE OR REPLACE FUNCTION guard_reward_signer_nonce() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reward signer nonce fences cannot be deleted'; END IF;
  IF TG_OP='UPDATE' AND (
    NEW.chain_id <> OLD.chain_id OR NEW.signer_address <> OLD.signer_address
    OR NEW.next_nonce < OLD.next_nonce OR NEW.fence_version <> OLD.fence_version+1
    OR NEW.observed_block_number < OLD.observed_block_number
    OR NEW.observed_at < OLD.observed_at OR NEW.updated_at <= OLD.updated_at
  ) THEN RAISE EXCEPTION 'invalid reward signer nonce fence update'; END IF;
  IF TG_OP='INSERT' OR NEW.next_nonce > OLD.next_nonce THEN
    SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR SHARE;
    IF NOT FOUND OR control_record.state NOT IN ('running','settling')
       OR control_record.paused IS DISTINCT FROM (control_record.state <> 'running') THEN
      RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Admission locks the same row as the operator. Inserts of new business are
-- refused; updates of existing reserved/signed/uncertain tails remain untouched.
CREATE FUNCTION guard_reward_effect_admission_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR SHARE;
  -- An identity-preserving replacement belongs to an existing admitted tail.
  -- The existing chain identity guard validates its complete replacement pair.
  IF NEW.replacement_of_effect_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM reward_chain_effects previous
     WHERE previous.effect_id=NEW.replacement_of_effect_id AND previous.nonce IS NOT NULL
       AND previous.state='replaced' AND previous.replaced_by_effect_id=NEW.effect_id
       AND previous.effect_kind=NEW.effect_kind AND previous.chain_id=NEW.chain_id
       AND previous.signer_address=NEW.signer_address AND previous.target_address=NEW.target_address
       AND previous.value_wei=NEW.value_wei AND previous.reserved_amount_atomic=NEW.reserved_amount_atomic
       AND (TG_OP='INSERT' OR NEW.nonce=previous.nonce)
  ) THEN RETURN NEW; END IF;
  IF NOT FOUND OR control_record.paused IS DISTINCT FROM (control_record.state <> 'running')
     OR (control_record.state <> 'running' AND NOT (
       control_record.state='settling' AND NEW.effect_kind IN
         ('reward_refund','reward_payout','winnings_claim')
     )) THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION reward_effect_is_admitted_replacement_v2(effect_id_input TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM reward_chain_effects effect
    JOIN reward_chain_effects previous ON previous.effect_id=effect.replacement_of_effect_id
     WHERE effect.effect_id=effect_id_input AND previous.nonce IS NOT NULL
       AND previous.state='replaced' AND previous.replaced_by_effect_id=effect.effect_id
       AND effect.nonce=previous.nonce AND effect.effect_kind=previous.effect_kind
       AND effect.chain_id=previous.chain_id AND effect.signer_address=previous.signer_address
       AND effect.target_address=previous.target_address AND effect.value_wei=previous.value_wei
       AND effect.reserved_amount_atomic=previous.reserved_amount_atomic
  );
$$;
CREATE TRIGGER reward_effect_admission_guard BEFORE INSERT ON reward_chain_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_effect_admission_v2();
CREATE TRIGGER reward_effect_nonce_admission_guard BEFORE UPDATE OF nonce ON reward_chain_effects
FOR EACH ROW WHEN (OLD.nonce IS NULL AND NEW.nonce IS NOT NULL)
EXECUTE FUNCTION guard_reward_effect_admission_v2();

-- A fee replacement preserves the predecessor's actual transaction intent.
-- Admission metadata alone cannot freeze an ERC20 recipient/amount or Jackpot
-- parameters. Recheck when bytes are assigned, after nonce admission as well.
CREATE FUNCTION guard_reward_replacement_preparation_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE previous_record reward_chain_effects%ROWTYPE;
BEGIN
  SELECT * INTO previous_record FROM reward_chain_effects
   WHERE effect_id=NEW.replacement_of_effect_id FOR SHARE;
  IF NOT FOUND OR previous_record.state <> 'replaced'
     OR previous_record.replaced_by_effect_id IS DISTINCT FROM NEW.effect_id
     OR previous_record.nonce IS NULL OR NEW.nonce IS DISTINCT FROM previous_record.nonce
     OR previous_record.calldata IS NULL OR previous_record.calldata_hash IS NULL
     OR previous_record.signed_transaction IS NULL OR previous_record.signed_transaction_hash IS NULL
     OR NEW.signed_transaction IS NULL OR NEW.signed_transaction_hash IS NULL
     OR NEW.calldata IS DISTINCT FROM previous_record.calldata
     OR NEW.calldata_hash IS DISTINCT FROM previous_record.calldata_hash THEN
    RAISE EXCEPTION 'reward replacement transaction intent refused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_replacement_preparation_guard BEFORE INSERT OR UPDATE ON reward_chain_effects
FOR EACH ROW WHEN (NEW.replacement_of_effect_id IS NOT NULL AND
  (NEW.calldata IS NOT NULL OR NEW.calldata_hash IS NOT NULL
   OR NEW.signed_transaction IS NOT NULL OR NEW.signed_transaction_hash IS NOT NULL
   OR NEW.state IN ('prepared','broadcast_pending','confirming','confirmed','reverted',
     'replaced','reconciliation_required')))
EXECUTE FUNCTION guard_reward_replacement_preparation_v2();

-- Existing detail guards validate solvency, custody, amounts, state and lineage.
-- The deferred checks below require those guarded detail rows to actually exist.
CREATE FUNCTION reward_effect_is_settlement_v2(effect_id_input TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM reward_chain_effects effect
     WHERE effect.effect_id=effect_id_input AND effect.nonce IS NOT NULL AND (
       (effect.effect_kind='reward_refund' AND EXISTS (
         SELECT 1 FROM reward_refund_effects refund
         JOIN song_reward_leg_funding_effects funding
           ON funding.funding_effect_id=refund.funding_effect_id AND funding.state='confirmed'
          AND funding.leg_id=refund.leg_id
         WHERE refund.refund_effect_id=effect.effect_id
       )) OR
       (effect.effect_kind='reward_payout' AND EXISTS (
         SELECT 1 FROM reward_payout_effects payout
         JOIN reward_ledger_credits credit ON credit.credit_id=payout.credit_id
         WHERE payout.payout_effect_id=effect.effect_id
       )) OR
       (effect.effect_kind='winnings_claim' AND EXISTS (
         SELECT 1 FROM megapot_claim_effects claim
         JOIN megapot_ticket_inventory ticket
           ON ticket.attestation_id=claim.attestation_id AND ticket.ticket_id=claim.ticket_id
         JOIN reward_chain_effects purchase
           ON purchase.effect_id=ticket.purchase_effect_id
          AND purchase.effect_kind='ticket_purchase' AND purchase.state='confirmed'
         WHERE claim.claim_effect_id=effect.effect_id
       ))
     )
  );
$$;

-- Repositories update the nonce first and add the guarded effect/detail later.
-- A generic nonce increment in settling cannot commit without that exact pair.
CREATE FUNCTION validate_reward_settling_nonce_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.next_nonce=OLD.next_nonce THEN RETURN NULL; END IF;
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR SHARE;
  IF FOUND AND control_record.state='running' AND NOT control_record.paused THEN RETURN NULL; END IF;
  IF FOUND AND control_record.state='settling' AND control_record.paused AND EXISTS (
    SELECT 1 FROM reward_chain_effects effect
     WHERE effect.chain_id=NEW.chain_id AND effect.signer_address=NEW.signer_address
       AND effect.nonce=NEW.next_nonce-1 AND reward_effect_is_settlement_v2(effect.effect_id)
  ) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'reward operations reservation refused' USING ERRCODE='PR001';
END
$$;
CREATE CONSTRAINT TRIGGER reward_settling_nonce_pair
AFTER INSERT OR UPDATE ON reward_signer_nonces DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_reward_settling_nonce_v2();

CREATE FUNCTION validate_reward_settling_effect_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE control_record reward_operations_control%ROWTYPE;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR SHARE;
  IF FOUND AND control_record.state='running' AND NOT control_record.paused THEN RETURN NULL; END IF;
  IF reward_effect_is_admitted_replacement_v2(NEW.effect_id) THEN RETURN NULL; END IF;
  IF FOUND AND control_record.state='settling' AND control_record.paused
     AND reward_effect_is_settlement_v2(NEW.effect_id) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'reward operations settlement detail refused' USING ERRCODE='PR001';
END
$$;
CREATE CONSTRAINT TRIGGER reward_settling_effect_pair
AFTER INSERT ON reward_chain_effects DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_reward_settling_effect_v2();
CREATE CONSTRAINT TRIGGER reward_settling_effect_nonce_pair
AFTER UPDATE ON reward_chain_effects DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.nonce IS NULL AND NEW.nonce IS NOT NULL)
EXECUTE FUNCTION validate_reward_settling_effect_v2();

-- New functions must not inherit broad default EXECUTE. Only the read/lock
-- predicate is granted to existing control readers; settling operator authority
-- requires a separately reviewed dedicated-role grant.
DO $settling_permissions$
DECLARE function_name TEXT; role_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'set_reward_operations_state_v2(bigint,text,text)',
    'reward_operations_running_v2()', 'guard_reward_effect_admission_v2()',
    'reward_effect_is_settlement_v2(text)', 'validate_reward_settling_nonce_v2()',
    'validate_reward_settling_effect_v2()', 'reward_effect_is_admitted_replacement_v2(text)',
    'guard_reward_replacement_preparation_v2()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_name);
    FOR role_name IN
      SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=to_regprocedure(function_name) AND a.grantee <> 0 AND a.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',function_name,role_name);
    END LOOP;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',function_name,current_schema());
  END LOOP;
  -- CREATE OR REPLACE resets function-local configuration. Preserve the trusted
  -- schema pin on replaced routines without changing their existing ACLs.
  FOREACH function_name IN ARRAY ARRAY[
    'guard_reward_operations_control()',
    'set_reward_operations_paused_v1(bigint,boolean,text)',
    'guard_reward_http_admission()', 'guard_reward_signer_nonce()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',function_name,current_schema());
  END LOOP;
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='reward_operations_control'::regclass AND a.privilege_type='SELECT'
      AND a.grantee <> 0 AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION reward_operations_running_v2() TO %I',role_name);
  END LOOP;
END;
$settling_permissions$;
