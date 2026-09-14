-- Spec 012: a handle qualification decision belongs to its consuming action,
-- not membership. Quote snapshots are immutable and never extend evidence.
CREATE TABLE handle_nationality_decisions (
  decision_id text PRIMARY KEY,
  actor_account_id text NOT NULL REFERENCES users(user_id),
  purpose text NOT NULL CHECK (purpose IN ('quote','reservation','claim')),
  resource_id text NOT NULL,
  offering_id text NOT NULL,
  offering_revision bigint NOT NULL,
  offering_hash text NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  qualification_policy_id text NOT NULL,
  qualification_policy_revision bigint NOT NULL,
  qualification_policy_hash text NOT NULL CHECK (qualification_policy_hash ~ '^[0-9a-f]{64}$'),
  requirement_hash text NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('pass','needs_evidence','fail','indeterminate')),
  reason text,
  selected_provider_id text CHECK (selected_provider_id IN ('self.pass','zkpassport')),
  selected_provider_binding_hash text CHECK (selected_provider_binding_hash ~ '^[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  FOREIGN KEY (offering_id,offering_revision) REFERENCES community_handle_offering_revisions(offering_id,offering_revision),
  FOREIGN KEY (qualification_policy_id,qualification_policy_revision) REFERENCES handle_qualification_policy_revisions(policy_id,policy_revision),
  CHECK ((outcome='pass' AND reason IS NULL AND selected_provider_id IS NOT NULL AND selected_provider_binding_hash IS NOT NULL)
      OR (outcome<>'pass' AND reason IS NOT NULL AND selected_provider_id IS NULL AND selected_provider_binding_hash IS NULL))
);

CREATE TABLE handle_nationality_evidence_uses (
  evidence_use_id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES handle_nationality_decisions(decision_id),
  actor_account_id text NOT NULL,
  assertion_id text NOT NULL,
  evidence_receipt_id text NOT NULL,
  subject_key_id text NOT NULL,
  subject_binding_event_id text NOT NULL,
  subject_binding_epoch bigint NOT NULL CHECK (subject_binding_epoch > 0),
  FOREIGN KEY (assertion_id,actor_account_id) REFERENCES assertions(assertion_id,user_id),
  FOREIGN KEY (evidence_receipt_id,subject_key_id,subject_binding_event_id,subject_binding_epoch,actor_account_id)
    REFERENCES evidence_receipts(evidence_receipt_id,subject_key_id,subject_binding_event_id,subject_binding_epoch,user_id),
  UNIQUE (decision_id,assertion_id,evidence_receipt_id)
);

CREATE FUNCTION reject_handle_nationality_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'handle nationality decisions and evidence uses are immutable'; END;
$$;
CREATE TRIGGER handle_nationality_decisions_immutable BEFORE UPDATE OR DELETE ON handle_nationality_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_handle_nationality_decision_mutation();
CREATE TRIGGER handle_nationality_evidence_uses_immutable BEFORE UPDATE OR DELETE ON handle_nationality_evidence_uses
  FOR EACH ROW EXECUTE FUNCTION reject_handle_nationality_decision_mutation();

ALTER TABLE handle_quotes ADD COLUMN nationality_qualification_pin jsonb;
ALTER TABLE handle_quotes ADD COLUMN nationality_decision_id text REFERENCES handle_nationality_decisions(decision_id);
ALTER TABLE handle_reservations ADD COLUMN nationality_decision_id text REFERENCES handle_nationality_decisions(decision_id);
ALTER TABLE handle_claims ADD COLUMN nationality_decision_id text REFERENCES handle_nationality_decisions(decision_id);
ALTER TABLE handle_quotes ADD CONSTRAINT handle_nationality_quote_pin_pair CHECK (
  (nationality_qualification_pin IS NULL AND nationality_decision_id IS NULL) OR
  (nationality_qualification_pin IS NOT NULL AND nationality_decision_id IS NOT NULL
    AND jsonb_typeof(nationality_qualification_pin)='object')
);

CREATE FUNCTION validate_handle_nationality_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  offering community_handle_offering_revisions%ROWTYPE;
  policy handle_qualification_policy_revisions%ROWTYPE;
