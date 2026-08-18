-- api-next v1 product slice.
-- PlanetScale Postgres is the only runtime relational store. All identifiers
-- API identifiers remain TEXT so the current string-ID contracts need no
-- remapping.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  account JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_id_not_blank CHECK (btrim(user_id) <> '')
);

CREATE TABLE IF NOT EXISTS account_aliases (
  source_user_id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('alias', 'merge')),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'finalizing', 'completed', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_aliases_source_not_blank CHECK (btrim(source_user_id) <> ''),
  CONSTRAINT account_aliases_canonical_not_blank CHECK (btrim(canonical_user_id) <> '')
);

CREATE INDEX IF NOT EXISTS account_aliases_canonical_idx
  ON account_aliases (canonical_user_id);

CREATE TABLE IF NOT EXISTS identity_credentials (
  credential_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('privy')),
  provider_app_id TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL REFERENCES users (user_id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'tombstoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_credentials_id_not_blank CHECK (btrim(credential_id) <> ''),
  CONSTRAINT identity_credentials_app_not_blank CHECK (btrim(provider_app_id) <> ''),
  CONSTRAINT identity_credentials_subject_not_blank CHECK (btrim(provider_subject) <> ''),
  CONSTRAINT identity_credentials_user_not_blank CHECK (btrim(canonical_user_id) <> ''),
  CONSTRAINT identity_credentials_canonical_values CHECK (
    provider_app_id = btrim(provider_app_id)
    AND provider_subject = btrim(provider_subject)
  ),
  CONSTRAINT identity_credentials_provider_subject_unique
    UNIQUE (provider, provider_app_id, provider_subject)
);

