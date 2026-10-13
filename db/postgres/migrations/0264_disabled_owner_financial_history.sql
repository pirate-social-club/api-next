-- FIRST DISABLED OWNER ACCOUNTING SOURCE CHECKPOINT.
-- Migration0264: maintained runner owns ONE transaction; no runtime grant or activation.
-- Source basis canonical3ef1/current263; no client/public operation or runtime grant.
-- Exclusive topology MUST be acquired before DDL/owner/history/phase mutation.
DO $require_accepted_learning_phase$
BEGIN
 PERFORM pg_advisory_xact_lock(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton
  AND phase='practice_only_owner_audio_producer_history_v5')<>1
 THEN RAISE EXCEPTION 'accepted learning history phase required' USING ERRCODE='GP003'; END IF;
END $require_accepted_learning_phase$;

CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='disabled_owner_financial_history_v1')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','guest_owner_associations','participation_eligibility_decisions','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations','reward_credit_persona_bindings','reward_credit_recipient_selections','reward_ledger_credits','megapot_pool_drawings','megapot_pool_shares','megapot_pool_beneficiary_snapshots','megapot_allocation_batches','megapot_allocations','megapot_participant_claims','megapot_participant_claim_guards','reward_payout_effects','reward_winner_sends','reward_gas_topups','wallet_sponsored_sends','song_reward_bundle_claim_legs'
      ]) required_name WHERE NOT EXISTS(SELECT 1 FROM pg_class relation
      WHERE relation.oid=to_regclass(required_name) AND relation.relnamespace=trusted_namespace
        AND relation.relowner=trusted_owner AND relation.relkind='r'))
    OR NOT EXISTS(SELECT 1 FROM pg_class sequence_relation
      WHERE sequence_relation.oid=to_regclass('learner_audio_fence_revision_v1')
        AND sequence_relation.relnamespace=trusted_namespace
        AND sequence_relation.relowner=trusted_owner AND sequence_relation.relkind='S')
    OR EXISTS(SELECT 1 FROM pg_depend dependency
      LEFT JOIN pg_attrdef default_expression ON dependency.classid='pg_attrdef'::regclass
        AND default_expression.oid=dependency.objid
      LEFT JOIN pg_class consumer_relation ON consumer_relation.oid=CASE
        WHEN dependency.classid='pg_attrdef'::regclass THEN default_expression.adrelid
        WHEN dependency.classid='pg_class'::regclass THEN dependency.objid END
      WHERE dependency.refclassid='pg_class'::regclass
        AND dependency.refobjid='learner_audio_fence_revision_v1'::regclass
        AND NOT (COALESCE(consumer_relation.relnamespace=trusted_namespace AND consumer_relation.relname IN
          ('learner_audio_owner_fences','learner_audio_delete_commands'),FALSE)
          OR (dependency.classid='pg_proc'::regclass AND dependency.objid=
            'prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)'::regprocedure)))
    OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relnamespace=trusted_namespace AND c.relkind IN ('r','p','f','v','m')
        AND a.attnum>0 AND NOT a.attisdropped
        -- Guest source IDs; ordinary account/policy/lease owner fields have
        -- separate accepted authorities and do not reference guest identities.
        AND a.attname ~ '(^|_)owner_id$'
        AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases',
          'participation_owner_clocks','guest_learning_preferences',
          'guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','guest_owner_associations','participation_eligibility_decisions','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations','reward_credit_persona_bindings','reward_credit_recipient_selections','reward_ledger_credits','megapot_pool_drawings','megapot_pool_shares','megapot_pool_beneficiary_snapshots','megapot_allocation_batches','megapot_allocations','megapot_participant_claims','megapot_participant_claim_guards','reward_payout_effects','reward_winner_sends','reward_gas_topups','wallet_sponsored_sends','song_reward_bundle_claim_legs'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass,
          'guest_resource_session_reservations'::regclass,'guest_resource_provider_calls'::regclass,
          'guest_resource_release_receipts'::regclass,
          'learner_audio_owner_fences'::regclass,'learner_audio_delete_commands'::regclass,'learner_audio_delete_sources'::regclass,'learner_audio_delete_target_artifacts'::regclass,'learner_audio_object_names'::regclass,'learner_audio_upload_attempts'::regclass,'learner_audio_delete_batches'::regclass,'learner_audio_delete_batch_items'::regclass,'learner_audio_deleted_objects'::regclass,'guest_study_spoken_captures'::regclass,'guest_study_spoken_checkpoints'::regclass,'learner_audio_account_producer_captures'::regclass,'learner_audio_upload_terminal_facts'::regclass,'learner_audio_upload_cleanup_commands'::regclass,'learner_audio_account_spoken_checkpoints'::regclass,'learner_audio_account_provider_calls'::regclass,'guest_owner_associations'::regclass,'participation_eligibility_decisions'::regclass,'megapot_owner_shares'::regclass,'megapot_owner_snapshot_leaves'::regclass,'megapot_owner_allocations'::regclass,'reward_credit_persona_bindings'::regclass,'reward_credit_recipient_selections'::regclass,'reward_ledger_credits'::regclass,'megapot_participant_claims'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','guest_owner_associations','participation_eligibility_decisions','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations','reward_credit_persona_bindings','reward_credit_recipient_selections','reward_ledger_credits','megapot_pool_drawings','megapot_pool_shares','megapot_pool_beneficiary_snapshots','megapot_allocation_batches','megapot_allocations','megapot_participant_claims','megapot_participant_claim_guards','reward_payout_effects','reward_winner_sends','reward_gas_topups','wallet_sponsored_sends','song_reward_bundle_claim_legs'))
  THEN RAISE EXCEPTION 'owner history closure unavailable' USING ERRCODE='GP003'; END IF;
  PERFORM require_disabled_owner_financial_inventory_private_v1();
