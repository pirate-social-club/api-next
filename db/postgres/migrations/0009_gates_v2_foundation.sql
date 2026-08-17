-- Gates v2 final greenfield foundation.
--
-- This migration was derived from the reviewed final PostgreSQL catalog before
-- the first durable deployment. Provider and claim identifiers remain text-backed
-- so adding an adapter never requires a schema migration.

CREATE TABLE action_challenges (
    action_challenge_id text NOT NULL,
    action_intent_id text NOT NULL,
    provider_id text NOT NULL,
    challenge_hash text NOT NULL,
    challenge_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_challenges_challenge_hash_check CHECK ((challenge_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_challenges_provider_not_blank CHECK ((btrim(provider_id) <> ''::text)),
    CONSTRAINT action_challenges_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'verified'::text, 'expired'::text, 'canceled'::text])))
);


--
-- Name: action_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE action_grants (
    action_grant_id text NOT NULL,
    action_intent_id text NOT NULL,
    action_challenge_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    grant_nonce text NOT NULL,
    signed_grant text NOT NULL,
    signer_key_id text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_grants_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_grants_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(grant_nonce) <> ''::text) AND (btrim(signed_grant) <> ''::text) AND (btrim(signer_key_id) <> ''::text)))
);


--
-- Name: action_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE action_intents (
    action_intent_id text NOT NULL,
    user_id text NOT NULL,
    community_id text,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    intent_binding_hash text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_intents_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_intents_identifiers_not_blank CHECK (((btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(idempotency_key) <> ''::text))),
    CONSTRAINT action_intents_intent_binding_hash_check CHECK ((intent_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_intents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fulfilled'::text, 'expired'::text, 'canceled'::text])))
);


--
-- Name: active_subject_key_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE active_subject_key_bindings (
    subject_key_id text NOT NULL,
    binding_event_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    user_id text NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_subject_key_bindings_binding_epoch_check CHECK ((binding_epoch > 0))
);


--
-- Name: assertion_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE assertion_bindings (
    binding_group_id text NOT NULL,
    user_id text NOT NULL,
    binding_mode text NOT NULL,
    subject_key_id text,
    evidence_receipt_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_binding_event_id text,
    subject_binding_epoch bigint,
    CONSTRAINT assertion_bindings_anchor_shape_check CHECK ((((binding_mode = 'same_subject'::text) AND (subject_key_id IS NOT NULL) AND (subject_binding_event_id IS NOT NULL) AND (subject_binding_epoch IS NOT NULL) AND (evidence_receipt_id IS NULL)) OR ((binding_mode = 'same_receipt'::text) AND (subject_key_id IS NULL) AND (subject_binding_event_id IS NULL) AND (subject_binding_epoch IS NULL) AND (evidence_receipt_id IS NOT NULL)))),
    CONSTRAINT assertion_bindings_binding_mode_check CHECK ((binding_mode = ANY (ARRAY['same_subject'::text, 'same_receipt'::text])))
);


--
-- Name: assertion_revalidation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE assertion_revalidation_events (
    assertion_revalidation_event_id text NOT NULL,
    assertion_id text NOT NULL,
    user_id text NOT NULL,
    evidence_receipt_id text,
    observation_id text,
    outcome text NOT NULL,
    reason text,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assertion_revalidation_events_outcome_check CHECK ((outcome = ANY (ARRAY['accepted'::text, 'stale'::text, 'revoked'::text, 'indeterminate'::text]))),
    CONSTRAINT assertion_revalidation_source_check CHECK (((evidence_receipt_id IS NOT NULL) OR (observation_id IS NOT NULL)))
);


--
-- Name: assertions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE assertions (
    assertion_id text NOT NULL,
    binding_group_id text NOT NULL,
    evidence_receipt_id text NOT NULL,
    subject_key_id text,
    user_id text NOT NULL,
    claim_id text NOT NULL,
    assertion_value jsonb NOT NULL,
    assurance text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assertions_identifiers_not_blank CHECK (((btrim(claim_id) <> ''::text) AND (btrim(assurance) <> ''::text)))
);


--
-- Name: community_policy_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE community_policy_current (
    community_id text NOT NULL,
    policy_key text NOT NULL,
    policy_version_id text NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: decision_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE decision_records (
    decision_record_id text NOT NULL,
    community_id text NOT NULL,
    user_id text NOT NULL,
    policy_version_id text NOT NULL,
    policy_hash text NOT NULL,
    evaluation_mode text NOT NULL,
    outcome text NOT NULL,
    winning_witness jsonb DEFAULT '[]'::jsonb NOT NULL,
    trace jsonb DEFAULT '[]'::jsonb NOT NULL,
    indeterminate_reason text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT decision_records_evaluation_mode_check CHECK ((evaluation_mode = ANY (ARRAY['preview'::text, 'enforce'::text, 'diagnose'::text]))),
    CONSTRAINT decision_records_outcome_check CHECK ((outcome = ANY (ARRAY['pass'::text, 'fail'::text, 'needs_evidence'::text, 'indeterminate'::text]))),
    CONSTRAINT decision_records_pass_witness_check CHECK (((outcome <> 'pass'::text) OR (jsonb_array_length(winning_witness) > 0))),
    CONSTRAINT decision_records_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT decision_records_request_not_blank CHECK (((request_id IS NULL) OR (btrim(request_id) <> ''::text))),
    CONSTRAINT decision_records_witness_shape_check CHECK (((jsonb_typeof(winning_witness) = 'array'::text) AND (jsonb_typeof(trace) = 'array'::text)))
);


--
-- Name: evidence_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE evidence_receipts (
    evidence_receipt_id text NOT NULL,
    proof_session_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    evidence_kind text NOT NULL,
    evidence_hash text NOT NULL,
    receipt_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    provenance_kind text DEFAULT 'proof_session'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_key_id text,
    subject_binding_event_id text,
    subject_binding_epoch bigint,
    CONSTRAINT evidence_receipts_evidence_hash_check CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_receipts_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text) AND (btrim(evidence_kind) <> ''::text))),
    CONSTRAINT evidence_receipts_payload_object_check CHECK ((jsonb_typeof(receipt_metadata) = 'object'::text)),
    CONSTRAINT evidence_receipts_provenance_kind_check CHECK ((provenance_kind = 'proof_session'::text)),
    CONSTRAINT evidence_receipts_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT evidence_receipts_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT evidence_receipts_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT evidence_receipts_subject_binding_shape_check CHECK ((((subject_key_id IS NULL) AND (subject_binding_event_id IS NULL) AND (subject_binding_epoch IS NULL)) OR ((subject_key_id IS NOT NULL) AND (subject_binding_event_id IS NOT NULL) AND (subject_binding_epoch IS NOT NULL))))
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE observations (
    observation_id text NOT NULL,
    user_id text NOT NULL,
    resolver_id text NOT NULL,
    source_id text NOT NULL,
    claim_id text NOT NULL,
    observation_kind text NOT NULL,
    subject_ref text NOT NULL,
    observation_value jsonb NOT NULL,
    chain_id text,
    account_caip10 text,
    asset_caip19 text,
    aggregation_mode text NOT NULL,
    trust_mode text NOT NULL,
    completeness text NOT NULL,
    snapshot_ref jsonb NOT NULL,
    source_response_hash text NOT NULL,
    descriptor_version text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observations_aggregation_mode_check CHECK ((aggregation_mode = ANY (ARRAY['single_wallet'::text, 'any_wallet'::text, 'sum_across_wallets'::text]))),
    CONSTRAINT observations_completeness_check CHECK ((completeness = ANY (ARRAY['complete'::text, 'partial'::text, 'unknown'::text]))),
    CONSTRAINT observations_identifiers_not_blank CHECK (((btrim(resolver_id) <> ''::text) AND (btrim(source_id) <> ''::text) AND (btrim(claim_id) <> ''::text) AND (btrim(observation_kind) <> ''::text) AND (btrim(subject_ref) <> ''::text) AND (btrim(aggregation_mode) <> ''::text) AND (btrim(descriptor_version) <> ''::text))),
    CONSTRAINT observations_observation_kind_check CHECK ((observation_kind = ANY (ARRAY['asset_inventory'::text, 'asset_balance'::text, 'disclosed_predicate'::text]))),
    CONSTRAINT observations_snapshot_shape_check CHECK (((jsonb_typeof(snapshot_ref) = 'object'::text) AND (jsonb_typeof((snapshot_ref -> 'kind'::text)) = 'string'::text) AND (jsonb_typeof((snapshot_ref -> 'reference'::text)) = 'string'::text) AND (btrim((snapshot_ref ->> 'kind'::text)) <> ''::text) AND (btrim((snapshot_ref ->> 'reference'::text)) <> ''::text) AND ((snapshot_ref ->> 'kind'::text) = ANY (ARRAY['block'::text, 'provider_snapshot'::text, 'receipt'::text])))),
    CONSTRAINT observations_source_response_hash_check CHECK ((source_response_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT observations_trust_mode_check CHECK ((trust_mode = ANY (ARRAY['onchain_pinned'::text, 'provider_asserted'::text]))),
    CONSTRAINT observations_value_object_check CHECK ((jsonb_typeof(observation_value) = 'object'::text)),
    CONSTRAINT observations_variant_shape_check CHECK ((((observation_value ->> 'kind'::text) = observation_kind) AND (((observation_kind = ANY (ARRAY['asset_inventory'::text, 'asset_balance'::text])) AND (chain_id IS NOT NULL) AND (account_caip10 IS NOT NULL) AND (asset_caip19 IS NOT NULL) AND (chain_id = (observation_value ->> 'chain_id'::text)) AND (account_caip10 = (observation_value ->> 'account_id'::text)) AND (asset_caip19 = (observation_value ->> 'asset_id'::text))) OR ((observation_kind = 'disclosed_predicate'::text) AND (chain_id IS NULL) AND (account_caip10 IS NULL) AND (asset_caip19 IS NULL)))))
);


--
-- Name: policy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE policy_versions (
    policy_version_id text NOT NULL,
    community_id text NOT NULL,
    policy_key text NOT NULL,
    revision integer NOT NULL,
    policy_hash text NOT NULL,
    policy jsonb NOT NULL,
    compiled_plan jsonb NOT NULL,
    compiler_version text NOT NULL,
    uniqueness_model jsonb NOT NULL,
    created_by_user_id text,
    published_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_purpose text NOT NULL,
    uniqueness_authority_id text,
    CONSTRAINT policy_versions_identifiers_not_blank CHECK (((btrim(policy_key) <> ''::text) AND (btrim(compiler_version) <> ''::text))),
    CONSTRAINT policy_versions_json_shape_check CHECK (((jsonb_typeof(policy) = 'object'::text) AND (jsonb_typeof(compiled_plan) = 'object'::text) AND (jsonb_typeof(uniqueness_model) = 'object'::text))),
    CONSTRAINT policy_versions_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT policy_versions_policy_purpose_check CHECK ((policy_purpose = ANY (ARRAY['access'::text, 'reward'::text]))),
    CONSTRAINT policy_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT policy_versions_reward_authority_check CHECK ((((policy_purpose = 'access'::text) AND (uniqueness_authority_id IS NULL)) OR ((policy_purpose = 'reward'::text) AND (uniqueness_authority_id IS NOT NULL) AND ((uniqueness_model ->> 'kind'::text) = 'single_authority'::text) AND ((uniqueness_model ->> 'authority_id'::text) = uniqueness_authority_id))))
);


--
-- Name: proof_session_completion_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE proof_session_completion_events (
    completion_event_id text NOT NULL,
    proof_session_id text NOT NULL,
    actor_id text NOT NULL,
    idempotency_key text NOT NULL,
    terminal_status text NOT NULL,
    result_hash text NOT NULL,
    terminal_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proof_session_completion_events_not_blank CHECK (((btrim(completion_event_id) <> ''::text) AND (btrim(idempotency_key) <> ''::text))),
    CONSTRAINT proof_session_completion_events_result_hash_check CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT proof_session_completion_events_terminal_status_check CHECK ((terminal_status = ANY (ARRAY['completed'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: proof_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE proof_sessions (
    proof_session_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    request_hash text NOT NULL,
    provider_id text NOT NULL,
    method text NOT NULL,
    issuer text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    status text NOT NULL,
    upstream_session_ref text,
    requested_claim_ids jsonb NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_binding_intent text NOT NULL,
    completion_idempotency_key text,
    completion_result_hash text,
    terminal_at timestamp with time zone,
    CONSTRAINT proof_sessions_identifiers_not_blank CHECK (((btrim(intent_id) <> ''::text) AND (btrim(request_hash) <> ''::text) AND (btrim(provider_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text))),
    CONSTRAINT proof_sessions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT proof_sessions_requested_claims_check CHECK (((jsonb_typeof(requested_claim_ids) = 'array'::text) AND (jsonb_array_length(requested_claim_ids) > 0))),
    CONSTRAINT proof_sessions_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT proof_sessions_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT proof_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT proof_sessions_subject_binding_intent_check CHECK ((subject_binding_intent = ANY (ARRAY['establish'::text, 'recover'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_terminal_shape_check CHECK ((((status = 'pending'::text) AND (completion_idempotency_key IS NULL) AND (completion_result_hash IS NULL) AND (terminal_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at = terminal_at)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at IS NULL))))
);


--
-- Name: reward_subject_consumptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE reward_subject_consumptions (
    reward_subject_consumption_id text NOT NULL,
    campaign_id text NOT NULL,
    subject_key_id text NOT NULL,
    user_id text NOT NULL,
    binding_event_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    evidence_receipt_id text,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_subject_consumptions_binding_epoch_check CHECK ((binding_epoch > 0))
);


--
-- Name: reward_uniqueness_authorities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE reward_uniqueness_authorities (
    campaign_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text NOT NULL,
    issuer_rp_action_scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_uniqueness_authorities_not_blank CHECK (((btrim(campaign_id) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(issuer_rp_scope) <> ''::text) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT reward_uniqueness_authorities_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text]))),
    CONSTRAINT reward_uniqueness_authorities_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_action_scope IS NOT NULL))))
);


--
-- Name: subject_key_binding_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE subject_key_binding_events (
    binding_event_id text NOT NULL,
    subject_key_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    user_id text NOT NULL,
    proof_session_id text NOT NULL,
    binding_kind text NOT NULL,
    previous_binding_event_id text,
    idempotency_key text NOT NULL,
    bound_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_key_binding_events_binding_epoch_check CHECK ((binding_epoch > 0)),
    CONSTRAINT subject_key_binding_events_binding_kind_check CHECK ((binding_kind = ANY (ARRAY['initial'::text, 'recovery'::text]))),
    CONSTRAINT subject_key_binding_events_not_blank CHECK (((btrim(binding_event_id) <> ''::text) AND (btrim(idempotency_key) <> ''::text)))
);


--
-- Name: subject_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE subject_keys (
    subject_key_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    subject_digest text NOT NULL,
    digest_algorithm text DEFAULT 'sha256'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_keys_identifiers_not_blank CHECK (((btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(subject_digest) <> ''::text) AND (btrim(digest_algorithm) <> ''::text))),
    CONSTRAINT subject_keys_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text]))),
    CONSTRAINT subject_keys_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)))),
    CONSTRAINT subject_keys_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT subject_keys_sha256_digest_check CHECK (((digest_algorithm = 'sha256'::text) AND (subject_digest ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: used_action_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE used_action_grants (
    grant_nonce text NOT NULL,
    action_grant_id text NOT NULL,
    action_intent_id text NOT NULL,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    action_result_ref text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT used_action_grants_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT used_action_grants_identifiers_not_blank CHECK (((btrim(grant_nonce) <> ''::text) AND (btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(action_result_ref) <> ''::text)))
);


--
-- Name: action_challenges action_challenges_id_intent_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_id_intent_provider_unique UNIQUE (action_challenge_id, action_intent_id, provider_id);


--
-- Name: action_challenges action_challenges_intent_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_intent_hash_unique UNIQUE (action_intent_id, challenge_hash);


--
-- Name: action_challenges action_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_pkey PRIMARY KEY (action_challenge_id);


--
-- Name: action_grants action_grants_consumption_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_consumption_identity_unique UNIQUE (action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash);


--
-- Name: action_grants action_grants_intent_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_unique UNIQUE (action_intent_id);


--
-- Name: action_grants action_grants_nonce_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_nonce_unique UNIQUE (grant_nonce);


--
-- Name: action_grants action_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_pkey PRIMARY KEY (action_grant_id);


--
-- Name: action_intents action_intents_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_identity_unique UNIQUE (action_intent_id, user_id, action_kind, action_scope, action_payload_hash);


--
-- Name: action_intents action_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_pkey PRIMARY KEY (action_intent_id);


--
-- Name: action_intents action_intents_user_action_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_user_action_idempotency_unique UNIQUE (user_id, action_kind, idempotency_key);


--
-- Name: active_subject_key_bindings active_subject_key_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_pkey PRIMARY KEY (subject_key_id);


--
-- Name: active_subject_key_bindings active_subject_key_bindings_subject_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_subject_user_unique UNIQUE (subject_key_id, user_id);


--
-- Name: assertion_bindings assertion_bindings_id_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_id_user_unique UNIQUE (binding_group_id, user_id);


--
-- Name: assertion_bindings assertion_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_pkey PRIMARY KEY (binding_group_id);


--
-- Name: assertion_revalidation_events assertion_revalidation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_events_pkey PRIMARY KEY (assertion_revalidation_event_id);


--
-- Name: assertions assertions_id_binding_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_id_binding_unique UNIQUE (assertion_id, binding_group_id);


--
-- Name: assertions assertions_id_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_id_user_unique UNIQUE (assertion_id, user_id);


--
-- Name: assertions assertions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_pkey PRIMARY KEY (assertion_id);


--
-- Name: community_policy_current community_policy_current_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_pk PRIMARY KEY (community_id, policy_key);


--
-- Name: decision_records decision_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_pkey PRIMARY KEY (decision_record_id);


--
-- Name: evidence_receipts evidence_receipts_binding_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_binding_identity_unique UNIQUE (evidence_receipt_id, subject_key_id, subject_binding_event_id, subject_binding_epoch, user_id);


--
-- Name: evidence_receipts evidence_receipts_id_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_id_user_unique UNIQUE (evidence_receipt_id, user_id);


--
-- Name: evidence_receipts evidence_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_pkey PRIMARY KEY (evidence_receipt_id);


--
-- Name: observations observations_id_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_id_user_unique UNIQUE (observation_id, user_id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (observation_id);


--
-- Name: policy_versions policy_versions_community_id_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_id_hash_unique UNIQUE (community_id, policy_version_id, policy_hash);


--
-- Name: policy_versions policy_versions_community_key_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_key_version_unique UNIQUE (community_id, policy_key, policy_version_id);


--
-- Name: policy_versions policy_versions_community_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_version_unique UNIQUE (community_id, policy_version_id);


--
-- Name: policy_versions policy_versions_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_hash_unique UNIQUE (community_id, policy_key, policy_hash);


--
-- Name: policy_versions policy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (policy_version_id);


--
-- Name: policy_versions policy_versions_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_revision_unique UNIQUE (community_id, policy_key, revision);


--
-- Name: proof_session_completion_events proof_session_completion_events_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_idempotency_unique UNIQUE (proof_session_id, idempotency_key);


--
-- Name: proof_session_completion_events proof_session_completion_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_pkey PRIMARY KEY (completion_event_id);


--
-- Name: proof_session_completion_events proof_session_completion_events_session_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_session_unique UNIQUE (proof_session_id);


--
-- Name: proof_sessions proof_sessions_actor_intent_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_actor_intent_unique UNIQUE (actor_id, intent_id);


--
-- Name: proof_sessions proof_sessions_id_actor_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_id_actor_unique UNIQUE (proof_session_id, actor_id);


--
-- Name: proof_sessions proof_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_pkey PRIMARY KEY (proof_session_id);


--
-- Name: reward_subject_consumptions reward_subject_consumptions_campaign_subject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_campaign_subject_unique UNIQUE (campaign_id, subject_key_id);


--
-- Name: reward_subject_consumptions reward_subject_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_pkey PRIMARY KEY (reward_subject_consumption_id);


--
-- Name: reward_uniqueness_authorities reward_uniqueness_authorities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_uniqueness_authorities
    ADD CONSTRAINT reward_uniqueness_authorities_pkey PRIMARY KEY (campaign_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_event_subject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_event_subject_unique UNIQUE (binding_event_id, subject_key_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_pkey PRIMARY KEY (binding_event_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_receipt_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_receipt_identity_unique UNIQUE (binding_event_id, subject_key_id, binding_epoch, user_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_subject_epoch_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_epoch_unique UNIQUE (subject_key_id, binding_epoch);


--
-- Name: subject_key_binding_events subject_key_binding_events_subject_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_idempotency_unique UNIQUE (subject_key_id, idempotency_key);


--
-- Name: subject_keys subject_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_keys
    ADD CONSTRAINT subject_keys_pkey PRIMARY KEY (subject_key_id);


--
-- Name: used_action_grants used_action_grants_grant_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_grant_unique UNIQUE (action_grant_id);


--
-- Name: used_action_grants used_action_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_pkey PRIMARY KEY (grant_nonce);


--
-- Name: action_challenges_intent_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_challenges_intent_status_idx ON action_challenges USING btree (action_intent_id, status, expires_at DESC);


--
-- Name: action_grants_user_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_grants_user_expiry_idx ON action_grants USING btree (user_id, expires_at DESC, action_grant_id);


--
-- Name: action_intents_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_intents_expiry_idx ON action_intents USING btree (status, expires_at, action_intent_id);


--
-- Name: active_subject_key_bindings_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_subject_key_bindings_user_idx ON active_subject_key_bindings USING btree (user_id, activated_at DESC, subject_key_id);


--
-- Name: assertion_bindings_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assertion_bindings_user_idx ON assertion_bindings USING btree (user_id, created_at DESC);


--
-- Name: assertion_revalidation_assertion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assertion_revalidation_assertion_idx ON assertion_revalidation_events USING btree (assertion_id, observed_at DESC);


--
-- Name: assertion_revalidation_receipt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assertion_revalidation_receipt_idx ON assertion_revalidation_events USING btree (evidence_receipt_id, observed_at DESC) WHERE (evidence_receipt_id IS NOT NULL);


--
-- Name: assertions_binding_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assertions_binding_claim_idx ON assertions USING btree (binding_group_id, claim_id);


--
-- Name: assertions_user_claim_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assertions_user_claim_observed_idx ON assertions USING btree (user_id, claim_id, observed_at DESC);


--
-- Name: community_policy_current_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX community_policy_current_version_idx ON community_policy_current USING btree (policy_version_id);


--
-- Name: decision_records_policy_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX decision_records_policy_created_idx ON decision_records USING btree (policy_version_id, created_at DESC, decision_record_id);


--
-- Name: decision_records_request_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX decision_records_request_uidx ON decision_records USING btree (community_id, user_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: decision_records_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX decision_records_user_created_idx ON decision_records USING btree (user_id, created_at DESC, decision_record_id);


--
-- Name: evidence_receipts_provider_evidence_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX evidence_receipts_provider_evidence_uidx ON evidence_receipts USING btree (provider_id, environment, evidence_hash);


--
-- Name: evidence_receipts_session_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX evidence_receipts_session_hash_uidx ON evidence_receipts USING btree (proof_session_id, evidence_hash) WHERE (proof_session_id IS NOT NULL);


--
-- Name: evidence_receipts_session_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evidence_receipts_session_observed_idx ON evidence_receipts USING btree (proof_session_id, observed_at DESC, evidence_receipt_id);


--
-- Name: evidence_receipts_user_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evidence_receipts_user_observed_idx ON evidence_receipts USING btree (user_id, observed_at DESC, evidence_receipt_id);


--
-- Name: observations_chain_asset_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_chain_asset_observed_idx ON observations USING btree (user_id, chain_id, asset_caip19, observed_at DESC);


--
-- Name: observations_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_snapshot_idx ON observations USING gin (snapshot_ref);


--
-- Name: observations_snapshot_response_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_snapshot_response_idx ON observations USING btree (resolver_id, source_response_hash);


--
-- Name: observations_user_kind_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_user_kind_observed_idx ON observations USING btree (user_id, observation_kind, observed_at DESC, observation_id);


--
-- Name: proof_sessions_actor_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proof_sessions_actor_status_idx ON proof_sessions USING btree (actor_id, status, created_at DESC);


--
-- Name: proof_sessions_provider_ref_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX proof_sessions_provider_ref_uidx ON proof_sessions USING btree (provider_id, upstream_session_ref) WHERE (upstream_session_ref IS NOT NULL);


--
-- Name: subject_key_binding_events_user_bound_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_key_binding_events_user_bound_idx ON subject_key_binding_events USING btree (user_id, bound_at DESC, binding_event_id);


--
-- Name: subject_keys_action_scope_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subject_keys_action_scope_uidx ON subject_keys USING btree (issuer, method, issuer_rp_scope, issuer_rp_action_scope, subject_digest) WHERE (scope_kind = 'issuer_rp_action_scope'::text);


--
-- Name: subject_keys_rp_scope_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subject_keys_rp_scope_uidx ON subject_keys USING btree (issuer, method, issuer_rp_scope, subject_digest) WHERE (scope_kind = 'issuer_rp_scope'::text);


--
-- Name: subject_keys_scope_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_keys_scope_created_idx ON subject_keys USING btree (issuer, method, scope_kind, created_at DESC, subject_key_id);


--
-- Name: used_action_grants_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX used_action_grants_intent_idx ON used_action_grants USING btree (action_intent_id, consumed_at DESC);

-- Trigger functions are defined after their table row types and before triggers.

CREATE OR REPLACE FUNCTION gates_v2_active_binding_projection_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'active subject key bindings are trigger-maintained'
      USING ERRCODE = '23514', CONSTRAINT = 'active_subject_key_bindings_projection_only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'gates_v2_append_only';
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_project_subject_key_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO active_subject_key_bindings (
    subject_key_id,
    binding_event_id,
    binding_epoch,
    user_id,
    activated_at,
    updated_at
  ) VALUES (
    NEW.subject_key_id,
    NEW.binding_event_id,
    NEW.binding_epoch,
    NEW.user_id,
    NEW.bound_at,
    now()
  )
  ON CONFLICT (subject_key_id) DO UPDATE SET
    binding_event_id = EXCLUDED.binding_event_id,
    binding_epoch = EXCLUDED.binding_epoch,
    user_id = EXCLUDED.user_id,
    activated_at = EXCLUDED.activated_at,
    updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_require_terminal_completion_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status <> 'pending' AND NOT EXISTS (
    SELECT 1
      FROM proof_session_completion_events
     WHERE proof_session_id = NEW.proof_session_id
       AND actor_id = NEW.actor_id
       AND terminal_status = NEW.status
       AND idempotency_key = NEW.completion_idempotency_key
       AND result_hash = NEW.completion_result_hash
       AND terminal_at = NEW.terminal_at
  ) THEN
    RAISE EXCEPTION 'terminal proof session requires its matching completion event'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_terminal_completion_event';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_assertion_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  binding_mode_value TEXT;
  binding_subject_key_id TEXT;
  binding_receipt_id TEXT;
  binding_event_id TEXT;
  binding_epoch BIGINT;
  receipt_subject_key_id TEXT;
  receipt_binding_event_id TEXT;
  receipt_binding_epoch BIGINT;
BEGIN
  SELECT
      binding_mode,
      subject_key_id,
      evidence_receipt_id,
      subject_binding_event_id,
      subject_binding_epoch
    INTO
      binding_mode_value,
      binding_subject_key_id,
      binding_receipt_id,
      binding_event_id,
      binding_epoch
    FROM assertion_bindings
   WHERE binding_group_id = NEW.binding_group_id
     AND user_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assertion binding group is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  SELECT subject_key_id, subject_binding_event_id, subject_binding_epoch
    INTO receipt_subject_key_id, receipt_binding_event_id, receipt_binding_epoch
    FROM evidence_receipts
   WHERE evidence_receipt_id = NEW.evidence_receipt_id
     AND user_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assertion evidence receipt is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.subject_key_id IS DISTINCT FROM receipt_subject_key_id THEN
    RAISE EXCEPTION 'assertion subject key must match its evidence receipt subject key'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_receipt_subject_match';
  END IF;

  IF binding_mode_value = 'same_subject'
    AND (
      NEW.subject_key_id IS DISTINCT FROM binding_subject_key_id
      OR binding_event_id IS DISTINCT FROM receipt_binding_event_id
      OR binding_epoch IS DISTINCT FROM receipt_binding_epoch
    ) THEN
    RAISE EXCEPTION 'assertion subject binding must match its receipt binding epoch'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_subject_binding_match';
  END IF;

  IF binding_mode_value = 'same_receipt'
    AND NEW.evidence_receipt_id IS DISTINCT FROM binding_receipt_id THEN
    RAISE EXCEPTION 'assertion receipt must match its same-receipt binding anchor'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_receipt_binding_match';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_evidence_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  session_record proof_sessions%ROWTYPE;
  subject_record subject_keys%ROWTYPE;
  active_binding active_subject_key_bindings%ROWTYPE;
BEGIN
  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence receipt session is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.provider_id IS DISTINCT FROM session_record.provider_id
    OR NEW.issuer IS DISTINCT FROM session_record.issuer
    OR NEW.method IS DISTINCT FROM session_record.method
    OR NEW.scope_kind IS DISTINCT FROM session_record.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM session_record.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM session_record.issuer_rp_action_scope
    OR NEW.protocol_version IS DISTINCT FROM session_record.protocol_version
    OR NEW.environment IS DISTINCT FROM session_record.environment THEN
    RAISE EXCEPTION 'evidence receipt metadata must match its proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_session_metadata_match';
  END IF;

  IF NEW.subject_key_id IS NOT NULL THEN
    SELECT * INTO subject_record
      FROM subject_keys
     WHERE subject_key_id = NEW.subject_key_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence receipt subject key is missing'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.issuer IS DISTINCT FROM subject_record.issuer
      OR NEW.method IS DISTINCT FROM subject_record.method
      OR NEW.scope_kind IS DISTINCT FROM subject_record.scope_kind
      OR NEW.issuer_rp_scope IS DISTINCT FROM subject_record.issuer_rp_scope
      OR NEW.issuer_rp_action_scope IS DISTINCT FROM subject_record.issuer_rp_action_scope THEN
      RAISE EXCEPTION 'evidence receipt metadata must match its subject key'
        USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_subject_metadata_match';
    END IF;

    SELECT * INTO active_binding
      FROM active_subject_key_bindings
     WHERE subject_key_id = NEW.subject_key_id;

    IF NOT FOUND
      OR active_binding.binding_event_id IS DISTINCT FROM NEW.subject_binding_event_id
      OR active_binding.binding_epoch IS DISTINCT FROM NEW.subject_binding_epoch
      OR active_binding.user_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'evidence receipt must use the active subject binding epoch'
        USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_active_binding_match';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_completion_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  session_record proof_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.actor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'completion event session is missing or belongs to another actor'
      USING ERRCODE = '23503';
  END IF;

  IF session_record.status IS DISTINCT FROM NEW.terminal_status
    OR session_record.completion_idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR session_record.completion_result_hash IS DISTINCT FROM NEW.result_hash
    OR session_record.terminal_at IS DISTINCT FROM NEW.terminal_at THEN
    RAISE EXCEPTION 'completion event must match the terminal proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_session_completion_events_session_match';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proof sessions cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'proof sessions must begin pending'
        USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.proof_session_id IS DISTINCT FROM OLD.proof_session_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM OLD.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM OLD.issuer_rp_action_scope
    OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.upstream_session_ref IS DISTINCT FROM OLD.upstream_session_ref
    OR NEW.requested_claim_ids IS DISTINCT FROM OLD.requested_claim_ids
    OR NEW.subject_binding_intent IS DISTINCT FROM OLD.subject_binding_intent
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'proof session identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'terminal proof sessions are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF NEW.status = 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('completed', 'failed', 'expired') THEN
    RAISE EXCEPTION 'invalid proof session transition'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_reward_subject_consumption()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  authority reward_uniqueness_authorities%ROWTYPE;
  subject_record subject_keys%ROWTYPE;
BEGIN
  SELECT * INTO authority
    FROM reward_uniqueness_authorities
   WHERE campaign_id = NEW.campaign_id;
  SELECT * INTO subject_record
    FROM subject_keys
   WHERE subject_key_id = NEW.subject_key_id;

  IF authority.issuer IS DISTINCT FROM subject_record.issuer
    OR authority.method IS DISTINCT FROM subject_record.method
    OR authority.scope_kind IS DISTINCT FROM subject_record.scope_kind
    OR authority.issuer_rp_scope IS DISTINCT FROM subject_record.issuer_rp_scope
    OR authority.issuer_rp_action_scope IS DISTINCT FROM subject_record.issuer_rp_action_scope THEN
    RAISE EXCEPTION 'reward subject must match the campaign uniqueness authority'
      USING ERRCODE = '23514', CONSTRAINT = 'reward_subject_consumptions_authority_match';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_subject_key_binding_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_binding active_subject_key_bindings%ROWTYPE;
  session_record proof_sessions%ROWTYPE;
BEGIN
  PERFORM 1
    FROM subject_keys
   WHERE subject_key_id = NEW.subject_key_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject key binding refers to a missing subject key'
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject key binding session is missing or belongs to another actor'
      USING ERRCODE = '23503';
  END IF;

  IF session_record.status <> 'pending'
    OR NEW.bound_at < session_record.started_at
    OR NEW.bound_at >= session_record.expires_at THEN
    RAISE EXCEPTION 'subject key binding requires a live pending proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_live_session';
  END IF;

  SELECT * INTO current_binding
    FROM active_subject_key_bindings
   WHERE subject_key_id = NEW.subject_key_id
   FOR UPDATE;

  IF NOT FOUND THEN
    IF NEW.binding_epoch <> 1
      OR NEW.binding_kind <> 'initial'
      OR session_record.subject_binding_intent <> 'establish'
      OR NEW.previous_binding_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'first subject key binding must be initial epoch 1'
        USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_sequence';
    END IF;
  ELSE
    IF NEW.binding_epoch <> current_binding.binding_epoch + 1
      OR NEW.binding_kind <> 'recovery'
      OR session_record.subject_binding_intent <> 'recover'
      OR NEW.previous_binding_event_id IS DISTINCT FROM current_binding.binding_event_id
      OR NEW.user_id = current_binding.user_id
      OR NEW.bound_at < current_binding.activated_at THEN
      RAISE EXCEPTION 'subject key recovery must advance the active binding exactly once'
        USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_sequence';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

--
-- Name: action_grants action_grants_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER action_grants_append_only BEFORE DELETE OR UPDATE ON action_grants FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: active_subject_key_bindings active_subject_key_bindings_projection_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER active_subject_key_bindings_projection_only BEFORE INSERT OR DELETE OR UPDATE ON active_subject_key_bindings FOR EACH ROW EXECUTE FUNCTION gates_v2_active_binding_projection_guard();


--
-- Name: assertion_bindings assertion_bindings_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assertion_bindings_append_only BEFORE DELETE OR UPDATE ON assertion_bindings FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: assertion_revalidation_events assertion_revalidation_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assertion_revalidation_events_append_only BEFORE DELETE OR UPDATE ON assertion_revalidation_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: assertions assertions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assertions_append_only BEFORE DELETE OR UPDATE ON assertions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: assertions assertions_validate_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assertions_validate_binding BEFORE INSERT OR UPDATE ON assertions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_assertion_binding();


--
-- Name: decision_records decision_records_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER decision_records_append_only BEFORE DELETE OR UPDATE ON decision_records FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: evidence_receipts evidence_receipts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER evidence_receipts_append_only BEFORE DELETE OR UPDATE ON evidence_receipts FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: evidence_receipts evidence_receipts_validate_metadata; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER evidence_receipts_validate_metadata BEFORE INSERT OR UPDATE ON evidence_receipts FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_evidence_receipt();


--
-- Name: observations observations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER observations_append_only BEFORE DELETE OR UPDATE ON observations FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: policy_versions policy_versions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER policy_versions_append_only BEFORE DELETE OR UPDATE ON policy_versions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: proof_session_completion_events proof_session_completion_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER proof_session_completion_events_append_only BEFORE DELETE OR UPDATE ON proof_session_completion_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: proof_session_completion_events proof_session_completion_events_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER proof_session_completion_events_validate BEFORE INSERT ON proof_session_completion_events FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_completion_event();


--
-- Name: proof_sessions proof_sessions_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER proof_sessions_lifecycle BEFORE INSERT OR DELETE OR UPDATE ON proof_sessions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_lifecycle();


--
-- Name: proof_sessions proof_sessions_terminal_completion_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER proof_sessions_terminal_completion_event AFTER INSERT OR UPDATE ON proof_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gates_v2_require_terminal_completion_event();


--
-- Name: reward_subject_consumptions reward_subject_consumptions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_subject_consumptions_append_only BEFORE DELETE OR UPDATE ON reward_subject_consumptions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: reward_subject_consumptions reward_subject_consumptions_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_subject_consumptions_validate BEFORE INSERT ON reward_subject_consumptions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_reward_subject_consumption();


--
-- Name: reward_uniqueness_authorities reward_uniqueness_authorities_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_uniqueness_authorities_append_only BEFORE DELETE OR UPDATE ON reward_uniqueness_authorities FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: subject_key_binding_events subject_key_binding_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_key_binding_events_append_only BEFORE DELETE OR UPDATE ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: subject_key_binding_events subject_key_binding_events_project; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_key_binding_events_project AFTER INSERT ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_project_subject_key_binding();


--
-- Name: subject_key_binding_events subject_key_binding_events_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_key_binding_events_validate BEFORE INSERT ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_subject_key_binding_event();


--
-- Name: subject_keys subject_keys_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_keys_append_only BEFORE DELETE OR UPDATE ON subject_keys FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: used_action_grants used_action_grants_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER used_action_grants_append_only BEFORE DELETE OR UPDATE ON used_action_grants FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


--
-- Name: action_challenges action_challenges_intent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_intent_fk FOREIGN KEY (action_intent_id) REFERENCES action_intents(action_intent_id);


--
-- Name: action_grants action_grants_challenge_intent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_challenge_intent_fk FOREIGN KEY (action_challenge_id, action_intent_id, provider_id) REFERENCES action_challenges(action_challenge_id, action_intent_id, provider_id);


--
-- Name: action_grants action_grants_intent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_fk FOREIGN KEY (action_intent_id) REFERENCES action_intents(action_intent_id);


--
-- Name: action_grants action_grants_intent_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_identity_fk FOREIGN KEY (action_intent_id, user_id, action_kind, action_scope, action_payload_hash) REFERENCES action_intents(action_intent_id, user_id, action_kind, action_scope, action_payload_hash);


--
-- Name: action_grants action_grants_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: action_intents action_intents_community_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);


--
-- Name: action_intents action_intents_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: active_subject_key_bindings active_subject_key_bindings_event_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_event_fk FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);


--
-- Name: assertion_bindings assertion_bindings_receipt_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_receipt_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);


--
-- Name: assertion_bindings assertion_bindings_subject_binding_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_subject_binding_fk FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);


--
-- Name: assertion_bindings assertion_bindings_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);


--
-- Name: assertion_bindings assertion_bindings_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: assertion_revalidation_events assertion_revalidation_assertion_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_assertion_fk FOREIGN KEY (assertion_id, user_id) REFERENCES assertions(assertion_id, user_id);


--
-- Name: assertion_revalidation_events assertion_revalidation_observation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_observation_fk FOREIGN KEY (observation_id, user_id) REFERENCES observations(observation_id, user_id);


--
-- Name: assertion_revalidation_events assertion_revalidation_receipt_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_receipt_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);


--
-- Name: assertion_revalidation_events assertion_revalidation_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: assertions assertions_binding_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_binding_user_fk FOREIGN KEY (binding_group_id, user_id) REFERENCES assertion_bindings(binding_group_id, user_id);


--
-- Name: assertions assertions_receipt_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_receipt_user_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);


--
-- Name: assertions assertions_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);


--
-- Name: assertions assertions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: community_policy_current community_policy_current_community_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);


