-- An already-owned Spaces root becomes the address of one never-bound community.
-- The ceremony is a Spaces-specific sibling of the HNS route attachment: start
-- stores an independent ownership observation and a route-only challenge, prove
-- stores the owner signature and a second observation, and commit writes typed
-- route evidence and exactly one active binding. Evidence carries a database
-- lease; the existing effective-route predicates refuse it once it has expired.
-- The same ceremony, with a distinct purpose, re-proves ownership for a binding
-- that stopped resolving. It keeps the one immutable binding and never rebinds.
CREATE TABLE spaces_community_route_attachments (
  attachment_intent_id text PRIMARY KEY CHECK (attachment_intent_id ~ '^sroute_[0-9a-f]{32}$'),
  ceremony_intent_id text NOT NULL UNIQUE CHECK (ceremony_intent_id ~ '^srcer_[0-9a-f]{32}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  canonical_root text NOT NULL CHECK (is_community_route_root_label('spaces', canonical_root) IS TRUE),
  community_id text NOT NULL REFERENCES communities(community_id),
  account_id text NOT NULL REFERENCES users(user_id),
  purpose text NOT NULL CHECK (purpose IN ('first_attachment','revalidation')),
  target_route_binding_id text REFERENCES community_canonical_route_bindings(route_binding_id),
  expected_binding_generation bigint CHECK (expected_binding_generation > 0),
  start_idempotency_key text NOT NULL CHECK (octet_length(start_idempotency_key) BETWEEN 1 AND 255),
  start_request_hash text NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  nonce_hex text NOT NULL CHECK (nonce_hex ~ '^[0-9a-f]{64}$'),
  root_outpoint text NOT NULL CHECK (root_outpoint ~ '^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$'),
  root_key_hex text NOT NULL CHECK (root_key_hex ~ '^[0-9a-f]{64}$'),
  public_origin text NOT NULL CHECK (public_origin ~ '^https://[a-z0-9.-]{1,253}$'),
  canonical_href text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id = 'spaces.root-route.v1'),
  provider_configuration_digest text NOT NULL CHECK (provider_configuration_digest ~ '^[0-9a-f]{64}$'),
  requirement_hash text NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  challenge_message text NOT NULL CHECK (octet_length(challenge_message) BETWEEN 1 AND 4096),
  challenge_digest_hex text NOT NULL CHECK (challenge_digest_hex ~ '^[0-9a-f]{64}$'),
  start_observation bytea NOT NULL CHECK (octet_length(start_observation) BETWEEN 1 AND 1048576),
  start_observation_sha256_hex text NOT NULL CHECK (start_observation_sha256_hex ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'awaiting_signature','proved','committed','expired','root_changed','signature_rejected',
    'configuration_changed'
  )),
  signature_hex text CHECK (signature_hex ~ '^[0-9a-f]{128}$'),
  proof_observation bytea CHECK (octet_length(proof_observation) BETWEEN 1 AND 1048576),
  proof_observation_sha256_hex text CHECK (proof_observation_sha256_hex ~ '^[0-9a-f]{64}$'),
  proved_at timestamptz,
  route_binding_id text REFERENCES community_canonical_route_bindings(route_binding_id),
  evidence_ref text,
  committed_response jsonb,
  commit_observation bytea CHECK (octet_length(commit_observation) BETWEEN 1 AND 1048576),
  commit_observation_sha256_hex text CHECK (commit_observation_sha256_hex ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL,
  CONSTRAINT spaces_community_route_attachments_purpose_shape CHECK (
    (purpose = 'first_attachment' AND target_route_binding_id IS NULL
      AND expected_binding_generation IS NULL)
    OR (purpose = 'revalidation' AND target_route_binding_id IS NOT NULL
      AND expected_binding_generation IS NOT NULL)
  ),
  CONSTRAINT spaces_community_route_attachments_href CHECK (
    canonical_href = public_origin || '/c/@' || canonical_root
  ),
  CONSTRAINT spaces_community_route_attachments_time_order CHECK (
    expires_at > created_at AND updated_at >= created_at
    AND (proved_at IS NULL OR (proved_at >= created_at AND proved_at < expires_at))
  ),
  CONSTRAINT spaces_community_route_attachments_proof_shape CHECK (
    status NOT IN ('proved','committed') OR (
      signature_hex IS NOT NULL AND proof_observation IS NOT NULL
      AND proof_observation_sha256_hex IS NOT NULL AND proved_at IS NOT NULL
    )
  ),
  CONSTRAINT spaces_community_route_attachments_commit_shape CHECK (
    (status = 'committed') = (
      route_binding_id IS NOT NULL AND evidence_ref IS NOT NULL AND committed_response IS NOT NULL
      AND commit_observation IS NOT NULL AND commit_observation_sha256_hex IS NOT NULL
    )
  ),
  CONSTRAINT spaces_community_route_attachments_start_replay UNIQUE (
    account_id, community_id, start_idempotency_key
  ),
  CONSTRAINT spaces_community_route_attachments_root_generation UNIQUE (
    environment, canonical_root, generation
  )
);