END $$;

CREATE OR REPLACE FUNCTION guest_authority_component_is_empty_v1(original_source_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root_id TEXT; member_ids TEXT[];
BEGIN
  PERFORM require_guest_practice_only_schema_phase_v1();
  root_id := resolve_guest_empty_owner_root_v1(original_source_id);
  WITH RECURSIVE component(owner_id) AS (
    SELECT root_id UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
      JOIN component c ON a.canonical_owner_id=c.owner_id
  ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO member_ids FROM component;
  RETURN EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=root_id AND kind='guest' AND state='empty')
    AND NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(member_ids) AND state='established')
    AND NOT EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_review_items WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_session_items_v2 WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_id=ANY(member_ids))
    AND NOT guest_resource_component_has_history_v1(member_ids)
    AND NOT learner_audio_component_has_history_private_v1(member_ids)
    AND NOT guest_spoken_component_has_history_private_v1(member_ids)
    AND NOT learner_audio_producer_component_has_history_private_v1(member_ids)
    AND NOT guest_financial_component_has_history_private_v1(member_ids)
    AND NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE source_owner_id=ANY(member_ids)
      AND operation_kind IN ('study_start','study_answer','learning_retention','learner_audio_deletion')
      AND state<>'known_aborted')
    AND NOT EXISTS(SELECT 1 FROM guest_attachment_intents WHERE owner_id=ANY(member_ids)
      AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION list_guest_practice_participations_v1(
 p_access JSONB,p_cursor TEXT,p_limit INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE phase_name TEXT; source_ids TEXT[];
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR (p_cursor IS NOT NULL AND (char_length(p_cursor) NOT BETWEEN 1 AND 128
   OR p_cursor ~ '[[:space:][:cntrl:]]')) THEN
  RAISE EXCEPTION 'invalid bounded participation page' USING ERRCODE='22023'; END IF;
 -- Stabilize the positive phase witness before the C-sorted component locks.
 -- All admitted schema/topology transitions take the exclusive barrier first.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 SELECT phase INTO phase_name FROM guest_learning_schema_phase WHERE singleton FOR SHARE;
 -- Keep this literal here even when accounting replaces the shared predicate:
 -- an old practice reader MUST NOT silently erase newly admitted liabilities.
 IF NOT FOUND OR phase_name IS DISTINCT FROM 'disabled_owner_financial_history_v1' THEN
  RAISE EXCEPTION 'practice participation reader unavailable' USING ERRCODE='GP003'; END IF;
 source_ids:=require_guest_audio_recovery_access_private_v1(p_access,p_access->>'ownerId');
 -- Recovery deliberately ignores learning-lease/credential age. The helper
 -- rechecks confirmed state, exact origin, original credential provenance,
 -- effective root and complete component after locks, without creating a fence.
 IF EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(source_ids) AND kind<>'guest')
  OR EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(source_ids)
   AND (participation_owner_kind IS DISTINCT FROM 'guest'
    OR guest_reward_mode IS DISTINCT FROM 'practice_only' OR guest_reward_terms IS NOT NULL
    OR account_id IS NOT NULL OR persona_id IS NOT NULL OR telegram_practice_only IS NOT FALSE)) THEN
  RAISE EXCEPTION 'practice source inventory differs' USING ERRCODE='GP003'; END IF;
 -- Positive disabled inventory requires every financial relation and refuses
 -- ANY unexpected financial rows. The per-component check below additionally
 -- prevents an old practice list from erasing held financial history.
 IF guest_financial_component_has_history_private_v1(source_ids) THEN
  RAISE EXCEPTION 'financial participation reader successor required' USING ERRCODE='GP003'; END IF;
 RETURN jsonb_build_object('items','[]'::JSONB,'nextCursor',NULL);