--
-- Name: community_policy_current community_policy_current_policy_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_policy_fk FOREIGN KEY (community_id, policy_key, policy_version_id) REFERENCES policy_versions(community_id, policy_key, policy_version_id);


--
-- Name: decision_records decision_records_community_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);


--
-- Name: decision_records decision_records_policy_hash_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_policy_hash_fk FOREIGN KEY (community_id, policy_version_id, policy_hash) REFERENCES policy_versions(community_id, policy_version_id, policy_hash);


--
-- Name: decision_records decision_records_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: evidence_receipts evidence_receipts_session_actor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_session_actor_fk FOREIGN KEY (proof_session_id, user_id) REFERENCES proof_sessions(proof_session_id, actor_id);


--
-- Name: evidence_receipts evidence_receipts_subject_binding_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_subject_binding_fk FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);


--
-- Name: evidence_receipts evidence_receipts_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);


--
-- Name: evidence_receipts evidence_receipts_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: observations observations_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: policy_versions policy_versions_author_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_author_fk FOREIGN KEY (created_by_user_id) REFERENCES users(user_id);


--
-- Name: policy_versions policy_versions_community_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);


--
-- Name: policy_versions policy_versions_uniqueness_authority_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_uniqueness_authority_fk FOREIGN KEY (uniqueness_authority_id) REFERENCES reward_uniqueness_authorities(campaign_id);


