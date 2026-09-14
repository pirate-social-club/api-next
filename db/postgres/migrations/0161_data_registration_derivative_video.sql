-- Spec 008 section 3A: a terms-bearing confirmation retains what a child
-- consumes, and a song-reference video resolves its parent only from that
-- confirmed row, never from the chain and never by substitution.

-- 1. Attached terms evidence. A song registers with the PIL terms it attaches;
-- its confirmed row keeps the template, the terms id, the preset and share the
-- terms were built from, and the coordinates of the attaching event. Videos
-- attach no terms. Rows confirmed before this evidence existed keep none, and a
-- child cannot resolve against them.
ALTER TABLE data_registration_operations
  ADD COLUMN attached_license_template TEXT CHECK (
    attached_license_template IS NULL OR attached_license_template ~ '^0x[0-9a-f]{40}$'
  ),
  ADD COLUMN attached_license_terms_id TEXT CHECK (
    attached_license_terms_id IS NULL OR attached_license_terms_id ~ '^[1-9][0-9]{0,77}$'
  ),
  ADD COLUMN attached_license_preset TEXT CHECK (
    attached_license_preset IS NULL
    OR attached_license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
  ),
  ADD COLUMN attached_commercial_rev_share_bps INTEGER CHECK (
    attached_commercial_rev_share_bps IS NULL
    OR (attached_commercial_rev_share_bps >= 0 AND attached_commercial_rev_share_bps <= 10000)
  ),
  ADD COLUMN terms_attachment_transaction_hash TEXT CHECK (
    terms_attachment_transaction_hash IS NULL
    OR terms_attachment_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  ADD COLUMN terms_attachment_block_number BIGINT CHECK (
    terms_attachment_block_number IS NULL OR terms_attachment_block_number >= 0
  ),
  ADD COLUMN terms_attachment_block_hash TEXT CHECK (
    terms_attachment_block_hash IS NULL OR terms_attachment_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  ADD COLUMN terms_attachment_log_index INTEGER CHECK (
    terms_attachment_log_index IS NULL OR terms_attachment_log_index >= 0
  ),
  ADD CONSTRAINT data_registration_attached_license_shape CHECK (
    (attached_license_template IS NULL AND attached_license_terms_id IS NULL
      AND attached_license_preset IS NULL AND attached_commercial_rev_share_bps IS NULL
      AND terms_attachment_transaction_hash IS NULL AND terms_attachment_block_number IS NULL
      AND terms_attachment_block_hash IS NULL AND terms_attachment_log_index IS NULL)
    OR (state = 'registered' AND media_kind = 'song'
      AND attached_license_template IS NOT NULL AND attached_license_terms_id IS NOT NULL
      AND attached_license_preset IS NOT NULL
      AND terms_attachment_transaction_hash IS NOT NULL
      AND terms_attachment_block_number IS NOT NULL
      AND terms_attachment_block_hash IS NOT NULL
      AND terms_attachment_log_index IS NOT NULL
      -- The share exists exactly under the commercial-remix preset.
      AND (attached_license_preset = 'commercial-remix')
        = (attached_commercial_rev_share_bps IS NOT NULL))
  );

-- 2. A derivative waits for its parent in its own state, and the parent's
-- outcomes that end a child are named.
ALTER TABLE data_registration_operations
  DROP CONSTRAINT data_registration_operations_state_check,
  ADD CONSTRAINT data_registration_operations_state_check CHECK (state IN (
    'pending', 'waiting_parent', 'signing', 'broadcast', 'confirming', 'registered',
    'failed', 'reconciliation_required'
  ));
ALTER TABLE data_registration_operations
  DROP CONSTRAINT data_registration_operations_failure_code_check,
  ADD CONSTRAINT data_registration_operations_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'pin_verification_failed', 'signing_failed', 'broadcast_failed',
      'receipt_reverted', 'confirmation_timeout', 'chain_reorganization',
      'invalid_receipt', 'configuration_invalid',
      'parent_registration_failed', 'parent_license_mismatch',
      'parent_derivatives_not_permitted', 'parent_terms_unrecorded'
    )
  );