END $$;


-- Included by the unnumbered first disabled checkpoint. No financial DML producer exists.
ALTER TABLE megapot_pool_drawings
 ADD COLUMN beneficiary_version SMALLINT NOT NULL DEFAULT 2,
 ADD CONSTRAINT owner_drawing_version_closed CHECK(beneficiary_version IN(2,3)),
 ADD CONSTRAINT owner_drawing_version_key UNIQUE(pool_leg_id,drawing_id,beneficiary_version);
ALTER TABLE megapot_pool_shares
 ADD COLUMN beneficiary_version SMALLINT NOT NULL DEFAULT 2,
 ADD CONSTRAINT retained_v2_share_version CHECK(beneficiary_version=2),
 ADD CONSTRAINT retained_v2_share_drawing_version FOREIGN KEY(pool_leg_id,drawing_id,beneficiary_version)
 REFERENCES megapot_pool_drawings(pool_leg_id,drawing_id,beneficiary_version);
ALTER TABLE megapot_pool_beneficiary_snapshots
 ADD COLUMN beneficiary_version SMALLINT NOT NULL DEFAULT 2,
 ADD CONSTRAINT owner_snapshot_version_closed CHECK(beneficiary_version IN(2,3)),
 ADD CONSTRAINT owner_snapshot_version_key UNIQUE(snapshot_id,pool_leg_id,drawing_id,beneficiary_version),
 ADD CONSTRAINT owner_snapshot_drawing_version FOREIGN KEY(pool_leg_id,drawing_id,beneficiary_version)
 REFERENCES megapot_pool_drawings(pool_leg_id,drawing_id,beneficiary_version) DEFERRABLE INITIALLY DEFERRED;
