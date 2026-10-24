-- Owner-executed Safe custody for the ticket-first pilot. Pirate prepares one call
-- and the workspace_owner executes it in Safe{Wallet}. A Safe effect never stores
-- signed bytes or reserves an EOA nonce. Reconciliation records the Safe nonce, the
-- Safe EIP-712 hash, the executing owner and the outer transaction separately once
-- it finds the execution. Existing EOA effects keep their exact shapes.

-- A Safe custody address still needs its nonce-authority row because every effect
-- references (chain_id, signer_address). The row is never advanced by EOA nonce
-- reservation; its kind keeps the two authorities from being mixed.
ALTER TABLE reward_signer_nonces
  ADD COLUMN nonce_authority TEXT NOT NULL DEFAULT 'eoa_pending_nonce'
    CHECK (nonce_authority IN ('eoa_pending_nonce', 'safe_owner_v1'));

ALTER TABLE reward_chain_effects
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'eoa'
    CHECK (execution_mode IN ('eoa', 'safe_owner_v1')),
  ADD COLUMN safe_nonce NUMERIC(78, 0) CHECK (safe_nonce IS NULL OR safe_nonce >= 0),
  ADD COLUMN safe_transaction_hash TEXT CHECK (
    safe_transaction_hash IS NULL OR safe_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  ADD COLUMN safe_executor_address TEXT CHECK (
    safe_executor_address IS NULL OR safe_executor_address ~ '^0x[0-9a-f]{40}$'
  ),
  ADD COLUMN safe_execution_outcome TEXT CHECK (
    safe_execution_outcome IS NULL OR safe_execution_outcome IN ('success', 'failure')
  ),
  ADD COLUMN safe_execution_log_index INTEGER CHECK (
    safe_execution_log_index IS NULL OR safe_execution_log_index >= 0
  ),
  -- The chain head when the call was prepared. An execution in an earlier block
  -- cannot be this call, however identical its content.
  ADD COLUMN safe_prepared_block_number BIGINT CHECK (
    safe_prepared_block_number IS NULL OR safe_prepared_block_number >= 0
  );

-- The EOA branch is the 0055 expression unchanged. A Safe effect has no nonce or
-- signed bytes in any state, fixes its calldata once prepared, and gains its
-- execution evidence only when reconciliation finds a matching execution. A CHECK
-- passes when its expression is NULL and a regex on NULL is NULL, so the Safe
-- branch states IS NOT NULL explicitly wherever it also matches a pattern.
ALTER TABLE reward_chain_effects
  DROP CONSTRAINT reward_chain_effect_prepared_shape,
  ADD CONSTRAINT reward_chain_effect_prepared_shape CHECK (
    (execution_mode = 'eoa'
      AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
      AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
      AND safe_execution_log_index IS NULL AND safe_prepared_block_number IS NULL
      AND (
        (state = 'planned' AND nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
          AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
          AND transaction_hash IS NULL AND prepared_at IS NULL)
        OR (state = 'nonce_reserved' AND nonce IS NOT NULL AND calldata IS NULL
          AND calldata_hash IS NULL AND signed_transaction IS NULL
          AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
          AND prepared_at IS NULL)
        OR (state IN ('prepared', 'broadcast_pending', 'confirming', 'confirmed', 'reverted',
            'replaced', 'reconciliation_required')
          AND nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
          AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
          AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL)
        OR (state IN ('reclaimable_failed', 'terminal_failed')
          AND ((nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
              AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
              AND prepared_at IS NULL)
            OR (nonce IS NOT NULL AND calldata IS NULL AND calldata_hash IS NULL
              AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
              AND prepared_at IS NULL)
            OR (nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
              AND calldata_hash ~ '^[0-9a-f]{64}$'
              AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
              AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
              AND prepared_at IS NOT NULL)))))
    OR (execution_mode = 'safe_owner_v1'
      AND nonce IS NULL AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
      AND (
        (state IN ('planned', 'terminal_failed')
          AND calldata IS NULL AND calldata_hash IS NULL AND prepared_at IS NULL
          AND safe_prepared_block_number IS NULL
          AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
          AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
          AND safe_execution_log_index IS NULL)
        OR (state = 'prepared'
          AND calldata IS NOT NULL AND calldata ~ '^0x[0-9a-f]{8}([0-9a-f]{2})*$'
          AND calldata_hash IS NOT NULL AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL AND safe_prepared_block_number IS NOT NULL
          AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
          AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
          AND safe_execution_log_index IS NULL)
        OR (state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required')
          AND calldata IS NOT NULL AND calldata ~ '^0x[0-9a-f]{8}([0-9a-f]{2})*$'
          AND calldata_hash IS NOT NULL AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL AND safe_prepared_block_number IS NOT NULL
          AND safe_nonce IS NOT NULL AND safe_transaction_hash IS NOT NULL
          AND safe_executor_address IS NOT NULL AND safe_execution_outcome IS NOT NULL
          AND safe_execution_log_index IS NOT NULL)))
  );

-- A Safe ExecutionFailure is a successful outer transaction whose inner call did not
-- run. It is recorded as reverted with the outer receipt status kept truthful.
ALTER TABLE reward_chain_effects
  DROP CONSTRAINT reward_chain_effect_receipt_shape,
  ADD CONSTRAINT reward_chain_effect_receipt_shape CHECK (
    (state NOT IN ('confirmed', 'reverted') AND receipt_status IS NULL
      AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_hash IS NULL AND confirmations IS NULL AND confirmed_at IS NULL)
    OR (state = 'confirmed' AND receipt_status = 'success'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NOT NULL
      AND (execution_mode = 'eoa' OR safe_execution_outcome = 'success'))
    OR (state = 'reverted' AND execution_mode = 'eoa' AND receipt_status = 'reverted'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NULL)
    OR (state = 'reverted' AND execution_mode = 'safe_owner_v1'
      AND receipt_status = 'success' AND safe_execution_outcome = 'failure'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NULL)
  );

-- One Safe nonce executes one transaction, and one execution settles one effect.
CREATE UNIQUE INDEX reward_chain_effects_safe_nonce_unique
  ON reward_chain_effects (chain_id, signer_address, safe_nonce)
  WHERE safe_nonce IS NOT NULL;
CREATE UNIQUE INDEX reward_chain_effects_safe_transaction_hash_unique
  ON reward_chain_effects (chain_id, safe_transaction_hash)
  WHERE safe_transaction_hash IS NOT NULL;
-- Reconciliation binds executions by content, so unresolved Safe calls with the
-- same target and calldata would be indistinguishable. A repeat must wait.
CREATE UNIQUE INDEX reward_chain_effects_safe_open_call_unique
  ON reward_chain_effects (chain_id, signer_address, target_address, calldata_hash)
  WHERE execution_mode = 'safe_owner_v1'
    AND state IN ('prepared', 'confirming', 'reconciliation_required');

CREATE OR REPLACE FUNCTION guard_reward_chain_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_record reward_chain_effects%ROWTYPE;
  authority TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward chain effects cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' THEN
      RAISE EXCEPTION 'reward chain effect must begin planned';
    END IF;
    SELECT nonce_authority INTO authority FROM reward_signer_nonces
     WHERE chain_id = NEW.chain_id AND signer_address = NEW.signer_address FOR SHARE;
    IF authority IS DISTINCT FROM (CASE NEW.execution_mode
         WHEN 'safe_owner_v1' THEN 'safe_owner_v1' ELSE 'eoa_pending_nonce' END) THEN
      RAISE EXCEPTION 'reward chain effect execution mode does not match its signer';
    END IF;
    IF NEW.replacement_of_effect_id IS NOT NULL THEN
      IF NEW.execution_mode <> 'eoa' THEN
        RAISE EXCEPTION 'Safe reward effects are never replacements';
      END IF;
      SELECT * INTO previous_record FROM reward_chain_effects
       WHERE effect_id = NEW.replacement_of_effect_id FOR UPDATE;
      IF previous_record.effect_id IS NULL OR previous_record.state <> 'replaced'
         OR previous_record.replaced_by_effect_id <> NEW.effect_id
         OR previous_record.effect_kind <> NEW.effect_kind
         OR previous_record.chain_id <> NEW.chain_id
         OR previous_record.signer_address <> NEW.signer_address
         OR previous_record.target_address <> NEW.target_address
         OR previous_record.value_wei <> NEW.value_wei
         OR previous_record.reserved_amount_atomic <> NEW.reserved_amount_atomic THEN
        RAISE EXCEPTION 'reward replacement effect identity is invalid';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.effect_id, NEW.effect_kind, NEW.chain_id, NEW.signer_address,
    NEW.target_address, NEW.value_wei, NEW.reserved_amount_atomic,
    NEW.replacement_of_effect_id, NEW.created_at, NEW.execution_mode
  ) IS DISTINCT FROM ROW(
    OLD.effect_id, OLD.effect_kind, OLD.chain_id, OLD.signer_address,
    OLD.target_address, OLD.value_wei, OLD.reserved_amount_atomic,
    OLD.replacement_of_effect_id, OLD.created_at, OLD.execution_mode
  ) THEN
    RAISE EXCEPTION 'reward chain effect identity is immutable';
  END IF;
  IF OLD.signed_transaction IS NOT NULL AND ROW(
    NEW.nonce, NEW.calldata, NEW.calldata_hash,
    NEW.signed_transaction, NEW.signed_transaction_hash
  ) IS DISTINCT FROM ROW(
    OLD.nonce, OLD.calldata, OLD.calldata_hash,
    OLD.signed_transaction, OLD.signed_transaction_hash
  ) THEN
    RAISE EXCEPTION 'prepared reward transaction bytes are immutable';
  END IF;
  IF OLD.execution_mode = 'safe_owner_v1' AND OLD.prepared_at IS NOT NULL AND ROW(
    NEW.calldata, NEW.calldata_hash, NEW.prepared_at, NEW.safe_prepared_block_number
  ) IS DISTINCT FROM ROW(
    OLD.calldata, OLD.calldata_hash, OLD.prepared_at, OLD.safe_prepared_block_number
  ) THEN
    RAISE EXCEPTION 'prepared Safe reward call is immutable';
  END IF;
  IF OLD.safe_transaction_hash IS NOT NULL AND ROW(
    NEW.safe_nonce, NEW.safe_transaction_hash, NEW.safe_executor_address,
    NEW.safe_execution_outcome, NEW.safe_execution_log_index, NEW.transaction_hash
  ) IS DISTINCT FROM ROW(
    OLD.safe_nonce, OLD.safe_transaction_hash, OLD.safe_executor_address,
    OLD.safe_execution_outcome, OLD.safe_execution_log_index, OLD.transaction_hash
  ) THEN
    RAISE EXCEPTION 'observed Safe execution is immutable';
  END IF;
  IF NEW.version = OLD.version THEN
    IF ROW(
      NEW.state, NEW.settled_amount_atomic, NEW.nonce, NEW.calldata, NEW.calldata_hash,
      NEW.signed_transaction, NEW.signed_transaction_hash, NEW.transaction_hash,
      NEW.replaced_by_effect_id, NEW.receipt_status, NEW.receipt_block_number,
      NEW.receipt_block_hash, NEW.receipt_hash, NEW.confirmations,
      NEW.failure_class, NEW.failure_reason, NEW.prepared_at,
      NEW.broadcast_at, NEW.confirmed_at, NEW.safe_nonce, NEW.safe_transaction_hash,
      NEW.safe_executor_address, NEW.safe_execution_outcome, NEW.safe_execution_log_index,
      NEW.safe_prepared_block_number
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.settled_amount_atomic, OLD.nonce, OLD.calldata, OLD.calldata_hash,
      OLD.signed_transaction, OLD.signed_transaction_hash, OLD.transaction_hash,
      OLD.replaced_by_effect_id, OLD.receipt_status, OLD.receipt_block_number,
      OLD.receipt_block_hash, OLD.receipt_hash, OLD.confirmations,
      OLD.failure_class, OLD.failure_reason, OLD.prepared_at,
      OLD.broadcast_at, OLD.confirmed_at, OLD.safe_nonce, OLD.safe_transaction_hash,
      OLD.safe_executor_address, OLD.safe_execution_outcome, OLD.safe_execution_log_index,
      OLD.safe_prepared_block_number
    ) THEN
      RAISE EXCEPTION 'reward chain state change requires next version';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'reward chain transition requires next version and time';
  END IF;
  IF OLD.execution_mode = 'safe_owner_v1' THEN
    -- A prepared Safe call can still execute later, so nothing Pirate does alone
    -- may end it. Only an observed execution moves it forward.
    IF NOT (
      (OLD.state = 'planned' AND NEW.state IN ('prepared', 'terminal_failed'))
      OR (OLD.state = 'prepared' AND NEW.state IN (
        'confirming', 'confirmed', 'reverted', 'reconciliation_required'
      ))
      OR (OLD.state = 'confirming' AND NEW.state IN (
        'confirmed', 'reverted', 'reconciliation_required'
      ))
      OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
        'confirming', 'confirmed', 'reverted'
      ))
    ) THEN
      RAISE EXCEPTION 'invalid Safe reward chain effect transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'planned' AND NEW.state IN ('nonce_reserved', 'reclaimable_failed', 'terminal_failed'))
    OR (OLD.state = 'nonce_reserved' AND NEW.state IN ('prepared', 'reclaimable_failed', 'terminal_failed'))
    OR (OLD.state = 'prepared' AND NEW.state IN (
      'broadcast_pending', 'reclaimable_failed', 'terminal_failed'
    ))
    OR (OLD.state = 'broadcast_pending' AND NEW.state IN (
      'confirming', 'confirmed', 'reverted', 'replaced', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirming' AND NEW.state IN (
      'confirmed', 'reverted', 'replaced', 'reconciliation_required'
    ))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'confirming', 'confirmed', 'reverted', 'replaced', 'terminal_failed'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid reward chain effect transition';
  END IF;
  RETURN NEW;