CREATE INDEX IF NOT EXISTS identity_credentials_user_status_idx
  ON identity_credentials (canonical_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public_handle_index (
  handle_id TEXT PRIMARY KEY,
  label_normalized TEXT NOT NULL,
  label_display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'redirect', 'retired')),
  owner_user_id TEXT NOT NULL,
  redirect_target_handle_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT public_handle_index_label_not_blank CHECK (btrim(label_normalized) <> ''),
  CONSTRAINT public_handle_index_display_not_blank CHECK (btrim(label_display) <> ''),
  CONSTRAINT public_handle_index_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (user_id),
  CONSTRAINT public_handle_index_redirect_fk
    FOREIGN KEY (redirect_target_handle_id) REFERENCES public_handle_index (handle_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT public_handle_index_status_target_check CHECK (
    (status = 'active' AND redirect_target_handle_id IS NULL)
    OR (status = 'redirect' AND redirect_target_handle_id IS NOT NULL)
    OR (status = 'retired' AND redirect_target_handle_id IS NULL)
  ),
  CONSTRAINT public_handle_index_not_self_redirect CHECK (
    redirect_target_handle_id IS NULL OR redirect_target_handle_id <> handle_id
  ),
  CONSTRAINT public_handle_index_label_format_check CHECK (
    label_normalized ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND label_display = label_normalized || '.pirate'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS public_handle_index_label_normalized_uidx
  ON public_handle_index (label_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS public_handle_index_one_active_owner_uidx
  ON public_handle_index (owner_user_id)
  WHERE status = 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
      LEFT JOIN public_handle_index AS target
        ON target.handle_id = source.redirect_target_handle_id
     WHERE source.status = 'redirect'
       AND (
         target.handle_id IS NULL
         OR target.status <> 'active'
         OR target.owner_user_id <> source.owner_user_id
         OR target.handle_id = source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'existing public handle redirect is not a direct active same-owner target';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS public_handle_index_owner_status_idx
  ON public_handle_index (owner_user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS public_handle_index_redirect_target_idx
  ON public_handle_index (redirect_target_handle_id)
  WHERE status = 'redirect';

CREATE OR REPLACE FUNCTION public_handle_index_validate_redirects()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'redirect' AND NOT EXISTS (
    SELECT 1
      FROM public_handle_index AS target
     WHERE target.handle_id = NEW.redirect_target_handle_id
       AND target.status = 'active'
       AND target.owner_user_id = NEW.owner_user_id
       AND target.handle_id <> NEW.handle_id
  ) THEN
    RAISE EXCEPTION 'public handle redirect target is not an active handle owned by the same user'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
     WHERE source.status = 'redirect'
       AND source.redirect_target_handle_id = NEW.handle_id
       AND NOT EXISTS (
         SELECT 1
           FROM public_handle_index AS target
          WHERE target.handle_id = source.redirect_target_handle_id
            AND target.status = 'active'
            AND target.owner_user_id = source.owner_user_id
            AND target.handle_id <> source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'public handle redirect source points at an invalid target'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER public_handle_index_redirect_integrity
AFTER INSERT OR UPDATE OF status, owner_user_id, redirect_target_handle_id
ON public_handle_index
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public_handle_index_validate_redirects();

CREATE TABLE IF NOT EXISTS communities (
  community_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'hidden', 'archived')),
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  membership_mode TEXT NOT NULL DEFAULT 'open'
    CHECK (membership_mode IN ('open', 'request', 'gated')),
  human_verification_lane TEXT
    CHECK (
      human_verification_lane IS NULL
      OR human_verification_lane IN ('very', 'self')
    ),
  route_slug TEXT,
  CONSTRAINT communities_id_not_blank CHECK (btrim(community_id) <> ''),
  CONSTRAINT communities_route_slug_format_check CHECK (
    route_slug IS NULL
    OR route_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS communities_route_slug_uidx
  ON communities (route_slug)
  WHERE route_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS communities_creator_status_created_idx
  ON communities (created_by_user_id, status, created_at DESC, community_id);

CREATE TABLE IF NOT EXISTS community_memberships (
  community_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'member'
    CHECK (status IN ('pending', 'member', 'left', 'banned')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  request_note TEXT,
  PRIMARY KEY (community_id, membership_id),
  CONSTRAINT community_memberships_user_unique
    UNIQUE (community_id, user_id),
  CONSTRAINT community_memberships_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS community_memberships_status_idx
  ON community_memberships (community_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS community_follows (
  community_follow_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  unfollowed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_follows_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT community_follows_user_unique
    UNIQUE (community_id, user_id),
  CONSTRAINT community_follows_status_timestamp_check
    CHECK (
      (status = 'active' AND unfollowed_at IS NULL)
      OR (status = 'inactive' AND unfollowed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS community_follows_user_status_idx
  ON community_follows (user_id, status);

CREATE TABLE IF NOT EXISTS posts (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author_user_id TEXT,
  post_type TEXT NOT NULL DEFAULT 'text'
    CHECK (post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost', 'file')),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members_only')),
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  idempotency_body_hash TEXT,
  comments_locked BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (community_id, post_id),
  CONSTRAINT posts_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS posts_status_created_idx
  ON posts (community_id, status, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS posts_author_created_idx
  ON posts (community_id, author_user_id, created_at DESC, post_id);

CREATE UNIQUE INDEX IF NOT EXISTS posts_author_idempotency_unique
  ON posts (community_id, author_user_id, idempotency_key)
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS posts_post_id_global_unique
  ON posts (post_id);

CREATE TABLE IF NOT EXISTS comments (
  community_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  parent_comment_id TEXT,
  author_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'hidden', 'removed', 'deleted')),
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  idempotency_body_hash TEXT,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  PRIMARY KEY (community_id, comment_id),
  CONSTRAINT comments_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT comments_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id),
  CONSTRAINT comments_parent_fk
    FOREIGN KEY (community_id, parent_comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT comments_not_self_parent
    CHECK (parent_comment_id IS NULL OR parent_comment_id <> comment_id)
);

CREATE INDEX IF NOT EXISTS comments_post_created_idx
  ON comments (community_id, post_id, created_at, comment_id);

CREATE INDEX IF NOT EXISTS comments_parent_created_idx
  ON comments (community_id, parent_comment_id, created_at, comment_id);

CREATE UNIQUE INDEX IF NOT EXISTS comments_author_idempotency_unique
  ON comments (community_id, author_user_id, idempotency_key)
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS comments_comment_id_global_unique
  ON comments (comment_id);

CREATE TABLE IF NOT EXISTS post_votes (
  community_id TEXT NOT NULL,
  post_vote_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vote_value SMALLINT NOT NULL CHECK (vote_value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_vote_id),
  CONSTRAINT post_votes_user_post_unique UNIQUE (community_id, post_id, user_id),
  CONSTRAINT post_votes_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT post_votes_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS post_votes_post_idx
  ON post_votes (community_id, post_id, updated_at DESC, post_vote_id);

CREATE TABLE IF NOT EXISTS moderation_reports (
  community_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'triaged', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, report_id),
  CONSTRAINT moderation_reports_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS moderation_reports_status_idx
  ON moderation_reports (community_id, status, created_at, report_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  community_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment', 'member')),
  target_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('hide', 'restore', 'ban', 'unban')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, action_id),
  CONSTRAINT moderation_actions_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS moderation_actions_target_idx
  ON moderation_actions (community_id, target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_feed_projection (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  rank_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  projected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_id),
  CONSTRAINT community_feed_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS community_feed_rank_idx
  ON community_feed_projection (community_id, rank_score DESC, post_id);

CREATE TABLE IF NOT EXISTS home_feed_projection (
  community_id TEXT NOT NULL,
  feed_item_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  rank_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  projected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, feed_item_id),
  CONSTRAINT home_feed_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS home_feed_rank_idx
 ON home_feed_projection (community_id, rank_score DESC, feed_item_id);

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
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    CONSTRAINT evidence_receipts_evidence_hash_check CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_receipts_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text) AND (btrim(evidence_kind) <> ''::text))),
    CONSTRAINT evidence_receipts_payload_object_check CHECK ((jsonb_typeof(receipt_metadata) = 'object'::text)),
    CONSTRAINT evidence_receipts_provenance_kind_check CHECK ((provenance_kind = 'proof_session'::text)),
    CONSTRAINT evidence_receipts_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT evidence_receipts_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT evidence_receipts_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT evidence_receipts_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT evidence_receipts_provider_configuration_values_not_blank CHECK ((btrim(provider_configuration_ref) <> ''::text AND provider_configuration_ref = btrim(provider_configuration_ref) AND btrim(provider_configuration_version) <> ''::text AND provider_configuration_version = btrim(provider_configuration_version))),
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
-- Name: proof_session_presentations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE proof_session_presentations (
    proof_session_id text NOT NULL,
    presentation_kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proof_session_presentations_kind_check CHECK ((presentation_kind = ANY (ARRAY['redirect'::text, 'deeplink'::text, 'embedded_sdk'::text, 'poll'::text, 'none'::text]))),
    CONSTRAINT proof_session_presentations_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);

CREATE TABLE verification_start_reservations (
    reservation_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    request_hash text NOT NULL,
    request jsonb NOT NULL,
    state text NOT NULL,
    fence_token bigint NOT NULL DEFAULT 1,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_start_reservations_pkey PRIMARY KEY (reservation_id),
    CONSTRAINT verification_start_reservations_actor_intent_unique UNIQUE (actor_id, intent_id),
    CONSTRAINT verification_start_reservations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT verification_start_reservations_request_object_check CHECK ((jsonb_typeof(request) = 'object'::text)),
    CONSTRAINT verification_start_reservations_state_check CHECK ((state = ANY (ARRAY['acquired'::text, 'released'::text, 'finalized'::text]))),
    CONSTRAINT verification_start_reservations_fence_check CHECK ((fence_token > 0)),
    CONSTRAINT verification_start_reservations_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id)
);

CREATE INDEX verification_start_reservations_lease_idx
    ON verification_start_reservations (state, lease_expires_at);


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
    request_mode text NOT NULL,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    status text NOT NULL,
    upstream_session_ref text,
    requested_requirements jsonb NOT NULL,
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
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    CONSTRAINT proof_sessions_identifiers_not_blank CHECK (((btrim(intent_id) <> ''::text) AND (btrim(request_hash) <> ''::text) AND (btrim(provider_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text))),
    CONSTRAINT proof_sessions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT proof_sessions_requested_requirements_check CHECK (((jsonb_typeof(requested_requirements) = 'array'::text) AND (jsonb_array_length(requested_requirements) > 0))),
    CONSTRAINT proof_sessions_requested_claims_check CHECK (((jsonb_typeof(requested_claim_ids) = 'array'::text) AND (jsonb_array_length(requested_claim_ids) > 0))),
    CONSTRAINT proof_sessions_request_mode_check CHECK ((request_mode = ANY (ARRAY['curated'::text, 'dynamic'::text]))),
    CONSTRAINT proof_sessions_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT proof_sessions_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT proof_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT proof_sessions_subject_binding_intent_check CHECK ((subject_binding_intent = ANY (ARRAY['establish'::text, 'recover'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_terminal_shape_check CHECK ((((status = 'pending'::text) AND (completion_idempotency_key IS NULL) AND (completion_result_hash IS NULL) AND (terminal_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at = terminal_at)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at IS NULL)))),
    CONSTRAINT proof_sessions_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT proof_sessions_provider_configuration_values_not_blank CHECK ((btrim(provider_configuration_ref) <> ''::text AND provider_configuration_ref = btrim(provider_configuration_ref) AND btrim(provider_configuration_version) <> ''::text AND provider_configuration_version = btrim(provider_configuration_version))),
    CONSTRAINT proof_sessions_provider_configuration_mode_check CHECK (((request_mode = 'curated'::text AND provider_configuration_kind = 'managed'::text) OR (request_mode = 'dynamic'::text AND provider_configuration_kind = 'dynamic'::text)))
);


--
-- Name: verification_completion_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE verification_completion_attempts (
    attempt_id text NOT NULL,
    proof_session_id text NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_completion_attempts_idempotency_not_blank CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT verification_completion_attempts_state_check CHECK ((state = ANY (ARRAY['leased'::text, 'released'::text, 'consumed'::text]))),
    CONSTRAINT verification_completion_attempts_fence_check CHECK ((fence_token > 0))
);

CREATE INDEX verification_completion_attempts_lease_idx
    ON verification_completion_attempts (state, lease_expires_at);

CREATE INDEX verification_completion_attempts_session_state_idx
    ON verification_completion_attempts (proof_session_id, state);


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
-- Name: proof_session_presentations proof_session_presentations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_presentations
    ADD CONSTRAINT proof_session_presentations_pkey PRIMARY KEY (proof_session_id);


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
-- Name: verification_completion_attempts verification_completion_attempts_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_idempotency_unique UNIQUE (proof_session_id, idempotency_key);


--
-- Name: verification_completion_attempts verification_completion_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_pkey PRIMARY KEY (attempt_id);


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
    OR NEW.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
    OR NEW.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
    OR NEW.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
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

  IF jsonb_typeof(NEW.requested_requirements) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.requested_requirements) = 0
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW.requested_requirements) AS requirement(value)
       WHERE jsonb_typeof(requirement.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(requirement.value -> 'claim_id') IS DISTINCT FROM 'string'
          OR btrim(requirement.value ->> 'claim_id') = ''
    )
    OR (
      SELECT count(*)
        FROM jsonb_array_elements(NEW.requested_requirements)
    ) IS DISTINCT FROM (
      SELECT count(DISTINCT requirement.value ->> 'claim_id')
        FROM jsonb_array_elements(NEW.requested_requirements) AS requirement(value)
    )
    OR (
      SELECT jsonb_agg(requirement.value -> 'claim_id' ORDER BY requirement.ordinality)
        FROM jsonb_array_elements(NEW.requested_requirements)
          WITH ORDINALITY AS requirement(value, ordinality)
    ) IS DISTINCT FROM NEW.requested_claim_ids THEN
    RAISE EXCEPTION 'proof-session requirements must project exactly to requested claims'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_requested_requirements_projection';
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
    OR NEW.provider_configuration_kind IS DISTINCT FROM OLD.provider_configuration_kind
    OR NEW.provider_configuration_ref IS DISTINCT FROM OLD.provider_configuration_ref
    OR NEW.provider_configuration_version IS DISTINCT FROM OLD.provider_configuration_version
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM OLD.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM OLD.issuer_rp_action_scope
    OR NEW.request_mode IS DISTINCT FROM OLD.request_mode
    OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.upstream_session_ref IS DISTINCT FROM OLD.upstream_session_ref
    OR NEW.requested_requirements IS DISTINCT FROM OLD.requested_requirements
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
-- Name: proof_session_presentations proof_session_presentations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER proof_session_presentations_append_only BEFORE DELETE OR UPDATE ON proof_session_presentations FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();


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
-- Name: proof_session_presentations proof_session_presentations_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_session_presentations
    ADD CONSTRAINT proof_session_presentations_session_fk FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);


--
-- Name: proof_sessions proof_sessions_actor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id);


--
-- Name: verification_completion_attempts verification_completion_attempts_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_session_fk FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);


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

-- M3 community-purchase funding journal (migration 0013).
-- Concrete M3 community-purchase buyer-funding journal.
--
-- This is deliberately flow-specific. The shared money journal is not
-- extracted until community purchase and ordinary karaoke reward payout have
-- both proved its shape (spec 004 section 8).

CREATE TABLE community_purchase_funding_journal (
    operation_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    quote_id text NOT NULL,
    purchase_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    expected_sender text NOT NULL,
    expected_recipient text NOT NULL,
    expected_amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    state text NOT NULL,
    version bigint NOT NULL,
    snapshot jsonb NOT NULL,
    failure_tag text,
    failure_reason text,
    funding_receipt_status text,
    funding_transaction_hash text,
    funding_log_index integer,
    funding_observation_id text,
    lease_owner text,
    lease_fence_token bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_operation_not_blank CHECK (btrim(operation_id) <> ''),
    CONSTRAINT community_purchase_funding_business_ids_not_blank CHECK (
      btrim(quote_id) <> '' AND btrim(purchase_id) <> ''
    ),
    CONSTRAINT community_purchase_funding_policy_version_check CHECK (policy_version > 0),
    CONSTRAINT community_purchase_funding_chain_id_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_funding_parties_check CHECK (
      expected_sender ~ '^0x[0-9a-f]{40}$'
      AND expected_recipient ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_amount_check CHECK (expected_amount_atomic > 0),
    CONSTRAINT community_purchase_funding_confirmations_check CHECK (required_confirmations > 0),
    CONSTRAINT community_purchase_funding_state_check CHECK (state IN (
      'planned', 'confirming', 'confirmed', 'reverted', 'reclaimable_failed',
      'reconciliation_required'
    )),
    CONSTRAINT community_purchase_funding_version_check CHECK (version > 0),
    CONSTRAINT community_purchase_funding_snapshot_object_check CHECK (jsonb_typeof(snapshot) = 'object'),
    CONSTRAINT community_purchase_funding_failure_coherence_check CHECK (
      (state IN ('planned', 'confirming', 'confirmed', 'reverted')
        AND failure_tag IS NULL AND failure_reason IS NULL)
      OR (state = 'reclaimable_failed'
        AND failure_tag = 'reclaimable' AND btrim(failure_reason) <> '')
      OR (state = 'reconciliation_required'
        AND failure_tag IN ('ambiguous', 'legacy') AND btrim(failure_reason) <> '')
    ),
    CONSTRAINT community_purchase_funding_receipt_shape_check CHECK (
      (funding_receipt_status IS NULL AND funding_transaction_hash IS NULL
        AND funding_log_index IS NULL AND funding_observation_id IS NULL)
      OR (funding_receipt_status = 'success'
        AND funding_transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND funding_log_index >= 0
        AND funding_observation_id ~ '^0x[0-9a-f]{64}$')
      OR (funding_receipt_status = 'reverted'
        AND funding_transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND funding_log_index IS NULL
        AND funding_observation_id ~ '^0x[0-9a-f]{64}$')
    ),
    CONSTRAINT community_purchase_funding_lease_shape_check CHECK (
      lease_fence_token >= 0
      AND ((lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL))
    )
);

CREATE INDEX community_purchase_funding_state_idx
    ON community_purchase_funding_journal (state, updated_at, operation_id);

CREATE INDEX community_purchase_funding_lease_idx
    ON community_purchase_funding_journal (lease_expires_at, operation_id)
    WHERE lease_owner IS NOT NULL;

CREATE TABLE community_purchase_funding_requests (
    actor_id text NOT NULL REFERENCES users (user_id),
    endpoint text NOT NULL,
    client_nonce text NOT NULL,
    request_hash text NOT NULL,
    canonical_request jsonb NOT NULL,
    operation_id text NOT NULL REFERENCES community_purchase_funding_journal (operation_id),
    status text NOT NULL,
    result jsonb NOT NULL,
    result_version bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_requests_pkey PRIMARY KEY (actor_id, endpoint, client_nonce),
    CONSTRAINT community_purchase_funding_requests_endpoint_check
      CHECK (endpoint = 'community-purchase-funding'),
    CONSTRAINT community_purchase_funding_requests_nonce_not_blank CHECK (btrim(client_nonce) <> ''),
    CONSTRAINT community_purchase_funding_requests_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT community_purchase_funding_requests_request_object_check
      CHECK (jsonb_typeof(canonical_request) = 'object'),
    CONSTRAINT community_purchase_funding_requests_status_check CHECK (status IN (
      'planned', 'confirming', 'confirmed', 'reverted', 'reclaimable_failed',
      'reconciliation_required'
    )),
    CONSTRAINT community_purchase_funding_requests_result_object_check CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT community_purchase_funding_requests_result_version_check CHECK (result_version > 0)
);

CREATE INDEX community_purchase_funding_requests_operation_idx
    ON community_purchase_funding_requests (operation_id);

CREATE TABLE community_purchase_funding_transaction_claims (
    operation_id text PRIMARY KEY REFERENCES community_purchase_funding_journal (operation_id),
    chain_id bigint NOT NULL,
    transaction_hash text NOT NULL,
    successful_log_index integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_transaction_claims_chain_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_transaction_claims_hash_check
      CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT community_purchase_funding_transaction_claims_log_check
      CHECK (successful_log_index IS NULL OR successful_log_index >= 0),
    CONSTRAINT community_purchase_funding_transaction_claims_hash_unique
      UNIQUE (chain_id, transaction_hash)
);

CREATE UNIQUE INDEX community_purchase_funding_transaction_claims_log_unique
    ON community_purchase_funding_transaction_claims (chain_id, transaction_hash, successful_log_index)
    WHERE successful_log_index IS NOT NULL;

CREATE TABLE community_purchase_funding_transitions (
    operation_id text NOT NULL REFERENCES community_purchase_funding_journal (operation_id),
    target_version bigint NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    event jsonb NOT NULL,
    observation_id text,
    transaction_hash text,
    log_index integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_transitions_pkey PRIMARY KEY (operation_id, target_version),
    CONSTRAINT community_purchase_funding_transitions_version_check CHECK (target_version > 1),
    CONSTRAINT community_purchase_funding_transitions_source_check CHECK (source IN ('request', 'reconciler')),
    CONSTRAINT community_purchase_funding_transitions_event_type_not_blank CHECK (btrim(event_type) <> ''),
    CONSTRAINT community_purchase_funding_transitions_event_object_check CHECK (jsonb_typeof(event) = 'object'),
    CONSTRAINT community_purchase_funding_transitions_evidence_shape_check CHECK (
      (observation_id IS NULL AND transaction_hash IS NULL AND log_index IS NULL)
      OR (observation_id ~ '^0x[0-9a-f]{64}$'
        AND transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND (log_index IS NULL OR log_index >= 0))
    ),
    CONSTRAINT community_purchase_funding_transitions_observation_unique
      UNIQUE (operation_id, observation_id)
);

CREATE TABLE community_purchase_funding_receipts (
    receipt_id text PRIMARY KEY,
    operation_id text NOT NULL UNIQUE REFERENCES community_purchase_funding_journal (operation_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    purchase_id text NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    sender text NOT NULL,
    recipient text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    confirmed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_receipts_id_not_blank CHECK (btrim(receipt_id) <> ''),
    CONSTRAINT community_purchase_funding_receipts_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_funding_receipts_log_check CHECK (log_index >= 0),
    CONSTRAINT community_purchase_funding_receipts_transaction_unique
      UNIQUE (chain_id, transaction_hash),
    CONSTRAINT community_purchase_funding_receipts_log_unique
      UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE FUNCTION guard_community_purchase_funding_journal_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.operation_id, NEW.community_id, NEW.actor_id, NEW.quote_id, NEW.purchase_id,
    NEW.policy_version, NEW.chain_id, NEW.token_contract, NEW.token_decimals,
    NEW.expected_sender, NEW.expected_recipient, NEW.expected_amount_atomic,
    NEW.required_confirmations
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.community_id, OLD.actor_id, OLD.quote_id, OLD.purchase_id,
    OLD.policy_version, OLD.chain_id, OLD.token_contract, OLD.token_decimals,
    OLD.expected_sender, OLD.expected_recipient, OLD.expected_amount_atomic,
    OLD.required_confirmations
  ) THEN
    RAISE EXCEPTION 'community purchase funding identity is immutable';
  END IF;

  IF NEW.version = OLD.version THEN
    IF ROW(
      NEW.state, NEW.snapshot, NEW.failure_tag, NEW.failure_reason,
      NEW.funding_receipt_status,
      NEW.funding_transaction_hash, NEW.funding_log_index,
      NEW.funding_observation_id
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.snapshot, OLD.failure_tag, OLD.failure_reason,
      OLD.funding_receipt_status,
      OLD.funding_transaction_hash, OLD.funding_log_index,
      OLD.funding_observation_id
    ) THEN
      RAISE EXCEPTION 'journal state change requires a new version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'journal version must advance exactly once';
  END IF;

  IF NOT (
    (OLD.state = 'planned' AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reclaimable_failed'))
    OR (OLD.state = 'confirming' AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required'))
    OR (OLD.state = 'confirmed' AND NEW.state IN ('confirmed', 'reconciliation_required'))
    OR (OLD.state = 'reverted' AND NEW.state IN ('reverted', 'reconciliation_required'))
    OR (OLD.state = 'reclaimable_failed' AND NEW.state = 'planned')
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
  ) THEN
    RAISE EXCEPTION 'journal transition is not allowed: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_purchase_funding_journal_update_guard
BEFORE UPDATE ON community_purchase_funding_journal
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_journal_update();

CREATE FUNCTION reject_community_purchase_funding_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community purchase funding evidence is append-only';
END;
$$;

CREATE TRIGGER community_purchase_funding_claims_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_transaction_claims
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_transitions_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_transitions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_receipts_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_receipts
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

-- M3 community-purchase funding plans (migration 0014).
-- Immutable M3 community-purchase funding quote/plan.
--
-- A plan is the durable boundary between quote pricing and the funding
-- journal. Its terms are fixed at creation; only its binding lifecycle may
-- advance from active to bound or cancelled.

CREATE TABLE community_purchase_funding_plans (
    quote_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    purchase_id text NOT NULL UNIQUE,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    quoted_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'active',
    operation_id text UNIQUE REFERENCES community_purchase_funding_journal (operation_id),
    CONSTRAINT community_purchase_funding_plans_quote_not_blank CHECK (btrim(quote_id) <> ''),
    CONSTRAINT community_purchase_funding_plans_buyer_wallet_check CHECK (
      buyer_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_plans_buyer_chain_check CHECK (
      buyer_chain_id > 0 AND buyer_chain_id = chain_id
    ),
    CONSTRAINT community_purchase_funding_plans_purchase_not_blank CHECK (btrim(purchase_id) <> ''),
    CONSTRAINT community_purchase_funding_plans_policy_version_check CHECK (policy_version > 0),
    CONSTRAINT community_purchase_funding_plans_chain_id_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_plans_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_funding_plans_treasury_check CHECK (
      treasury_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_plans_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_funding_plans_confirmations_check CHECK (
      required_confirmations > 0
    ),
    CONSTRAINT community_purchase_funding_plans_expiry_check CHECK (expires_at > quoted_at),
    CONSTRAINT community_purchase_funding_plans_status_check CHECK (
      status IN ('active', 'bound', 'cancelled')
    ),
    CONSTRAINT community_purchase_funding_plans_operation_coherence_check CHECK (
      (status = 'bound' AND operation_id IS NOT NULL)
      OR (status IN ('active', 'cancelled') AND operation_id IS NULL)
    )
);

CREATE INDEX community_purchase_funding_plans_actor_status_idx
    ON community_purchase_funding_plans (actor_id, status, expires_at, quote_id);

CREATE INDEX community_purchase_funding_plans_community_status_idx
    ON community_purchase_funding_plans (community_id, status, expires_at, quote_id);

CREATE OR REPLACE FUNCTION guard_community_purchase_funding_plan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.community_id, NEW.actor_id, NEW.buyer_wallet_address,
    NEW.buyer_chain_id, NEW.purchase_id, NEW.policy_version, NEW.chain_id, NEW.token_contract,
    NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.community_id, OLD.actor_id, OLD.buyer_wallet_address,
    OLD.buyer_chain_id, OLD.purchase_id, OLD.policy_version, OLD.chain_id, OLD.token_contract,
    OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase funding plan terms are immutable';
  END IF;

  IF OLD.status = 'active' THEN
    IF NEW.status IN ('active', 'cancelled') AND NEW.operation_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'bound'
      AND OLD.operation_id IS NULL AND NEW.operation_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.status = 'bound'
    AND NEW.status = 'bound'
    AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status = 'cancelled' AND NEW.operation_id IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'community purchase funding plan transition is not allowed: % -> %',
    OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_purchase_funding_plans_update_guard
BEFORE UPDATE ON community_purchase_funding_plans
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_plan_update();