-- Existing domain remains strictly v2. Its prospective v3 alteration is deferred
-- until the full v3 freeze/private-leaf validator is accepted; all v3 writes refuse.
ALTER TABLE megapot_allocation_batches
 ADD COLUMN beneficiary_version SMALLINT NOT NULL DEFAULT 2,
 ADD CONSTRAINT owner_batch_version_closed CHECK(beneficiary_version IN(2,3)),
 ADD CONSTRAINT owner_batch_version_key UNIQUE(allocation_batch_id,snapshot_id,beneficiary_version),
 ADD CONSTRAINT owner_batch_drawing_version FOREIGN KEY(pool_leg_id,drawing_id,beneficiary_version)
 REFERENCES megapot_pool_drawings(pool_leg_id,drawing_id,beneficiary_version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reward_ledger_credits
 ADD COLUMN identity_version TEXT NOT NULL DEFAULT 'account_v1',
 ADD COLUMN participation_owner_id TEXT REFERENCES participation_owners(owner_id),
 ALTER COLUMN account_id DROP NOT NULL,
 ALTER COLUMN payout_persona_id DROP NOT NULL,
 ADD CONSTRAINT owner_credit_identity_closed CHECK(
  (identity_version='account_v1' AND participation_owner_id IS NULL AND account_id IS NOT NULL AND payout_persona_id IS NOT NULL)
  OR (identity_version='owner_v1' AND participation_owner_id IS NOT NULL AND account_id IS NULL AND payout_persona_id IS NULL AND source_kind='megapot_allocation')),
 ADD CONSTRAINT owner_credit_lineage_key UNIQUE(credit_id,participation_owner_id,amount_atomic),
 ADD CONSTRAINT owner_credit_identity_key UNIQUE(credit_id,identity_version,participation_owner_id);
CREATE UNIQUE INDEX owner_credit_unique_source ON reward_ledger_credits(source_kind,source_reference,participation_owner_id) WHERE identity_version='owner_v1';

CREATE TABLE guest_owner_associations (
 guest_owner_id TEXT PRIMARY KEY,
 guest_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
 account_id TEXT NOT NULL REFERENCES users(user_id),
 account_owner_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('bound','participation_conflict')),
 intent_id TEXT NOT NULL UNIQUE,
 origin TEXT NOT NULL,
 proved_at TIMESTAMPTZ NOT NULL,
 UNIQUE(guest_owner_id,account_id,state),
 FOREIGN KEY(guest_owner_id,guest_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
 FOREIGN KEY(account_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id),
 FOREIGN KEY(intent_id,guest_owner_id,origin) REFERENCES guest_attachment_intents(intent_id,owner_id,origin)
);
CREATE TABLE participation_eligibility_decisions (
 eligibility_id TEXT PRIMARY KEY CHECK(octet_length(eligibility_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 qualification_id TEXT NOT NULL REFERENCES activity_qualifications(qualification_id),
 pool_leg_id TEXT NOT NULL,
 drawing_id NUMERIC(78,0) NOT NULL,
 beneficiary_version SMALLINT NOT NULL DEFAULT 3 CHECK(beneficiary_version=3),
 policy_version TEXT NOT NULL,
 policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^(0x)?[0-9a-f]{64}$'),
 evidence_reference TEXT NOT NULL CHECK(octet_length(evidence_reference) BETWEEN 1 AND 2048),
 disclosure_reference TEXT,
 -- Only admitted evidence is scaffolded now. Refusal-operation enum/receipt
 -- must be separately frozen before ANY admission implementation or grant.
 outcome TEXT NOT NULL CHECK(outcome='eligible'),
 decided_at TIMESTAMPTZ NOT NULL,
 UNIQUE(eligibility_id,owner_id,qualification_id,pool_leg_id,drawing_id,beneficiary_version),
 FOREIGN KEY(pool_leg_id,drawing_id,beneficiary_version) REFERENCES megapot_pool_drawings(pool_leg_id,drawing_id,beneficiary_version)
);
CREATE TABLE megapot_owner_shares (
 pool_leg_id TEXT NOT NULL,
 drawing_id NUMERIC(78,0) NOT NULL,
 beneficiary_version SMALLINT NOT NULL DEFAULT 3 CHECK(beneficiary_version=3),
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 qualification_id TEXT NOT NULL REFERENCES activity_qualifications(qualification_id),
 eligibility_id TEXT NOT NULL,
 admitted_at TIMESTAMPTZ NOT NULL,
 leaf_salt BYTEA NOT NULL CHECK(octet_length(leaf_salt)=32),
 PRIMARY KEY(pool_leg_id,drawing_id,owner_id),
 UNIQUE(pool_leg_id,drawing_id,qualification_id),
 UNIQUE(pool_leg_id,drawing_id,owner_id,qualification_id),
 FOREIGN KEY(pool_leg_id,drawing_id,beneficiary_version) REFERENCES megapot_pool_drawings(pool_leg_id,drawing_id,beneficiary_version),
 FOREIGN KEY(eligibility_id,owner_id,qualification_id,pool_leg_id,drawing_id,beneficiary_version)
 REFERENCES participation_eligibility_decisions(eligibility_id,owner_id,qualification_id,pool_leg_id,drawing_id,beneficiary_version)
);
CREATE TABLE megapot_owner_snapshot_leaves (
 snapshot_id TEXT NOT NULL,
 pool_leg_id TEXT NOT NULL,
 drawing_id NUMERIC(78,0) NOT NULL,
 beneficiary_version SMALLINT NOT NULL DEFAULT 3 CHECK(beneficiary_version=3),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 owner_id TEXT NOT NULL,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN('account','guest')),
 qualification_id TEXT NOT NULL,
 share_qualification_id TEXT GENERATED ALWAYS AS(CASE WHEN qualification_id='fallback' THEN NULL ELSE qualification_id END) STORED,
 original_account_id TEXT,
 original_persona_id TEXT,
 leaf_salt BYTEA NOT NULL CHECK(octet_length(leaf_salt)=32),
 order_key TEXT NOT NULL CHECK(order_key ~ '^0x[0-9a-f]{64}$'),
 leaf_commitment TEXT NOT NULL CHECK(leaf_commitment ~ '^0x[0-9a-f]{64}$'),
 PRIMARY KEY(snapshot_id,ordinal),
 UNIQUE(snapshot_id,owner_id), UNIQUE(snapshot_id,order_key), UNIQUE(snapshot_id,leaf_commitment),
 UNIQUE(snapshot_id,ordinal,owner_id),
 FOREIGN KEY(owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind),
 FOREIGN KEY(owner_id,original_account_id) REFERENCES participation_owners(owner_id,account_id),
 FOREIGN KEY(original_account_id,original_persona_id) REFERENCES personas(account_id,persona_id),
 FOREIGN KEY(snapshot_id,pool_leg_id,drawing_id,beneficiary_version) REFERENCES megapot_pool_beneficiary_snapshots(snapshot_id,pool_leg_id,drawing_id,beneficiary_version),
 FOREIGN KEY(pool_leg_id,drawing_id,owner_id,share_qualification_id) REFERENCES megapot_owner_shares(pool_leg_id,drawing_id,owner_id,qualification_id),
 CHECK((owner_kind='account' AND original_account_id IS NOT NULL AND original_persona_id IS NOT NULL)
  OR (owner_kind='guest' AND original_account_id IS NULL AND original_persona_id IS NULL AND qualification_id<>'fallback'))
);
CREATE TABLE megapot_owner_allocations (
 allocation_batch_id TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 beneficiary_version SMALLINT NOT NULL DEFAULT 3 CHECK(beneficiary_version=3),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 amount_atomic NUMERIC(78,0) NOT NULL CHECK(amount_atomic>=0),
 allocation_kind TEXT NOT NULL CHECK(allocation_kind IN('participant','external_fallback','platform_sponsorship')),
 credit_id TEXT UNIQUE,
 PRIMARY KEY(allocation_batch_id,ordinal), UNIQUE(allocation_batch_id,owner_id),
 FOREIGN KEY(allocation_batch_id,snapshot_id,beneficiary_version) REFERENCES megapot_allocation_batches(allocation_batch_id,snapshot_id,beneficiary_version),
 FOREIGN KEY(snapshot_id,ordinal,owner_id) REFERENCES megapot_owner_snapshot_leaves(snapshot_id,ordinal,owner_id),
 FOREIGN KEY(credit_id,owner_id,amount_atomic) REFERENCES reward_ledger_credits(credit_id,participation_owner_id,amount_atomic) DEFERRABLE INITIALLY DEFERRED,
 CHECK((amount_atomic=0 AND credit_id IS NULL)
  OR (amount_atomic>0 AND allocation_kind IN('participant','external_fallback') AND credit_id IS NOT NULL)
  OR (amount_atomic>0 AND allocation_kind='platform_sponsorship' AND credit_id IS NULL))
);
CREATE TABLE reward_credit_recipient_selections (
 owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
 association_state TEXT GENERATED ALWAYS AS ('bound'::TEXT) STORED,
 credit_id TEXT NOT NULL REFERENCES reward_ledger_credits(credit_id),
 selection_revision BIGINT NOT NULL CHECK(selection_revision BETWEEN 1 AND 9007199254740991),
 owner_id TEXT NOT NULL,
 identity_version TEXT GENERATED ALWAYS AS ('owner_v1'::TEXT) STORED,
 account_id TEXT NOT NULL,
 persona_id TEXT NOT NULL,
 selected_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(credit_id,selection_revision),
 UNIQUE(credit_id,selection_revision,account_id,persona_id),
 FOREIGN KEY(credit_id,identity_version,owner_id) REFERENCES reward_ledger_credits(credit_id,identity_version,participation_owner_id),
 FOREIGN KEY(account_id,persona_id) REFERENCES personas(account_id,persona_id),
 FOREIGN KEY(owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind),
 FOREIGN KEY(owner_id,account_id,association_state) REFERENCES guest_owner_associations(guest_owner_id,account_id,state)
);
CREATE TABLE reward_credit_persona_bindings (
 credit_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN('account','guest')),
 identity_version TEXT GENERATED ALWAYS AS ('owner_v1'::TEXT) STORED,
 account_id TEXT NOT NULL,
 persona_id TEXT NOT NULL,
 -- Exhaustive kind distinguishes allocation-created original persona from
 -- claim-created explicit selection. Operator acceptance shares guest_claim.
 binding_source TEXT NOT NULL CHECK(binding_source IN('account_original','guest_claim')),
 account_source_id TEXT GENERATED ALWAYS AS(CASE WHEN owner_kind='account' THEN account_id ELSE NULL END) STORED,
 guest_binding_owner_id TEXT GENERATED ALWAYS AS(CASE WHEN owner_kind='guest' THEN owner_id ELSE NULL END) STORED,
 association_state TEXT GENERATED ALWAYS AS ('bound'::TEXT) STORED,
 selection_revision BIGINT,
 bound_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(credit_id,identity_version,owner_id) REFERENCES reward_ledger_credits(credit_id,identity_version,participation_owner_id),
 FOREIGN KEY(owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind),
 FOREIGN KEY(account_id,persona_id) REFERENCES personas(account_id,persona_id),
 FOREIGN KEY(owner_id,account_source_id) REFERENCES participation_owners(owner_id,account_id),
 FOREIGN KEY(guest_binding_owner_id,account_id,association_state) REFERENCES guest_owner_associations(guest_owner_id,account_id,state),
 FOREIGN KEY(credit_id,selection_revision,account_id,persona_id) REFERENCES reward_credit_recipient_selections(credit_id,selection_revision,account_id,persona_id),
 CHECK((owner_kind='account' AND binding_source='account_original' AND selection_revision IS NULL)
  OR (owner_kind='guest' AND binding_source='guest_claim' AND selection_revision IS NOT NULL AND selection_revision BETWEEN 1 AND 9007199254740991))
);


CREATE FUNCTION guest_financial_component_has_history_private_v1(component_ids TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_owner_associations WHERE guest_owner_id=ANY(component_ids) OR account_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM participation_eligibility_decisions WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM megapot_owner_shares WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM megapot_owner_snapshot_leaves WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM megapot_owner_allocations WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_ledger_credits WHERE participation_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_credit_recipient_selections WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_credit_persona_bindings WHERE owner_id=ANY(component_ids))
 -- Existing claim/effect/right evidence is traced through the SAME immutable
 -- ledger source. No second ledger or account-join omission. A credit itself
 -- already makes history nonempty even before a claim/effect exists.
 OR EXISTS(SELECT 1 FROM megapot_participant_claims c JOIN reward_ledger_credits l USING(credit_id) WHERE l.participation_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_payout_effects e JOIN reward_ledger_credits l USING(credit_id) WHERE l.participation_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_winner_sends e JOIN reward_ledger_credits l USING(credit_id) WHERE l.participation_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM reward_gas_topups e JOIN reward_ledger_credits l USING(credit_id) WHERE l.participation_owner_id=ANY(component_ids))
 -- Actual0227 converted sponsored credit sends to wallet_sponsored_sends and
 -- removed credit_id. Never invent a wallet→credit join; the immutable credit
 -- already keeps all original financial sources nonempty independently.
$$;
CREATE FUNCTION reject_disabled_owner_financial_dml_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 RAISE EXCEPTION 'owner financial producers remain disabled' USING ERRCODE='GP003';
END $$;
CREATE FUNCTION guard_disabled_beneficiary_dispatch_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.beneficiary_version IS DISTINCT FROM OLD.beneficiary_version THEN
  RAISE EXCEPTION 'beneficiary version is immutable' USING ERRCODE='GP003'; END IF;
 IF NEW.beneficiary_version IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'prospective owner drawing/freeze/allocation remains disabled' USING ERRCODE='GP003'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_disabled_owner_credit_dispatch_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.identity_version,NEW.participation_owner_id)
   IS DISTINCT FROM ROW(OLD.identity_version,OLD.participation_owner_id) THEN
  RAISE EXCEPTION 'ledger source identity is immutable' USING ERRCODE='GP003'; END IF;
 IF NEW.identity_version IS DISTINCT FROM 'account_v1' OR NEW.participation_owner_id IS NOT NULL THEN
  RAISE EXCEPTION 'owner financial credit production remains disabled' USING ERRCODE='GP003'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_megapot_beneficiary_version_private_v1(p_leg TEXT,p_drawing NUMERIC,p_expected SMALLINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF p_expected IS NULL OR p_expected NOT IN(2,3) OR NOT EXISTS(
  SELECT 1 FROM megapot_pool_drawings WHERE pool_leg_id=p_leg AND drawing_id=p_drawing AND beneficiary_version=p_expected)
 THEN RAISE EXCEPTION 'drawing beneficiary version unavailable' USING ERRCODE='GP003'; END IF;
 IF p_expected<>2 THEN RAISE EXCEPTION 'v3 dispatcher unavailable' USING ERRCODE='GP003'; END IF;
END $$;


-- Positive structural closure for a DISABLED scaffold. This attests neither
-- complete admission nor claims/payout readiness. All new producers must refuse.
CREATE FUNCTION require_disabled_owner_financial_inventory_private_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE namespace_id OID; owner_id OID; schema_name TEXT; relation_name TEXT; relation_id OID; signature TEXT; function_id OID;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH relation_name IN ARRAY ARRAY['guest_owner_associations','participation_eligibility_decisions','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations','reward_credit_persona_bindings','reward_credit_recipient_selections'] LOOP
  relation_id:=to_regclass(format('%I.%I',schema_name,relation_name));
  IF relation_id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation_id AND relnamespace=namespace_id AND relowner=owner_id AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation_id)
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=relation_id AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid=relation_id AND a.grantee<>owner_id)
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=relation_id AND contype='p' AND convalidated)
   OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=relation_id AND NOT convalidated)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation_id AND tgname='disabled_owner_financial_dml' AND NOT tgisinternal AND tgenabled='O' AND tgtype=62 AND tgfoid='reject_disabled_owner_financial_dml_v1()'::regprocedure)
  THEN RAISE EXCEPTION 'positive disabled financial relation unavailable' USING ERRCODE='GP003'; END IF;

 END LOOP;
  -- The disabled phase has NO accepted producer. Even a migration-owner-created
  -- unexpected financial row makes ALL practice closure unavailable, not empty.
  IF EXISTS(SELECT 1 FROM guest_owner_associations) OR EXISTS(SELECT 1 FROM participation_eligibility_decisions)
   OR EXISTS(SELECT 1 FROM megapot_owner_shares) OR EXISTS(SELECT 1 FROM megapot_owner_snapshot_leaves)
   OR EXISTS(SELECT 1 FROM megapot_owner_allocations) OR EXISTS(SELECT 1 FROM reward_credit_persona_bindings)
   OR EXISTS(SELECT 1 FROM reward_credit_recipient_selections)
   OR EXISTS(SELECT 1 FROM reward_ledger_credits WHERE identity_version<>'account_v1' OR participation_owner_id IS NOT NULL)
  THEN RAISE EXCEPTION 'disabled phase cannot attest financial history as empty' USING ERRCODE='GP003'; END IF;
 FOREACH signature IN ARRAY ARRAY['reject_disabled_owner_financial_dml_v1()','guard_disabled_beneficiary_dispatch_v1()','guard_disabled_owner_credit_dispatch_v1()','require_megapot_beneficiary_version_private_v1(text,numeric,smallint)','guest_financial_component_has_history_private_v1(text[])','require_disabled_owner_financial_inventory_private_v1()'] LOOP
  function_id:=to_regprocedure(format('%I.%s',schema_name,signature));
  IF function_id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=function_id AND f.pronamespace=namespace_id AND f.proowner=owner_id AND f.prosecdef AND f.prokind='f' AND f.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',schema_name)])
   OR EXISTS(SELECT 1 FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=function_id AND a.grantee<>f.proowner)
  THEN RAISE EXCEPTION 'disabled financial function custody unavailable' USING ERRCODE='GP003'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='reward_ledger_credits'::regclass AND attname='identity_version' AND atttypid='text'::regtype AND attnotnull AND NOT attisdropped)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='reward_ledger_credits'::regclass AND attname='participation_owner_id' AND atttypid='text'::regtype AND NOT attisdropped)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reward_ledger_credits'::regclass AND conname='owner_credit_identity_closed' AND contype='c' AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='megapot_pool_drawings'::regclass AND conname='owner_drawing_version_closed' AND contype='c' AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='reward_ledger_credits'::regclass AND tgname='disabled_owner_credit_dispatch' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23 AND tgfoid='guard_disabled_owner_credit_dispatch_v1()'::regprocedure)
 THEN RAISE EXCEPTION 'disabled ledger/version closure unavailable' USING ERRCODE='GP003'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['megapot_pool_drawings','megapot_pool_beneficiary_snapshots','megapot_allocation_batches'] LOOP
  relation_id:=to_regclass(format('%I.%I',schema_name,relation_name));
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation_id AND attname='beneficiary_version' AND atttypid='smallint'::regtype AND attnotnull AND NOT attisdropped)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation_id AND tgname='disabled_beneficiary_dispatch' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23 AND tgfoid='guard_disabled_beneficiary_dispatch_v1()'::regprocedure)
  THEN RAISE EXCEPTION 'positive drawing version dispatch unavailable' USING ERRCODE='GP003'; END IF;
 END LOOP;