CREATE OR REPLACE FUNCTION guard_data_registration_operation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration operation cannot be deleted';
  END IF;
  IF ROW(
    NEW.registration_operation_id, NEW.community_id, NEW.actor_user_id,
    NEW.submission_id, NEW.media_operation_id, NEW.post_id, NEW.asset_id,
    NEW.chain_id, NEW.registration_revision, NEW.publication_creation_revision,
    NEW.publication_audio_revision, NEW.publication_analysis_revision,
    NEW.publication_decision_revision, NEW.canonical_audio_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.registration_operation_id, OLD.community_id, OLD.actor_user_id,
    OLD.submission_id, OLD.media_operation_id, OLD.post_id, OLD.asset_id,
    OLD.chain_id, OLD.registration_revision, OLD.publication_creation_revision,
    OLD.publication_audio_revision, OLD.publication_analysis_revision,
    OLD.publication_decision_revision, OLD.canonical_audio_sha256,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'DATA registration operation identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'DATA registration operation timestamp must advance';
  END IF;
  -- Terms evidence is written with a registration and cleared only when the
  -- registration itself is withdrawn; nothing else may rewrite it.
  IF ROW(
    NEW.attached_license_template, NEW.attached_license_terms_id,
    NEW.attached_license_preset, NEW.attached_commercial_rev_share_bps,
    NEW.terms_attachment_transaction_hash, NEW.terms_attachment_block_number,
    NEW.terms_attachment_block_hash, NEW.terms_attachment_log_index
  ) IS DISTINCT FROM ROW(
    OLD.attached_license_template, OLD.attached_license_terms_id,
    OLD.attached_license_preset, OLD.attached_commercial_rev_share_bps,
    OLD.terms_attachment_transaction_hash, OLD.terms_attachment_block_number,
    OLD.terms_attachment_block_hash, OLD.terms_attachment_log_index
  ) AND NOT (
    (OLD.state <> 'registered' AND NEW.state = 'registered')
    OR (OLD.state = 'registered' AND NEW.state <> 'registered')
  ) THEN
    RAISE EXCEPTION 'DATA attached terms evidence changes only with registration';
  END IF;
  IF NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision
     OR NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id THEN
    IF OLD.state = 'registered'
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision + 1
       OR NEW.workflow_instance_id IS DISTINCT FROM
          'data-registration-workflow:' || NEW.registration_operation_id || ':r' || NEW.workflow_revision::text
       OR ROW(
         NEW.state, NEW.current_attempt_id, NEW.registered_ip_id,
         NEW.confirmed_transaction_hash, NEW.confirmed_block_number,
         NEW.confirmed_block_hash, NEW.confirmed_log_index, NEW.confirmed_at,
         NEW.failure_code, NEW.failure_evidence_ref
       ) IS DISTINCT FROM ROW(
         OLD.state, OLD.current_attempt_id, OLD.registered_ip_id,
         OLD.confirmed_transaction_hash, OLD.confirmed_block_number,
         OLD.confirmed_block_hash, OLD.confirmed_log_index, OLD.confirmed_at,
         OLD.failure_code, OLD.failure_evidence_ref
       ) THEN
      RAISE EXCEPTION 'DATA registration workflow replacement is invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('signing', 'failed', 'waiting_parent'))
    OR (OLD.state = 'waiting_parent' AND NEW.state IN ('pending', 'failed'))
    OR (OLD.state = 'signing' AND NEW.state IN (
      'broadcast', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'broadcast' AND NEW.state IN (
      'signing', 'confirming', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirming' AND NEW.state IN (
      'signing', 'broadcast', 'registered', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'signing', 'broadcast', 'confirming', 'registered', 'failed'
    ))
    OR (OLD.state = 'failed' AND NEW.state = 'registered')
    OR (OLD.state = 'registered' AND NEW.state IN ('failed', 'reconciliation_required'))
  ) THEN
    RAISE EXCEPTION 'invalid DATA registration operation transition';
  END IF;
  -- Only a derivative waits on a parent.
  IF NEW.state = 'waiting_parent' AND NEW.rights_basis <> 'derivative' THEN
    RAISE EXCEPTION 'only a derivative DATA registration waits for its parent';
  END IF;
  -- A song registers only with the terms it attached.
  IF NEW.state = 'registered' AND OLD.state <> 'registered'
     AND NEW.media_kind = 'song' AND NEW.attached_license_terms_id IS NULL THEN
    RAISE EXCEPTION 'a song DATA registration confirms only with its attached terms';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Parent resolution: append-only evidence recorded once when the parent
-- confirms, bound to the child's frozen reference and to the parent's exact
-- confirmed row. A later parent revision never rewrites it.
ALTER TABLE data_registration_parent_references
  ADD CONSTRAINT data_registration_parent_reference_pair
  UNIQUE (registration_operation_id, parent_registration_operation_id);

CREATE TABLE data_registration_parent_resolutions (
  registration_operation_id TEXT PRIMARY KEY,
  parent_registration_operation_id TEXT NOT NULL,
  parent_registration_revision BIGINT NOT NULL CHECK (parent_registration_revision >= 1),
  parent_ip_id TEXT NOT NULL CHECK (parent_ip_id ~ '^0x[0-9a-f]{40}$'),
  license_template TEXT NOT NULL CHECK (license_template ~ '^0x[0-9a-f]{40}$'),
  license_terms_id TEXT NOT NULL CHECK (license_terms_id ~ '^[1-9][0-9]{0,77}$'),
  license_preset TEXT NOT NULL CHECK (
    license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
  ),
  commercial_rev_share_bps INTEGER CHECK (
    commercial_rev_share_bps IS NULL
    OR (commercial_rev_share_bps >= 0 AND commercial_rev_share_bps <= 10000)
  ),
  parent_registration_transaction_hash TEXT NOT NULL
    CHECK (parent_registration_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  parent_registration_block_number BIGINT NOT NULL
    CHECK (parent_registration_block_number >= 0),
  parent_registration_block_hash TEXT NOT NULL
    CHECK (parent_registration_block_hash ~ '^0x[0-9a-f]{64}$'),
  parent_registration_log_index INTEGER NOT NULL CHECK (parent_registration_log_index >= 0),
  terms_attachment_transaction_hash TEXT NOT NULL
    CHECK (terms_attachment_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  terms_attachment_block_number BIGINT NOT NULL CHECK (terms_attachment_block_number >= 0),
  terms_attachment_block_hash TEXT NOT NULL
    CHECK (terms_attachment_block_hash ~ '^0x[0-9a-f]{64}$'),
  terms_attachment_log_index INTEGER NOT NULL CHECK (terms_attachment_log_index >= 0),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(resolved_at)),
  FOREIGN KEY (registration_operation_id, parent_registration_operation_id)
    REFERENCES data_registration_parent_references
      (registration_operation_id, parent_registration_operation_id) ON DELETE RESTRICT,
  CONSTRAINT data_registration_parent_resolution_license_shape CHECK (
    (license_preset = 'commercial-remix') = (commercial_rev_share_bps IS NOT NULL)
  )
);

CREATE TRIGGER data_registration_parent_resolutions_append_only
  BEFORE UPDATE OR DELETE ON data_registration_parent_resolutions
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();

-- The resolution restates the parent's confirmed row and the child's expected
-- license exactly; a mismatch is a failure the interpreter records instead.
CREATE FUNCTION require_data_registration_parent_resolution_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  child_state TEXT;
BEGIN
  SELECT state INTO child_state FROM data_registration_operations
   WHERE registration_operation_id = NEW.registration_operation_id
     AND media_kind = 'video' AND rights_basis = 'derivative'
   FOR UPDATE;
  IF child_state IS NULL OR child_state NOT IN ('pending', 'waiting_parent') THEN
    RAISE EXCEPTION 'a DATA parent resolution needs a derivative video awaiting it';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM data_registration_operations parent
     WHERE parent.registration_operation_id = NEW.parent_registration_operation_id
       AND parent.state = 'registered'
       AND parent.media_kind = 'song'
       AND parent.registration_revision = NEW.parent_registration_revision
       AND parent.registered_ip_id = NEW.parent_ip_id
       AND parent.confirmed_transaction_hash = NEW.parent_registration_transaction_hash
       AND parent.confirmed_block_number = NEW.parent_registration_block_number
       AND parent.confirmed_block_hash = NEW.parent_registration_block_hash
       AND parent.confirmed_log_index = NEW.parent_registration_log_index
       AND parent.attached_license_template = NEW.license_template
       AND parent.attached_license_terms_id = NEW.license_terms_id
       AND parent.attached_license_preset = NEW.license_preset
       AND parent.attached_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.commercial_rev_share_bps
       AND parent.terms_attachment_transaction_hash = NEW.terms_attachment_transaction_hash
       AND parent.terms_attachment_block_number = NEW.terms_attachment_block_number
       AND parent.terms_attachment_block_hash = NEW.terms_attachment_block_hash
       AND parent.terms_attachment_log_index = NEW.terms_attachment_log_index
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'a DATA parent resolution must restate the parent''s confirmed row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM data_registration_parent_references reference
     WHERE reference.registration_operation_id = NEW.registration_operation_id
       AND reference.parent_registration_operation_id = NEW.parent_registration_operation_id
       AND reference.expected_parent_license_preset = NEW.license_preset
       AND reference.expected_parent_commercial_rev_share_bps
         IS NOT DISTINCT FROM NEW.commercial_rev_share_bps
  ) THEN
    RAISE EXCEPTION 'a DATA parent resolution must consume the expected parent license';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_parent_resolution_evidence
  BEFORE INSERT ON data_registration_parent_resolutions
  FOR EACH ROW EXECUTE FUNCTION require_data_registration_parent_resolution_evidence();

-- 4. A derivative video never reaches signing before it has resolved its
-- parent: the attempt's calldata names the parent's IP and consumed terms.
CREATE FUNCTION require_data_registration_attempt_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_registration_operations operation
     WHERE operation.registration_operation_id = NEW.registration_operation_id
       AND operation.media_kind = 'video' AND operation.rights_basis = 'derivative'
  ) AND NOT EXISTS (
    SELECT 1 FROM data_registration_parent_resolutions resolution
     WHERE resolution.registration_operation_id = NEW.registration_operation_id
  ) THEN
    RAISE EXCEPTION 'a derivative DATA registration signs only after its parent resolves';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_attempt_parent
  BEFORE INSERT ON data_registration_signing_attempts
  FOR EACH ROW EXECUTE FUNCTION require_data_registration_attempt_parent();
