-- Final native Spaces issuance (Spec 012 §5.3.13.7). A registry callback is
-- only a hint. The independent verifier supplies this evidence after checking
-- the certificate, recipient, commitment history, and chain finality.

ALTER TABLE spaces_issuance_verifications
  ADD COLUMN lease_token TEXT,
  ADD COLUMN leased_until TIMESTAMPTZ,
  ADD COLUMN overdue_alerted_at TIMESTAMPTZ,
  ADD CONSTRAINT spaces_issuance_verification_lease_shape CHECK (
    (lease_token IS NULL AND leased_until IS NULL)
    OR (lease_token ~ '^slease_[0-9a-f]{32}$' AND leased_until IS NOT NULL)
  ),
  ADD CONSTRAINT spaces_issuance_verification_overdue_alert_shape CHECK (
    overdue_alerted_at IS NULL
    OR (overdue_marked_at IS NOT NULL AND overdue_alerted_at >= overdue_marked_at)
  );

CREATE TABLE spaces_final_issuance_evidence (
  evidence_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE REFERENCES spaces_issuance_verifications (claim_id),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  script_pubkey_hex TEXT NOT NULL,
  certificate_sha256_hex TEXT NOT NULL,
  commitment_txid_hex TEXT NOT NULL,
  commitment_root_hex TEXT NOT NULL,
  mined_height BIGINT NOT NULL,
  verified_tip_height BIGINT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_final_issuance_evidence_identity_check CHECK (
    evidence_id ~ '^sfinal_[0-9a-f]{32}$'
    AND is_community_route_root_label('spaces', namespace_root)
    AND handle_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    AND handle_label !~ '^xn--'
    AND octet_length(handle_label) BETWEEN 1 AND 62
    AND script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
    AND certificate_sha256_hex ~ '^[0-9a-f]{64}$'
    AND commitment_txid_hex ~ '^[0-9a-f]{64}$'
    AND commitment_root_hex ~ '^[0-9a-f]{64}$'
    AND mined_height >= 0
    AND verified_tip_height > mined_height + 144
    AND is_handle_sales_identifier_v1(verifier_id, 128)
    AND is_handle_sales_identifier_v1(verifier_version, 128)
    AND observed_at <= recorded_at
  )
);

CREATE FUNCTION guard_spaces_final_issuance_evidence_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Spaces final issuance evidence is append-only';
  END IF;
  SELECT * INTO claim FROM handle_claims WHERE claim_id=NEW.claim_id FOR SHARE;
  IF claim.claim_id IS NULL
    OR claim.family <> 'spaces'
    OR claim.state <> 'issuance_pending'
    OR claim.namespace_root <> NEW.namespace_root
    OR claim.handle_label <> NEW.handle_label
    OR claim.recipient_network <> NEW.network
    OR claim.recipient_script_pubkey_hex <> NEW.script_pubkey_hex THEN
    RAISE EXCEPTION 'Spaces final issuance evidence does not match the pending claim';
  END IF;
  RETURN NEW;
END;
$$;