END
$$;

-- Preparing a Safe call signs nothing, but a paused system must not hand the owner
-- new calls to execute. Later transitions only record what the chain did.
CREATE FUNCTION guard_reward_safe_call_preparation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  operations_paused BOOLEAN;
BEGIN
  SELECT paused INTO operations_paused FROM reward_operations_control
   WHERE singleton FOR SHARE;
  IF NOT FOUND OR operations_paused IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
DO $safe_preparation_guard_permissions$
DECLARE
  role_name TEXT;
BEGIN
  REVOKE ALL ON FUNCTION guard_reward_safe_call_preparation() FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'guard_reward_safe_call_preparation()'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION guard_reward_safe_call_preparation() FROM %I', role_name);
  END LOOP;
  EXECUTE format(
    'ALTER FUNCTION guard_reward_safe_call_preparation() SET search_path TO %I, pg_temp',
    current_schema()
  );
END
$safe_preparation_guard_permissions$;
CREATE TRIGGER reward_safe_call_preparation_guard BEFORE UPDATE ON reward_chain_effects
FOR EACH ROW WHEN (
  OLD.execution_mode = 'safe_owner_v1' AND OLD.state = 'planned' AND NEW.state = 'prepared'
)
EXECUTE FUNCTION guard_reward_safe_call_preparation();