BEGIN
  SELECT * INTO offering FROM community_handle_offering_revisions
    WHERE offering_id=NEW.offering_id AND offering_revision=NEW.offering_revision FOR SHARE;
  SELECT * INTO policy FROM handle_qualification_policy_revisions
    WHERE policy_id=offering.qualification_policy_id AND policy_revision=offering.qualification_policy_revision FOR SHARE;
  IF policy.policy_kind IS DISTINCT FROM 'curated_nationality_v1'
    OR offering.offering_hash IS DISTINCT FROM NEW.offering_hash
    OR policy.policy_id IS DISTINCT FROM NEW.qualification_policy_id
    OR policy.policy_revision IS DISTINCT FROM NEW.qualification_policy_revision
    OR policy.policy_hash IS DISTINCT FROM NEW.qualification_policy_hash
    OR policy.nationality_policy->>'requirement_hash' IS DISTINCT FROM NEW.requirement_hash
    OR (NEW.outcome='pass' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(policy.nationality_policy->'provider_bindings') binding
        WHERE binding->>'provider_id'=NEW.selected_provider_id
    )) THEN RAISE EXCEPTION 'handle nationality decision does not match its offering policy'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER handle_nationality_decision_insert_guard BEFORE INSERT ON handle_nationality_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_decision_insert();

CREATE FUNCTION validate_handle_nationality_use_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision handle_nationality_decisions%ROWTYPE;
BEGIN
  SELECT * INTO decision FROM handle_nationality_decisions WHERE decision_id=NEW.decision_id FOR SHARE;
  IF decision.outcome IS DISTINCT FROM 'pass' OR decision.actor_account_id IS DISTINCT FROM NEW.actor_account_id
    OR NOT EXISTS (SELECT 1 FROM assertions a JOIN evidence_receipts r ON r.evidence_receipt_id=a.evidence_receipt_id
      WHERE a.assertion_id=NEW.assertion_id AND a.user_id=NEW.actor_account_id
        AND a.evidence_receipt_id=NEW.evidence_receipt_id AND a.claim_id='nationality.allowed'
        AND a.assertion_value='{"allowed":true}'::jsonb
        AND r.provider_id=decision.selected_provider_id)
    THEN RAISE EXCEPTION 'handle nationality evidence use does not match its decision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER handle_nationality_evidence_use_insert_guard BEFORE INSERT ON handle_nationality_evidence_uses
  FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_use_insert();

-- Existing v2 shape/lineage guards remain installed. This additional boundary
-- binds each nationality action to its own successful server decision.
CREATE FUNCTION validate_handle_nationality_action_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document jsonb := to_jsonb(NEW);
  quote handle_quotes%ROWTYPE;
  decision handle_nationality_decisions%ROWTYPE;
  policy_kind text;
  expected_purpose text;
  expected_resource text;
BEGIN
  IF TG_TABLE_NAME='handle_quotes' THEN
    quote := NEW;
    expected_purpose := 'quote'; expected_resource := NEW.quote_id;
  ELSE
    SELECT * INTO quote FROM handle_quotes WHERE quote_id=NEW.quote_id FOR SHARE;
    expected_purpose := CASE WHEN TG_TABLE_NAME='handle_reservations' THEN 'reservation' ELSE 'claim' END;
    expected_resource := document->>(expected_purpose || '_id');
  END IF;
  SELECT policy.policy_kind INTO policy_kind
    FROM community_handle_offering_revisions offering
    JOIN handle_qualification_policy_revisions policy
      ON policy.policy_id=offering.qualification_policy_id AND policy.policy_revision=offering.qualification_policy_revision
    WHERE offering.offering_id=quote.offering_id AND offering.offering_revision=quote.offering_revision;
  IF policy_kind IS DISTINCT FROM 'curated_nationality_v1' THEN
    IF document->>'nationality_decision_id' IS NOT NULL OR quote.nationality_qualification_pin IS NOT NULL
      THEN RAISE EXCEPTION 'unqualified and private handles cannot carry nationality decisions'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO decision FROM handle_nationality_decisions WHERE decision_id=NEW.nationality_decision_id FOR SHARE;
  IF decision.decision_id IS NULL OR decision.outcome<>'pass'
    OR decision.purpose<>expected_purpose OR decision.resource_id<>expected_resource
    OR decision.actor_account_id<>NEW.actor_account_id OR decision.offering_id<>quote.offering_id
    OR decision.offering_revision<>quote.offering_revision OR decision.offering_hash<>quote.offering_hash
    OR decision.qualification_policy_hash<>quote.eligibility_policy_hash
    OR NOT EXISTS (SELECT 1 FROM handle_nationality_evidence_uses AS evidence_use WHERE evidence_use.decision_id=decision.decision_id)
    THEN RAISE EXCEPTION 'handle action requires its own current nationality decision'; END IF;
  IF expected_purpose='quote' AND (
    quote.nationality_qualification_pin->>'offering_revision' IS DISTINCT FROM quote.offering_revision::text
    OR quote.nationality_qualification_pin->>'offering_hash' IS DISTINCT FROM quote.offering_hash
    OR quote.nationality_qualification_pin->'qualification'->>'policy_id' IS DISTINCT FROM decision.qualification_policy_id
    OR quote.nationality_qualification_pin->'qualification'->>'policy_revision' IS DISTINCT FROM decision.qualification_policy_revision::text
    OR quote.nationality_qualification_pin->'qualification'->>'policy_hash' IS DISTINCT FROM decision.qualification_policy_hash
    OR quote.nationality_qualification_pin->'qualification'->>'requirement_hash' IS DISTINCT FROM decision.requirement_hash
    OR quote.nationality_qualification_pin->'eligibility'->>'decision' IS DISTINCT FROM 'passed'
    OR quote.nationality_qualification_pin->'eligibility'->'accepted_provider_ids' IS DISTINCT FROM '["self.pass","zkpassport"]'::jsonb
    OR quote.nationality_qualification_pin->'eligibility'->>'policy_hash' IS DISTINCT FROM decision.qualification_policy_hash
    OR quote.nationality_qualification_pin->'eligibility'->>'requirement_hash' IS DISTINCT FROM decision.requirement_hash
    OR quote.nationality_qualification_pin->'eligibility'->>'selected_provider_id' IS DISTINCT FROM decision.selected_provider_id
    OR quote.nationality_qualification_pin->'eligibility'->>'selected_provider_binding_hash' IS DISTINCT FROM decision.selected_provider_binding_hash
    OR quote.nationality_qualification_pin->'eligibility'->'evidence_use_ids' IS DISTINCT FROM to_jsonb(quote.evidence_use_ids)
  ) THEN RAISE EXCEPTION 'handle nationality quote snapshot differs from its decision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER handle_nationality_quote_insert_guard BEFORE INSERT ON handle_quotes
  FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_action_insert();