--
-- Name: proof_session_completion_events proof_session_completion_events_session_actor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_session_actor_fk FOREIGN KEY (proof_session_id, actor_id) REFERENCES proof_sessions(proof_session_id, actor_id);


--
-- Name: proof_sessions proof_sessions_actor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id);


--
-- Name: reward_subject_consumptions reward_subject_consumptions_binding_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_binding_fk FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);


--
-- Name: reward_subject_consumptions reward_subject_consumptions_campaign_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_campaign_fk FOREIGN KEY (campaign_id) REFERENCES reward_uniqueness_authorities(campaign_id);


--
-- Name: reward_subject_consumptions reward_subject_consumptions_receipt_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_receipt_fk FOREIGN KEY (evidence_receipt_id, subject_key_id, binding_event_id, binding_epoch, user_id) REFERENCES evidence_receipts(evidence_receipt_id, subject_key_id, subject_binding_event_id, subject_binding_epoch, user_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_previous_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_previous_fk FOREIGN KEY (previous_binding_event_id, subject_key_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_session_actor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_session_actor_fk FOREIGN KEY (proof_session_id, user_id) REFERENCES proof_sessions(proof_session_id, actor_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);


--
-- Name: subject_key_binding_events subject_key_binding_events_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);


--
-- Name: used_action_grants used_action_grants_grant_intent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_grant_intent_fk FOREIGN KEY (action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash) REFERENCES action_grants(action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash);