END $$;


CREATE OR REPLACE FUNCTION project_megapot_pool_share_from_qualification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  candidate RECORD;
  decided_at TIMESTAMPTZ := clock_timestamp();
  decision_id TEXT;
  eligibility_id TEXT;
  identity_digest TEXT;
  admission_hash TEXT;
BEGIN
  IF NEW.account_id IS NULL OR NEW.persona_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE kind='account' AND account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'retained v2 account provenance unavailable' USING ERRCODE='GP003'; END IF;
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
     AND drawing.beneficiary_version = 2
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


DO $install_disabled_financial_guards$
DECLARE relation_name TEXT; signature TEXT; schema_name TEXT; namespace_id OID; owner_id OID; object_id OID; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF schema_name IN('pg_catalog','information_schema') OR schema_name LIKE 'pg_%' THEN RAISE EXCEPTION 'trusted owner accounting namespace required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['guest_owner_associations','participation_eligibility_decisions','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations','reward_credit_persona_bindings','reward_credit_recipient_selections'] LOOP
  object_id:=to_regclass(format('%I.%I',schema_name,relation_name));
  IF object_id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=object_id AND relnamespace=namespace_id AND relowner=owner_id) THEN RAISE EXCEPTION 'financial relation custody differs'; END IF;
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',schema_name,relation_name);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',schema_name,relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=object_id AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',schema_name,relation_name,grantee_name);
  END LOOP;
  EXECUTE format('CREATE TRIGGER disabled_owner_financial_dml BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.reject_disabled_owner_financial_dml_v1()',schema_name,relation_name,schema_name);
 END LOOP;
 FOREACH relation_name IN ARRAY ARRAY['megapot_pool_drawings','megapot_pool_beneficiary_snapshots','megapot_allocation_batches'] LOOP
  EXECUTE format('CREATE TRIGGER disabled_beneficiary_dispatch BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.guard_disabled_beneficiary_dispatch_v1()',schema_name,relation_name,schema_name);
 END LOOP;
 CREATE TRIGGER disabled_owner_credit_dispatch BEFORE INSERT OR UPDATE ON reward_ledger_credits FOR EACH ROW EXECUTE FUNCTION guard_disabled_owner_credit_dispatch_v1();
 FOREACH signature IN ARRAY ARRAY['reject_disabled_owner_financial_dml_v1()','guard_disabled_beneficiary_dispatch_v1()','guard_disabled_owner_credit_dispatch_v1()','require_megapot_beneficiary_version_private_v1(text,numeric,smallint)','guest_financial_component_has_history_private_v1(text[])','require_disabled_owner_financial_inventory_private_v1()','require_guest_practice_only_schema_phase_v1()','guest_authority_component_is_empty_v1(text)','project_megapot_pool_share_from_qualification()'] LOOP
  object_id:=to_regprocedure(format('%I.%s',schema_name,signature));
  IF object_id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=object_id AND pronamespace=namespace_id AND proowner=owner_id) THEN RAISE EXCEPTION 'accounting routine custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',schema_name,signature);
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',schema_name,signature,schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',schema_name,signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=object_id AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',schema_name,signature,grantee_name);
  END LOOP;
 END LOOP;
 -- CREATE OR REPLACE resets function configuration. Preserve the existing
 -- controlled reader surface while explicitly re-pinning its unchanged frame;
 -- do not revoke any previously reviewed nonowner leaf grant here.
 object_id:=to_regprocedure(format('%I.list_guest_practice_participations_v1(jsonb,text,integer)',schema_name));
 IF object_id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=object_id AND pronamespace=namespace_id AND proowner=owner_id) THEN RAISE EXCEPTION 'practice reader custody differs'; END IF;
 EXECUTE format('ALTER FUNCTION %I.list_guest_practice_participations_v1(jsonb,text,integer) SET search_path TO pg_catalog,%I,pg_temp',schema_name,schema_name);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.list_guest_practice_participations_v1(jsonb,text,integer) FROM PUBLIC',schema_name);
 -- No EXECUTE grants needed to invoke an already-created trigger. Its narrow
 -- definer authority is installed BEFORE removing direct shared-table INSERT.
 REVOKE INSERT ON megapot_pool_shares FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='megapot_pool_shares'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner AND a.privilege_type='INSERT' LOOP
  EXECUTE format('REVOKE INSERT ON TABLE %I.megapot_pool_shares FROM %I CASCADE',schema_name,grantee_name);
 END LOOP;
 -- Explicit column INSERT ACLs survive a table-level REVOKE. Close those too;
 -- role inheritance is covered by visiting every actual nonowner grantee.
 FOR relation_name,grantee_name IN SELECT attr.attname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
  FROM pg_attribute attr JOIN pg_class c ON c.oid=attr.attrelid CROSS JOIN LATERAL aclexplode(attr.attacl) a
  WHERE c.oid='megapot_pool_shares'::regclass AND attr.attnum>0 AND NOT attr.attisdropped
   AND a.grantee<>c.relowner AND a.privilege_type='INSERT' LOOP
  EXECUTE format('REVOKE INSERT (%I) ON TABLE %I.megapot_pool_shares FROM %s CASCADE',relation_name,schema_name,CASE WHEN grantee_name='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee_name) END);
 END LOOP;
END $install_disabled_financial_guards$;
-- Only after all relations, blocking guards and private function frames exist:
-- commit one protected POSITIVE disabled phase with its complete history closure.
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='disabled_owner_financial_history_v1'
 WHERE singleton AND phase='practice_only_owner_audio_producer_history_v5';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check
 CHECK(phase='disabled_owner_financial_history_v1');
SELECT require_guest_practice_only_schema_phase_v1();
-- Frozen managed readiness candidate still expects actualv5/full263/body hashes:
-- it MUST refuse this checkpoint, until a separately reviewed successor exists.
-- No SELECT/admit/attachment/selection/claim/payout grants or enabled producer here.