CREATE TRIGGER handle_nationality_reservation_insert_guard BEFORE INSERT ON handle_reservations
  FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_action_insert();
CREATE TRIGGER handle_nationality_claim_insert_guard BEFORE INSERT ON handle_claims
  FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_action_insert();

-- An ineligible quote request pins a separate buyer qualification context.
-- It is not a quote, reservation, membership or grant.
CREATE TABLE handle_nationality_qualification_intents (
  qualification_intent_id text PRIMARY KEY,
  actor_account_id text NOT NULL REFERENCES users(user_id),
  owner_persona_id text NOT NULL REFERENCES personas(persona_id),
  offering_id text NOT NULL,
  offering_revision bigint NOT NULL,
  offering_hash text NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  handle_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (offering_id,offering_revision) REFERENCES community_handle_offering_revisions(offering_id,offering_revision),
  CHECK (expires_at > created_at)
);
CREATE TRIGGER handle_nationality_qualification_intents_immutable BEFORE UPDATE OR DELETE ON handle_nationality_qualification_intents
  FOR EACH ROW EXECUTE FUNCTION reject_handle_nationality_decision_mutation();
ALTER TABLE handle_quote_actions ADD COLUMN qualification_intent_id text REFERENCES handle_nationality_qualification_intents(qualification_intent_id);
ALTER TABLE handle_quote_actions DROP CONSTRAINT handle_quote_actions_result_kind_check;
ALTER TABLE handle_quote_actions DROP CONSTRAINT handle_quote_action_result_shape;
ALTER TABLE handle_quote_actions ADD CONSTRAINT handle_quote_actions_result_kind_check CHECK (result_kind IN ('quoted','eligibility_required','nationality_required'));
ALTER TABLE handle_quote_actions ADD CONSTRAINT handle_quote_action_result_shape CHECK (
  (result_kind='quoted' AND quote_id IS NOT NULL AND eligibility_reason IS NULL AND qualification_intent_id IS NULL) OR
  (result_kind='eligibility_required' AND quote_id IS NULL AND eligibility_reason IS NOT NULL AND qualification_intent_id IS NULL) OR
  (result_kind='nationality_required' AND quote_id IS NULL AND eligibility_reason IS NOT NULL AND qualification_intent_id IS NOT NULL)
);

CREATE FUNCTION validate_handle_nationality_quote_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.result_kind='nationality_required' AND NOT EXISTS (
    SELECT 1 FROM handle_nationality_qualification_intents intent
    WHERE intent.qualification_intent_id=NEW.qualification_intent_id
      AND intent.actor_account_id=NEW.actor_account_id AND intent.owner_persona_id=NEW.owner_persona_id
      AND intent.offering_id=NEW.offering_id
  ) THEN RAISE EXCEPTION 'nationality quote action does not match buyer context'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER handle_nationality_quote_action_guard BEFORE INSERT ON handle_quote_actions
 FOR EACH ROW EXECUTE FUNCTION validate_handle_nationality_quote_action();