-- One ceremony in flight per community and per root. A community and a root
-- are each first attached at most once; later commits only revalidate.
CREATE UNIQUE INDEX spaces_community_route_attachments_open_community_uidx
  ON spaces_community_route_attachments (community_id)
  WHERE status IN ('awaiting_signature','proved');
CREATE UNIQUE INDEX spaces_community_route_attachments_open_root_uidx
  ON spaces_community_route_attachments (environment, canonical_root)
  WHERE status IN ('awaiting_signature','proved');
CREATE UNIQUE INDEX spaces_community_route_attachments_committed_community_uidx
  ON spaces_community_route_attachments (community_id)
  WHERE status = 'committed' AND purpose = 'first_attachment';
CREATE UNIQUE INDEX spaces_community_route_attachments_committed_root_uidx
  ON spaces_community_route_attachments (environment, canonical_root)
  WHERE status = 'committed' AND purpose = 'first_attachment';

CREATE FUNCTION guard_spaces_community_route_attachment_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'spaces community route attachment is append-only';
  END IF;
  IF ROW(
    NEW.attachment_intent_id, NEW.ceremony_intent_id, NEW.generation, NEW.environment,
    NEW.canonical_root, NEW.community_id, NEW.account_id, NEW.purpose,
    NEW.target_route_binding_id, NEW.expected_binding_generation, NEW.start_idempotency_key,
    NEW.start_request_hash, NEW.nonce_hex, NEW.root_outpoint, NEW.root_key_hex,
    NEW.public_origin, NEW.canonical_href, NEW.provider_id, NEW.provider_configuration_digest,
    NEW.requirement_hash, NEW.challenge_message, NEW.challenge_digest_hex,
    NEW.start_observation, NEW.start_observation_sha256_hex, NEW.created_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.attachment_intent_id, OLD.ceremony_intent_id, OLD.generation, OLD.environment,
    OLD.canonical_root, OLD.community_id, OLD.account_id, OLD.purpose,
    OLD.target_route_binding_id, OLD.expected_binding_generation, OLD.start_idempotency_key,
    OLD.start_request_hash, OLD.nonce_hex, OLD.root_outpoint, OLD.root_key_hex,
    OLD.public_origin, OLD.canonical_href, OLD.provider_id, OLD.provider_configuration_digest,
    OLD.requirement_hash, OLD.challenge_message, OLD.challenge_digest_hex,
    OLD.start_observation, OLD.start_observation_sha256_hex, OLD.created_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'spaces community route challenge is immutable';
  END IF;
  -- A challenge moves forward only, and only while its lease is live by the
  -- database clock. Expiry itself may be recorded at any later time.
  IF NOT (
    (OLD.status = 'awaiting_signature' AND NEW.status IN (
      'proved','expired','root_changed','signature_rejected','configuration_changed'))
    OR (OLD.status = 'proved' AND NEW.status IN (
      'committed','expired','root_changed','configuration_changed'))
  ) THEN
    RAISE EXCEPTION 'spaces community route attachment transition is not allowed';
  END IF;
  IF NEW.status IN ('proved','committed') AND OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'spaces community route challenge has expired';
  END IF;
  IF OLD.status = 'proved' AND ROW(
    NEW.signature_hex, NEW.proof_observation, NEW.proof_observation_sha256_hex, NEW.proved_at
  ) IS DISTINCT FROM ROW(
    OLD.signature_hex, OLD.proof_observation, OLD.proof_observation_sha256_hex, OLD.proved_at
  ) AND NEW.status = 'committed' THEN
    RAISE EXCEPTION 'spaces community route proof is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_community_route_attachment_change_guard
  BEFORE UPDATE OR DELETE ON spaces_community_route_attachments
  FOR EACH ROW EXECUTE FUNCTION guard_spaces_community_route_attachment_change();

-- Scheduled re-observation of an active Spaces binding. A renewal extends the
-- lease with a new evidence row; an owner change suspends only that binding.
CREATE TABLE spaces_community_route_renewals (
  renewal_id text PRIMARY KEY CHECK (renewal_id ~ '^srenew_[0-9a-f]{32}$'),
  route_binding_id text NOT NULL REFERENCES community_canonical_route_bindings(route_binding_id),
  expected_binding_generation bigint NOT NULL CHECK (expected_binding_generation > 0),
  outcome text NOT NULL CHECK (outcome IN ('renewed','owner_changed')),
  root_outpoint text NOT NULL CHECK (root_outpoint ~ '^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$'),
  root_key_hex text NOT NULL CHECK (root_key_hex ~ '^[0-9a-f]{64}$'),
  observation bytea NOT NULL CHECK (octet_length(observation) BETWEEN 1 AND 1048576),
  observation_sha256_hex text NOT NULL CHECK (observation_sha256_hex ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  CONSTRAINT spaces_community_route_renewals_generation UNIQUE (
    route_binding_id, expected_binding_generation
  )
);

CREATE TRIGGER spaces_community_route_renewals_append_only
  BEFORE UPDATE OR DELETE ON spaces_community_route_renewals
  FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

ALTER TABLE community_route_ownership_evidence
  ADD COLUMN spaces_route_attachment_intent_id text,
  ADD COLUMN spaces_route_renewal_id text,
  ADD CONSTRAINT community_route_ownership_evidence_spaces_attachment_fk
    FOREIGN KEY (spaces_route_attachment_intent_id)
    REFERENCES spaces_community_route_attachments(attachment_intent_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_route_ownership_evidence_spaces_renewal_fk
    FOREIGN KEY (spaces_route_renewal_id)
    REFERENCES spaces_community_route_renewals(renewal_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX community_route_ownership_evidence_spaces_attachment_uidx
  ON community_route_ownership_evidence (spaces_route_attachment_intent_id)
  WHERE spaces_route_attachment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX community_route_ownership_evidence_spaces_renewal_uidx
  ON community_route_ownership_evidence (spaces_route_renewal_id)
  WHERE spaces_route_renewal_id IS NOT NULL;

-- Existing origins are unchanged and may not carry a Spaces reference. The two
-- Spaces origins always carry a lease, so they can never resolve indefinitely.
ALTER TABLE community_route_ownership_evidence
  DROP CONSTRAINT community_route_ownership_evidence_origin_shape_v2,
  ADD CONSTRAINT community_route_ownership_evidence_origin_shape_v3 CHECK (
    (origin = 'creation_ceremony' AND creation_ceremony_intent_id IS NOT NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NULL
      AND verified_by_actor_id IS NOT NULL)
    OR (origin = 'route_revalidation' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NOT NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NULL)
    OR (origin = 'active_lease_renewal' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NOT NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NULL
      AND verified_by_actor_id IS NULL AND family = 'hns')
    OR (origin = 'route_attachment' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NOT NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NULL
      AND verified_by_actor_id IS NOT NULL)
    OR (origin = 'operator_control_observation' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NOT NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NULL
      AND verified_by_actor_id IS NULL AND family = 'hns')
    OR (origin = 'spaces_route_attachment' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NOT NULL AND spaces_route_renewal_id IS NULL
      AND verified_by_actor_id IS NOT NULL AND family = 'spaces' AND expires_at IS NOT NULL)
    OR (origin = 'spaces_route_renewal' AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND spaces_route_attachment_intent_id IS NULL AND spaces_route_renewal_id IS NOT NULL
      AND verified_by_actor_id IS NULL AND family = 'spaces' AND expires_at IS NOT NULL)
  );

-- Attachment evidence exists only for a proved, unexpired challenge whose actor
-- still holds route authority, all judged by the database clock.
CREATE FUNCTION validate_spaces_route_attachment_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attachment spaces_community_route_attachments%ROWTYPE;
  binding community_canonical_route_bindings%ROWTYPE;
  prior community_route_ownership_evidence%ROWTYPE;
  guard_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO attachment
    FROM spaces_community_route_attachments
   WHERE attachment_intent_id = NEW.spaces_route_attachment_intent_id
   FOR UPDATE;
  IF attachment.attachment_intent_id IS NULL
    OR attachment.status <> 'proved'
    OR attachment.expires_at <= guard_at
    OR NEW.root_label <> attachment.canonical_root
    OR NEW.verified_by_actor_id <> attachment.account_id
    OR NEW.provider_id <> attachment.provider_id
    OR NEW.requirement_hash <> attachment.requirement_hash
    OR NEW.verified_at <> attachment.proved_at
    OR NEW.expires_at <= guard_at
    OR has_community_route_authority(attachment.community_id, attachment.account_id) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'spaces route evidence requires a live proved attachment';
  END IF;
  IF attachment.purpose = 'first_attachment' THEN
    IF NEW.binding_generation <> 1 THEN
      RAISE EXCEPTION 'spaces route evidence requires a live proved attachment';
    END IF;
    RETURN NEW;
  END IF;
  -- Revalidation restores the same immutable binding, and only one that no
  -- longer resolves. A live lease is extended by renewal, never by this path.
  SELECT * INTO binding
    FROM community_canonical_route_bindings
   WHERE route_binding_id = attachment.target_route_binding_id
   FOR UPDATE;
  SELECT * INTO prior
    FROM community_route_ownership_evidence WHERE evidence_ref = binding.verified_evidence_ref;
  IF binding.route_binding_id IS NULL
    OR binding.community_id <> attachment.community_id
    OR binding.family <> 'spaces'
    OR binding.root_label <> attachment.canonical_root
    OR binding.route_authority_kind <> 'verified_namespace_v1'
    OR binding.binding_generation <> attachment.expected_binding_generation
    OR NEW.binding_generation <> attachment.expected_binding_generation + 1
    OR (binding.route_lifecycle_status = 'active' AND binding.ownership_status = 'verified'
        AND prior.expires_at IS NOT NULL AND prior.expires_at > guard_at)
  THEN
    RAISE EXCEPTION 'spaces route revalidation requires the same ineffective binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_spaces_attachment_evidence_insert_guard
  BEFORE INSERT ON community_route_ownership_evidence
  FOR EACH ROW WHEN (NEW.origin = 'spaces_route_attachment')
  EXECUTE FUNCTION validate_spaces_route_attachment_evidence_insert();

CREATE FUNCTION validate_spaces_route_renewal_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  renewal spaces_community_route_renewals%ROWTYPE;
  binding community_canonical_route_bindings%ROWTYPE;
  prior community_route_ownership_evidence%ROWTYPE;
  guard_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO renewal
    FROM spaces_community_route_renewals WHERE renewal_id = NEW.spaces_route_renewal_id;
  SELECT * INTO binding
    FROM community_canonical_route_bindings
   WHERE route_binding_id = renewal.route_binding_id
   FOR UPDATE;
  SELECT * INTO prior
    FROM community_route_ownership_evidence WHERE evidence_ref = binding.verified_evidence_ref;
  -- Renewal continues a lease that is still live. An expired or suspended
  -- binding needs a new owner ceremony, never a silent system revival.
  IF renewal.renewal_id IS NULL
    OR renewal.outcome <> 'renewed'
    OR binding.route_binding_id IS NULL
    OR binding.family <> 'spaces'
    OR binding.route_lifecycle_status <> 'active'
    OR binding.ownership_status <> 'verified'
    OR binding.binding_generation <> renewal.expected_binding_generation
    OR prior.evidence_ref IS NULL
    OR prior.expires_at IS NULL
    OR prior.expires_at <= guard_at
    OR NEW.root_label <> binding.root_label
    OR NEW.binding_generation <> renewal.expected_binding_generation + 1
    OR NEW.provider_id <> prior.provider_id
    OR NEW.provider_identity_digest <> prior.provider_identity_digest
    OR NEW.verified_at <> renewal.observed_at
    OR NEW.expires_at <= guard_at
  THEN
    RAISE EXCEPTION 'spaces route renewal requires a live binding with an unchanged owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_spaces_renewal_evidence_insert_guard
  BEFORE INSERT ON community_route_ownership_evidence
  FOR EACH ROW WHEN (NEW.origin = 'spaces_route_renewal')
  EXECUTE FUNCTION validate_spaces_route_renewal_evidence_insert();

-- A binding created from attachment evidence is the first and only binding of
-- an active community, checked under the community row lock.
CREATE FUNCTION validate_spaces_route_attachment_binding_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  community_record communities%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  attachment spaces_community_route_attachments%ROWTYPE;
BEGIN
  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = NEW.verified_evidence_ref;
  IF evidence_record.evidence_ref IS NULL
    OR evidence_record.origin <> 'spaces_route_attachment' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO attachment
    FROM spaces_community_route_attachments
   WHERE attachment_intent_id = evidence_record.spaces_route_attachment_intent_id
   FOR UPDATE;
  SELECT * INTO community_record
    FROM communities WHERE community_id = NEW.community_id FOR UPDATE;
  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR community_record.canonical_route_binding_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM community_canonical_route_bindings AS existing
       WHERE existing.community_id = NEW.community_id
    )
    OR attachment.community_id <> NEW.community_id
    OR attachment.purpose <> 'first_attachment'
    OR attachment.status <> 'proved'
    OR attachment.expires_at <= clock_timestamp()
    OR NEW.family <> 'spaces'
    OR NEW.root_label <> attachment.canonical_root
    OR NEW.root_label_display <> evidence_record.root_label_display
    OR NEW.binding_generation <> 1
    OR NEW.ownership_status <> 'verified'
    OR NEW.route_lifecycle_status <> 'active'
    OR NEW.route_authority_kind <> 'verified_namespace_v1' THEN
    RAISE EXCEPTION 'spaces route commit requires a never-bound community and a live proof';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_spaces_attachment_binding_insert_guard
  BEFORE INSERT ON community_canonical_route_bindings
  FOR EACH ROW EXECUTE FUNCTION validate_spaces_route_attachment_binding_insert();