-- A native Spaces name does not change Pirate's persona public-linkage clock.
-- The HNS trigger behavior is preserved for HNS grants.
CREATE OR REPLACE FUNCTION advance_handle_linkage_after_grant_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.family = 'hns' THEN
    PERFORM advance_handle_persona_public_linkage_v1(NEW.owner_persona_id, NEW.issued_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_final_issuance_evidence_append_only
BEFORE INSERT OR UPDATE OR DELETE ON spaces_final_issuance_evidence
FOR EACH ROW EXECUTE FUNCTION guard_spaces_final_issuance_evidence_v1();

-- An independently verified final occupancy by another recipient is terminal
-- for this claim, but it never creates a Pirate grant. Keep the evidence with
-- its own exact-key foreign key so the conflict fence cannot borrow it.
CREATE TABLE spaces_final_conflict_evidence (
  evidence_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE REFERENCES spaces_issuance_verifications (claim_id),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  expected_script_pubkey_hex TEXT NOT NULL,
  observed_script_pubkey_hex TEXT NOT NULL,
  certificate_sha256_hex TEXT NOT NULL,
  commitment_txid_hex TEXT NOT NULL,
  commitment_root_hex TEXT NOT NULL,
  mined_height BIGINT NOT NULL,
  verified_tip_height BIGINT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_final_conflict_evidence_key_unique UNIQUE (
    evidence_id,network,namespace_root,handle_label
  ),
  CONSTRAINT spaces_final_conflict_evidence_identity_check CHECK (
    evidence_id ~ '^sconfinal_[0-9a-f]{32}$'
    AND is_community_route_root_label('spaces', namespace_root)
    AND handle_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    AND handle_label !~ '^xn--'
    AND octet_length(handle_label) BETWEEN 1 AND 62
    AND expected_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
    AND observed_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
    AND observed_script_pubkey_hex <> expected_script_pubkey_hex
    AND certificate_sha256_hex ~ '^[0-9a-f]{64}$'
    AND commitment_txid_hex ~ '^[0-9a-f]{64}$'
    AND commitment_root_hex ~ '^[0-9a-f]{64}$'
    AND mined_height >= 0
    AND verified_tip_height > mined_height + 144
    AND is_handle_sales_identifier_v1(verifier_id, 128)
    AND is_handle_sales_identifier_v1(verifier_version, 128)
    AND observed_at <= recorded_at
  )
);

CREATE FUNCTION guard_spaces_final_conflict_evidence_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Spaces final conflict evidence is append-only';
  END IF;
  SELECT * INTO claim FROM handle_claims WHERE claim_id=NEW.claim_id FOR SHARE;
  IF claim.claim_id IS NULL
    OR claim.family <> 'spaces'
    OR claim.state <> 'issuance_pending'
    OR claim.namespace_root <> NEW.namespace_root
    OR claim.handle_label <> NEW.handle_label
    OR claim.recipient_network <> NEW.network
    OR claim.recipient_script_pubkey_hex <> NEW.expected_script_pubkey_hex THEN
    RAISE EXCEPTION 'Spaces final conflict evidence does not match the pending claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_final_conflict_evidence_append_only
BEFORE INSERT OR UPDATE OR DELETE ON spaces_final_conflict_evidence
FOR EACH ROW EXECUTE FUNCTION guard_spaces_final_conflict_evidence_v1();

ALTER TABLE spaces_external_conflict_observations
  ADD COLUMN final_conflict_evidence_id TEXT,
  DROP CONSTRAINT spaces_external_conflict_observations_evidence_kind_check,
  DROP CONSTRAINT spaces_external_conflict_evidence_shape,
  ADD CONSTRAINT spaces_external_conflict_observations_evidence_kind_check CHECK (
    evidence_kind IN (
      'registry_acknowledgment_v1','occupancy_observation_v1','final_conflict_evidence_v1'
    )
  ),
  ADD CONSTRAINT spaces_external_conflict_evidence_shape CHECK (
    ((evidence_kind='registry_acknowledgment_v1'
      AND registry_acknowledgment_id IS NOT NULL
      AND occupancy_observation_id IS NULL
      AND final_conflict_evidence_id IS NULL) IS TRUE)
    OR ((evidence_kind='occupancy_observation_v1'
      AND occupancy_observation_id IS NOT NULL
      AND registry_acknowledgment_id IS NULL
      AND final_conflict_evidence_id IS NULL) IS TRUE)
    OR ((evidence_kind='final_conflict_evidence_v1'
      AND final_conflict_evidence_id IS NOT NULL
      AND registry_acknowledgment_id IS NULL
      AND occupancy_observation_id IS NULL) IS TRUE)
  ),
  ADD CONSTRAINT spaces_external_conflict_final_evidence_fk FOREIGN KEY (
    final_conflict_evidence_id,network,namespace_root,handle_label
  ) REFERENCES spaces_final_conflict_evidence (
    evidence_id,network,namespace_root,handle_label
  );

ALTER TABLE handle_grants
  ADD COLUMN spaces_final_evidence_id TEXT
    REFERENCES spaces_final_issuance_evidence (evidence_id),
  ADD CONSTRAINT handle_grant_final_evidence_shape CHECK (
    (family = 'hns' AND spaces_final_evidence_id IS NULL)
    OR (family = 'spaces' AND spaces_final_evidence_id IS NOT NULL)
  );

CREATE FUNCTION assert_spaces_handle_grant_insert_v1(candidate handle_grants)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
  evidence spaces_final_issuance_evidence%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM handle_claims WHERE claim_id=candidate.claim_id FOR SHARE;
  SELECT * INTO offering FROM community_handle_offering_revisions
    WHERE offering_id=claim.offering_id AND offering_hash=claim.offering_hash FOR SHARE;
  SELECT * INTO evidence FROM spaces_final_issuance_evidence
    WHERE evidence_id=candidate.spaces_final_evidence_id FOR SHARE;
  IF claim.claim_id IS NULL
    OR offering.offering_id IS NULL
    OR evidence.evidence_id IS NULL
    OR claim.family <> 'spaces'
    OR claim.state <> 'issued'
    OR claim.grant_id <> candidate.grant_id
    OR offering.community_id <> candidate.community_id
    OR claim.actor_account_id <> candidate.owner_account_id
    OR claim.owner_persona_id <> candidate.owner_persona_id
    OR claim.offering_id <> candidate.offering_id
    OR claim.offering_hash <> candidate.offering_hash
    OR claim.sale_namespace_activation_id <> candidate.sale_namespace_activation_id
    OR claim.sale_namespace_activation_generation <> candidate.sale_namespace_activation_generation
    OR claim.fulfillment_kind <> candidate.fulfillment_kind
    OR claim.namespace_root <> candidate.namespace_root
    OR claim.handle_label <> candidate.handle_label
    OR claim.display_identifier <> candidate.display_identifier
    OR claim.recipient_kind <> candidate.recipient_kind
    OR claim.recipient_network <> candidate.recipient_network
    OR claim.recipient_taproot_assignment_id <> candidate.recipient_taproot_assignment_id
    OR claim.recipient_script_pubkey_hex <> candidate.recipient_script_pubkey_hex
    OR evidence.claim_id <> candidate.claim_id
    OR evidence.network <> candidate.recipient_network
    OR evidence.namespace_root <> candidate.namespace_root
    OR evidence.handle_label <> candidate.handle_label
    OR evidence.script_pubkey_hex <> candidate.recipient_script_pubkey_hex
    OR candidate.status NOT IN ('active', 'tombstoned')
    OR candidate.issued_at <> evidence.recorded_at THEN
    RAISE EXCEPTION 'Spaces handle grant requires matching final issuance evidence';
  END IF;
END;
$$;

-- Keep the original HNS branch byte-for-byte; only Spaces dispatch changes.
CREATE OR REPLACE FUNCTION validate_handle_grant_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_handle_grant_insert_v1(NEW);
    RETURN NEW;
  END IF;

  SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = claim.offering_id
     AND offering_hash = claim.offering_hash
   FOR SHARE;
  IF claim.claim_id IS NULL
    OR claim.state <> 'issued'
    OR claim.grant_id <> NEW.grant_id
    OR offering.community_id <> NEW.community_id
    OR claim.actor_account_id <> NEW.owner_account_id
    OR claim.owner_persona_id <> NEW.owner_persona_id
    OR claim.offering_id <> NEW.offering_id
    OR claim.offering_hash <> NEW.offering_hash
    OR claim.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR claim.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR claim.fulfillment_kind <> NEW.fulfillment_kind
    OR claim.family <> NEW.family
    OR claim.namespace_root <> NEW.namespace_root
    OR claim.handle_label <> NEW.handle_label
    OR claim.display_identifier <> NEW.display_identifier
    OR NEW.status <> 'active'
    OR NEW.issued_at <> claim.created_at THEN
    RAISE EXCEPTION 'handle grant does not match its immutable claim';
  END IF;
  RETURN NEW;
END;
$$;
