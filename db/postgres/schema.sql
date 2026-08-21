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
  tombstoned_at TIMESTAMPTZ,
  CONSTRAINT identity_credentials_id_not_blank CHECK (btrim(credential_id) <> ''),
  CONSTRAINT identity_credentials_app_not_blank CHECK (btrim(provider_app_id) <> ''),
  CONSTRAINT identity_credentials_subject_not_blank CHECK (btrim(provider_subject) <> ''),
  CONSTRAINT identity_credentials_user_not_blank CHECK (btrim(canonical_user_id) <> ''),
  CONSTRAINT identity_credentials_canonical_values CHECK (
    provider_app_id = btrim(provider_app_id)
    AND provider_subject = btrim(provider_subject)
  ),
  CONSTRAINT identity_credentials_provider_subject_unique
    UNIQUE (provider, provider_app_id, provider_subject),
  CONSTRAINT identity_credentials_tombstone_time_check CHECK (
    (status = 'active' AND tombstoned_at IS NULL)
    OR (status = 'tombstoned' AND tombstoned_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS identity_credentials_user_status_idx
  ON identity_credentials (canonical_user_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION identity_credentials_enforce_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity credentials cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_delete_forbidden';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'identity credentials must be inserted active'
        USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_insert_active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_app_id IS DISTINCT FROM OLD.provider_app_id
    OR NEW.provider_subject IS DISTINCT FROM OLD.provider_subject
    OR NEW.canonical_user_id IS DISTINCT FROM OLD.canonical_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity credential ownership and identity are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_identity_immutable';
  END IF;

  IF OLD.status = 'tombstoned' THEN
    RAISE EXCEPTION 'identity credential tombstones are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_tombstone_terminal';
  END IF;

  IF NEW.status = 'tombstoned' THEN
    NEW.tombstoned_at := now();
  ELSIF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid identity credential lifecycle transition'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_lifecycle';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_credentials_enforce_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON identity_credentials
FOR EACH ROW
EXECUTE FUNCTION identity_credentials_enforce_lifecycle();

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

ALTER TABLE community_purchase_funding_journal
  DROP CONSTRAINT community_purchase_funding_state_check,
  ADD CONSTRAINT community_purchase_funding_state_check CHECK (state IN (
    'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
    'reclaimable_failed', 'reconciliation_required'
  ));

ALTER TABLE community_purchase_funding_journal
  DROP CONSTRAINT community_purchase_funding_failure_coherence_check,
  ADD CONSTRAINT community_purchase_funding_failure_coherence_check CHECK (
    (state IN (
      'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted'
    ) AND failure_tag IS NULL AND failure_reason IS NULL)
    OR (state = 'reclaimable_failed'
      AND failure_tag = 'reclaimable' AND btrim(failure_reason) <> '')
    OR (state = 'reconciliation_required'
      AND failure_tag IN ('ambiguous', 'legacy') AND btrim(failure_reason) <> '')
  );

ALTER TABLE community_purchase_funding_requests
  DROP CONSTRAINT community_purchase_funding_requests_status_check,
  ADD CONSTRAINT community_purchase_funding_requests_status_check CHECK (status IN (
    'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
    'reclaimable_failed', 'reconciliation_required'
  ));

CREATE INDEX community_purchase_funding_planned_dormancy_idx
  ON community_purchase_funding_journal (created_at, operation_id)
  WHERE state = 'planned' AND funding_transaction_hash IS NULL;

CREATE OR REPLACE FUNCTION guard_community_purchase_funding_journal_update()
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
    (OLD.state = 'planned' AND NEW.state IN (
      'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
      'reclaimable_failed'
    ))
    OR (OLD.state = 'dormant_unobserved'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
    OR (OLD.state = 'confirming'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required'))
    OR (OLD.state = 'confirmed' AND NEW.state IN ('confirmed', 'reconciliation_required'))
    OR (OLD.state = 'reverted' AND NEW.state IN ('reverted', 'reconciliation_required'))
    OR (OLD.state = 'reclaimable_failed' AND NEW.state = 'planned')
    OR (OLD.state = 'reconciliation_required'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
  ) THEN
    RAISE EXCEPTION 'journal transition is not allowed: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_purchase_funding_journal_delete_guard
BEFORE DELETE ON community_purchase_funding_journal
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_requests_delete_guard
BEFORE DELETE ON community_purchase_funding_requests
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_plans_delete_guard
BEFORE DELETE ON community_purchase_funding_plans
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

-- Durable M3 reconciliation retry scheduling. This metadata never changes
-- journal/economic identity and is absent for hashless parked entries.
CREATE TABLE community_purchase_funding_reconciliation_attempts (
    operation_id text PRIMARY KEY REFERENCES community_purchase_funding_journal (operation_id),
    generation bigint NOT NULL DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    last_failure_class text,
    consecutive_failures integer NOT NULL DEFAULT 0,
    escalated_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    finalized_generation bigint,
    CONSTRAINT cpf_attempts_generation_check CHECK (generation >= 0),
    CONSTRAINT cpf_attempts_finalized_generation_check CHECK (
      finalized_generation IS NULL
      OR (finalized_generation >= 0 AND finalized_generation <= generation)
    ),
    CONSTRAINT cpf_attempts_consecutive_failures_check CHECK (consecutive_failures >= 0),
    CONSTRAINT cpf_attempts_failure_class_check CHECK (
      last_failure_class IS NULL
      OR last_failure_class IN (
        'lease_contention', 'chain_unavailable', 'chain_timeout',
        'transaction_not_found', 'invalid_evidence', 'reorg', 'identity_conflict'
      )
    ),
    CONSTRAINT cpf_attempts_shape_check CHECK (
      (last_attempt_at IS NULL AND next_attempt_at IS NULL AND last_failure_class IS NULL
        AND consecutive_failures = 0 AND escalated_at IS NULL)
      OR (last_attempt_at IS NOT NULL)
    ),
    CONSTRAINT cpf_attempts_escalation_check CHECK (
      escalated_at IS NULL OR last_failure_class IS NOT NULL
    )
);

CREATE INDEX cpf_attempts_selection_idx
    ON community_purchase_funding_reconciliation_attempts (next_attempt_at, operation_id)
    WHERE escalated_at IS NULL;

CREATE TABLE community_purchase_funding_reconciliation_operator_actions (
    action_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id text NOT NULL
      REFERENCES community_purchase_funding_reconciliation_attempts (operation_id),
    actor_id text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    generation bigint NOT NULL,
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT cpf_attempt_operator_action_check CHECK (action = 'unpark_escalated'),
    CONSTRAINT cpf_attempt_operator_actor_check CHECK (length(trim(actor_id)) > 0),
    CONSTRAINT cpf_attempt_operator_reason_check CHECK (length(trim(reason)) > 0),
    CONSTRAINT cpf_attempt_operator_generation_check CHECK (generation >= 0)
);

CREATE INDEX cpf_attempt_operator_actions_operation_idx
  ON community_purchase_funding_reconciliation_operator_actions (operation_id, action_id);

-- Target-owned community commerce source for the M3 funding-plan producer.
-- All quote economics are captured from these rows in one PostgreSQL
-- transaction; no legacy commerce table is a runtime dependency.

CREATE TABLE community_commerce_policy_revisions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    source_revision text NOT NULL,
    issued_by text NOT NULL REFERENCES users (user_id),
    effective_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    superseded_at timestamp with time zone,
    PRIMARY KEY (community_id, policy_version),
    CONSTRAINT community_commerce_policy_revision_check CHECK (
      policy_version > 0 AND btrim(source_revision) <> ''
    )
);

CREATE TABLE community_commerce_listings (
    listing_id text PRIMARY KEY,
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    active boolean NOT NULL DEFAULT true,
    availability_mode text NOT NULL,
    available_quantity integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_commerce_listing_identity_fk
      FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_listing_mode_check CHECK (
      availability_mode IN ('unbounded', 'finite')
    ),
    CONSTRAINT community_commerce_listing_quantity_check CHECK (
      (availability_mode = 'unbounded' AND available_quantity IS NULL)
      OR (availability_mode = 'finite' AND available_quantity >= 0)
    ),
    CONSTRAINT community_commerce_listing_id_check CHECK (btrim(listing_id) <> '')
);

CREATE TABLE community_commerce_eligibility_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    verification_required boolean NOT NULL DEFAULT false,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_pricing_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_pricing_amount_check CHECK (amount_atomic > 0)
);

CREATE TABLE community_commerce_money_route_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    required_confirmations integer NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_route_chain_check CHECK (chain_id > 0),
    CONSTRAINT community_commerce_route_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_commerce_route_treasury_check CHECK (
      treasury_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_commerce_route_confirmations_check CHECK (required_confirmations > 0)
);

CREATE TABLE community_commerce_allocation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    allocation_mode text NOT NULL DEFAULT 'single_unit',
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_allocation_mode_check CHECK (allocation_mode = 'single_unit')
);

CREATE TABLE community_commerce_settlement_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    settlement_mode text NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_settlement_mode_check CHECK (
      settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    )
);

CREATE TABLE community_commerce_donation_partners (
    partner_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    name text NOT NULL,
    destination_address text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    CONSTRAINT community_commerce_donation_partner_check CHECK (
      btrim(partner_id) <> '' AND btrim(name) <> ''
      AND destination_address ~ '^0x[0-9a-f]{40}$'
    )
);

CREATE TABLE community_commerce_donation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    policy_mode text NOT NULL,
    partner_id text,
    share_bps integer NOT NULL DEFAULT 0,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    FOREIGN KEY (partner_id) REFERENCES community_commerce_donation_partners (partner_id),
    CONSTRAINT community_commerce_donation_mode_check CHECK (policy_mode IN ('none', 'partner_share')),
    CONSTRAINT community_commerce_donation_share_check CHECK (share_bps BETWEEN 0 AND 10000),
    CONSTRAINT community_commerce_donation_partner_check CHECK (
      (policy_mode = 'none' AND partner_id IS NULL AND share_bps = 0)
      OR (policy_mode = 'partner_share' AND partner_id IS NOT NULL AND share_bps > 0)
    )
);

CREATE TABLE community_purchase_intents (
    purchase_id text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES users (user_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    status text NOT NULL DEFAULT 'reserved',
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT community_purchase_intent_status_check CHECK (
      status IN ('reserved', 'consumed', 'released', 'expired')
    ),
    CONSTRAINT community_purchase_intent_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX community_purchase_intents_open_unique
  ON community_purchase_intents (actor_id, community_id, listing_id)
  WHERE status = 'reserved';

CREATE TABLE community_purchase_availability_reservations (
    purchase_id text PRIMARY KEY REFERENCES community_purchase_intents (purchase_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    state text NOT NULL DEFAULT 'held',
    expires_at timestamp with time zone NOT NULL,
    transitioned_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_reservation_state_check CHECK (
      state IN ('held', 'consumed', 'released', 'expired')
    )
);

CREATE TABLE community_purchase_quotes (
    quote_id text PRIMARY KEY,
    purchase_id text NOT NULL UNIQUE REFERENCES community_purchase_intents (purchase_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    policy_version bigint NOT NULL,
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    eligibility_snapshot_id text,
    pricing_snapshot_id text,
    verification_snapshot_id text,
    route_snapshot_id text,
    allocation_snapshot_id text,
    settlement_snapshot_id text,
    donation_snapshot_id text,
    quoted_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'active',
    CONSTRAINT community_purchase_quote_status_check CHECK (status IN ('active', 'bound', 'cancelled', 'expired')),
    CONSTRAINT community_purchase_quote_wallet_check CHECK (buyer_wallet_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT community_purchase_quote_chain_check CHECK (buyer_chain_id = chain_id AND chain_id > 0),
    CONSTRAINT community_purchase_quote_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_quote_treasury_check CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT community_purchase_quote_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_quote_confirmations_check CHECK (required_confirmations > 0),
    CONSTRAINT community_purchase_quote_expiry_check CHECK (expires_at > quoted_at),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_purchase_eligibility_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_pricing_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_verification_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text UNIQUE REFERENCES community_purchase_quotes (quote_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    provider text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    snapshot jsonb NOT NULL,
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_purchase_route_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_allocation_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_settlement_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_donation_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_commerce_operator_ledger (
    event_id text PRIMARY KEY,
    operator_id text NOT NULL REFERENCES users (user_id),
    event_kind text NOT NULL,
    target_identity text NOT NULL,
    reason text NOT NULL,
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT community_commerce_operator_event_check CHECK (
      event_kind IN ('policy_issued', 'correction')
      AND btrim(target_identity) <> '' AND btrim(reason) <> ''
    )
);

CREATE TABLE community_purchase_correction_events (
    event_id text PRIMARY KEY,
    target_identity text NOT NULL,
    kind text NOT NULL,
    operator_id text NOT NULL REFERENCES users (user_id),
    reason text NOT NULL,
    quote_id text REFERENCES community_purchase_quotes (quote_id),
    purchase_id text REFERENCES community_purchase_intents (purchase_id),
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_correction_target_check CHECK (
      btrim(target_identity) <> '' AND btrim(reason) <> ''
    ),
    CONSTRAINT community_purchase_correction_kind_check CHECK (
      kind IN ('cancel_unbound_quote', 'release_unbound_reservation', 'supersede_policy')
    )
);

CREATE UNIQUE INDEX community_purchase_correction_idempotency
  ON community_purchase_correction_events (target_identity, kind);

CREATE INDEX community_commerce_listing_active_idx
  ON community_commerce_listings (community_id, active, listing_id);
CREATE INDEX community_purchase_quote_actor_status_idx
  ON community_purchase_quotes (actor_id, status, expires_at, quote_id);

CREATE OR REPLACE FUNCTION guard_community_commerce_policy_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.policy_version, NEW.source_revision, NEW.issued_by,
    NEW.effective_at
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.policy_version, OLD.source_revision, OLD.issued_by,
    OLD.effective_at
  ) THEN
    RAISE EXCEPTION 'community commerce policy revision identity is immutable';
  END IF;
  IF OLD.superseded_at IS NOT NULL
    AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession is immutable';
  END IF;
  IF NEW.superseded_at IS NOT NULL AND NEW.superseded_at < OLD.effective_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession precedes effectiveness';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_commerce_policy_revision_update_guard
BEFORE UPDATE ON community_commerce_policy_revisions
FOR EACH ROW EXECUTE FUNCTION guard_community_commerce_policy_revision_update();

CREATE OR REPLACE FUNCTION reject_community_commerce_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_commerce_policy_revision_delete_guard
BEFORE DELETE ON community_commerce_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_eligibility_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_eligibility_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_pricing_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_pricing_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_route_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_money_route_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_allocation_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_allocation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_settlement_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_settlement_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_donation_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_donation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_eligibility_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_eligibility_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_pricing_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_pricing_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_verification_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_verification_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_route_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_route_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_allocation_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_allocation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_settlement_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_settlement_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_donation_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_donation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_operator_ledger_append_only
BEFORE UPDATE OR DELETE ON community_commerce_operator_ledger
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_correction_event_append_only
BEFORE UPDATE OR DELETE ON community_purchase_correction_events
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE OR REPLACE FUNCTION guard_community_purchase_quote_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.purchase_id, NEW.community_id, NEW.actor_id, NEW.listing_id,
    NEW.policy_version, NEW.buyer_wallet_address, NEW.buyer_chain_id, NEW.chain_id,
    NEW.token_contract, NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.purchase_id, OLD.community_id, OLD.actor_id, OLD.listing_id,
    OLD.policy_version, OLD.buyer_wallet_address, OLD.buyer_chain_id, OLD.chain_id,
    OLD.token_contract, OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase quote terms are immutable';
  END IF;
  IF OLD.eligibility_snapshot_id IS NOT NULL
    AND NEW.eligibility_snapshot_id IS DISTINCT FROM OLD.eligibility_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.pricing_snapshot_id IS NOT NULL
    AND NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.verification_snapshot_id IS NOT NULL
    AND NEW.verification_snapshot_id IS DISTINCT FROM OLD.verification_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.route_snapshot_id IS NOT NULL
    AND NEW.route_snapshot_id IS DISTINCT FROM OLD.route_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.allocation_snapshot_id IS NOT NULL
    AND NEW.allocation_snapshot_id IS DISTINCT FROM OLD.allocation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.settlement_snapshot_id IS NOT NULL
    AND NEW.settlement_snapshot_id IS DISTINCT FROM OLD.settlement_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.donation_snapshot_id IS NOT NULL
    AND NEW.donation_snapshot_id IS DISTINCT FROM OLD.donation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.status = 'active' AND NEW.status IN ('active', 'bound', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'community purchase quote transition is not allowed: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_purchase_quote_update_guard
BEFORE UPDATE ON community_purchase_quotes
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_quote_update();

-- Durable, replay-safe community creation and immutable gate/provider binding.

CREATE TABLE community_creation_intents (
  intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  create_idempotency_key TEXT NOT NULL,
  create_request_hash TEXT NOT NULL CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    )
  ),
  draft JSONB NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  canonical_policy_revision INTEGER NOT NULL CHECK (canonical_policy_revision > 0),
  canonical_policy_hash TEXT NOT NULL CHECK (canonical_policy_hash ~ '^[0-9a-f]{64}$'),
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  verification_provider_id TEXT NOT NULL,
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_community_id TEXT REFERENCES communities (community_id),
  committed_resource_href TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_intents_identifiers_not_blank CHECK (
    btrim(intent_id) <> ''
    AND intent_id = btrim(intent_id)
    AND btrim(actor_id) <> ''
    AND actor_id = btrim(actor_id)
    AND btrim(create_idempotency_key) <> ''
    AND create_idempotency_key = btrim(create_idempotency_key)
    AND btrim(verification_provider_id) <> ''
    AND verification_provider_id = btrim(verification_provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_intents_committed_shape CHECK (
    (
      status = 'committed'
      AND committed_community_id IS NOT NULL
      AND committed_resource_href IS NOT NULL
      AND committed_resource_href LIKE '/%'
    )
    OR
    (
      status <> 'committed'
      AND committed_community_id IS NULL
      AND committed_resource_href IS NULL
    )
  ),
  CONSTRAINT community_creation_intents_actor_create_key_unique
    UNIQUE (actor_id, create_idempotency_key),
  CONSTRAINT community_creation_intents_actor_intent_unique UNIQUE (actor_id, intent_id)
);

CREATE INDEX community_creation_intents_actor_status_idx
  ON community_creation_intents (actor_id, status, updated_at DESC, intent_id);

CREATE INDEX community_creation_intents_expiry_idx
  ON community_creation_intents (expires_at, intent_id)
  WHERE status IN ('draft', 'verification_required', 'commit_ready');

CREATE TABLE community_creation_intent_revisions (
  intent_id TEXT NOT NULL REFERENCES community_creation_intents (intent_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN (
      'create',
      'update',
      'preflight',
      'verification',
      'commit',
      'expire',
      'cancel'
    )
  ),
  idempotency_key TEXT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    )
  ),
  state_snapshot JSONB NOT NULL CHECK (jsonb_typeof(state_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (intent_id, revision),
  CONSTRAINT community_creation_intent_revisions_actor_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_intent_revisions_idempotency_shape CHECK (
    (
      operation_kind IN ('create', 'update', 'commit')
      AND idempotency_key IS NOT NULL
      AND btrim(idempotency_key) <> ''
      AND idempotency_key = btrim(idempotency_key)
    )
    OR
    (
      operation_kind NOT IN ('create', 'update', 'commit')
      AND idempotency_key IS NULL
    )
  )
);

CREATE UNIQUE INDEX community_creation_intent_revisions_idempotency_uidx
  ON community_creation_intent_revisions (actor_id, operation_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE community_policy_provider_bindings (
  policy_version_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  method TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_policy_provider_bindings_policy_fk
    FOREIGN KEY (community_id, policy_key, policy_version_id)
    REFERENCES policy_versions (community_id, policy_key, policy_version_id),
  CONSTRAINT community_policy_provider_bindings_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(method) <> ''
    AND method = btrim(method)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
  )
);

CREATE TABLE community_creation_quota_approvals (
  approval_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL REFERENCES subject_keys (subject_key_id),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  slot_number INTEGER NOT NULL CHECK (slot_number > 1),
  approved_by_user_id TEXT NOT NULL REFERENCES users (user_id),
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_quota_approvals_not_blank CHECK (
    btrim(approval_id) <> ''
    AND approval_id = btrim(approval_id)
    AND btrim(reason) <> ''
    AND reason = btrim(reason)
  ),
  CONSTRAINT community_creation_quota_approvals_subject_slot_unique
    UNIQUE (subject_key_id, slot_number),
  CONSTRAINT community_creation_quota_approvals_binding_unique
    UNIQUE (approval_id, subject_key_id, actor_id, slot_number)
);

CREATE TABLE community_creation_subject_claims (
  claim_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL REFERENCES subject_keys (subject_key_id),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  approval_id TEXT UNIQUE,
  intent_id TEXT NOT NULL UNIQUE REFERENCES community_creation_intents (intent_id),
  community_id TEXT NOT NULL UNIQUE REFERENCES communities (community_id),
  proof_session_id TEXT NOT NULL REFERENCES proof_sessions (proof_session_id),
  evidence_receipt_id TEXT NOT NULL REFERENCES evidence_receipts (evidence_receipt_id),
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_subject_claims_not_blank CHECK (
    btrim(claim_id) <> ''
    AND claim_id = btrim(claim_id)
  ),
  CONSTRAINT community_creation_subject_claims_slot_shape CHECK (
    (slot_number = 1 AND approval_id IS NULL)
    OR (slot_number > 1 AND approval_id IS NOT NULL)
  ),
  CONSTRAINT community_creation_subject_claims_subject_slot_unique
    UNIQUE (subject_key_id, slot_number),
  CONSTRAINT community_creation_subject_claims_approval_fk
    FOREIGN KEY (approval_id, subject_key_id, actor_id, slot_number)
    REFERENCES community_creation_quota_approvals (
      approval_id,
      subject_key_id,
      actor_id,
      slot_number
    )
);

CREATE OR REPLACE FUNCTION guard_community_creation_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.intent_id,
    NEW.actor_id,
    NEW.create_idempotency_key,
    NEW.create_request_hash,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.intent_id,
    OLD.actor_id,
    OLD.create_idempotency_key,
    OLD.create_request_hash,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community creation intent identity is immutable';
  END IF;

  IF OLD.status IN (
    'committed',
    'quota_exceeded',
    'gate_unsupported',
    'expired',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'terminal community creation intent is immutable';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'community creation intent revision must advance exactly once';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'verification_required' AND NEW.status IN (
      'draft',
      'commit_ready',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'commit_ready' AND NEW.status IN (
      'draft',
      'committed',
      'quota_exceeded',
      'expired',
      'cancelled'
    ))
  ) THEN
    RAISE EXCEPTION 'community creation intent transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- 0026_text_moderation_foundation.sql

CREATE TABLE text_moderation_policy_revisions (
  policy_revision_id TEXT PRIMARY KEY,
  policy_hash TEXT NOT NULL UNIQUE
    CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  policy_preimage TEXT NOT NULL,
  policy_document JSONB NOT NULL,
  provider_id TEXT NOT NULL,
  model_identifier TEXT NOT NULL,
  base_url_origin TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  sexual_minors_block_threshold NUMERIC NOT NULL
    CHECK (sexual_minors_block_threshold >= 0 AND sexual_minors_block_threshold <= 1),
  normalization_revision TEXT NOT NULL,
  decision_mapper_revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_moderation_policy_identifiers_not_blank CHECK (
    btrim(policy_revision_id) <> ''
    AND policy_revision_id = btrim(policy_revision_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(model_identifier) <> ''
    AND model_identifier = btrim(model_identifier)
    AND btrim(base_url_origin) <> ''
    AND base_url_origin = btrim(base_url_origin)
    AND btrim(normalization_revision) <> ''
    AND normalization_revision = btrim(normalization_revision)
    AND btrim(decision_mapper_revision) <> ''
    AND decision_mapper_revision = btrim(decision_mapper_revision)
  ),
  CONSTRAINT text_moderation_policy_document_object
    CHECK (jsonb_typeof(policy_document) = 'object'),
  CONSTRAINT text_moderation_policy_preimage_matches_document
    CHECK (policy_preimage::jsonb = policy_document),
  CONSTRAINT text_moderation_policy_revision_hash_unique
    UNIQUE (policy_revision_id, policy_hash)
);

CREATE TABLE text_moderation_policy_current (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  policy_revision_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_moderation_policy_current_revision_fk
    FOREIGN KEY (policy_revision_id)
    REFERENCES text_moderation_policy_revisions (policy_revision_id)
);

INSERT INTO text_moderation_policy_revisions (
  policy_revision_id,
  policy_hash,
  policy_preimage,
  policy_document,
  provider_id,
  model_identifier,
  base_url_origin,
  timeout_ms,
  sexual_minors_block_threshold,
  normalization_revision,
  decision_mapper_revision
) VALUES (
  'text-moderation-policy-v1',
  'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
  '{"base_url_origin":"https://api.openai.com","decision_mapper_revision":"openai-text-v1","model":"omni-moderation-latest","normalization_revision":"text-moderation-input-v1","provider_id":"openai","sexual_minors_block_threshold":0.95,"timeout_ms":10000,"version":"text-moderation-policy-v1"}',
  '{"base_url_origin":"https://api.openai.com","decision_mapper_revision":"openai-text-v1","model":"omni-moderation-latest","normalization_revision":"text-moderation-input-v1","provider_id":"openai","sexual_minors_block_threshold":0.95,"timeout_ms":10000,"version":"text-moderation-policy-v1"}'::jsonb,
  'openai',
  'omni-moderation-latest',
  'https://api.openai.com',
  10000,
  0.95,
  'text-moderation-input-v1',
  'openai-text-v1'
);

INSERT INTO text_moderation_policy_current (singleton, policy_revision_id)
VALUES (TRUE, 'text-moderation-policy-v1');

CREATE TABLE text_moderation_evidence (
  evidence_ref TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  requested_model_identifier TEXT NOT NULL,
  response_model_identifier TEXT,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('evaluated', 'provider_unavailable', 'provider_timeout', 'provider_invalid')),
  normalized_categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_sha256 TEXT CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_moderation_evidence_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(requested_model_identifier) <> ''
    AND requested_model_identifier = btrim(requested_model_identifier)
    AND (
      response_model_identifier IS NULL
      OR (
        btrim(response_model_identifier) <> ''
        AND response_model_identifier = btrim(response_model_identifier)
      )
    )
  ),
  CONSTRAINT text_moderation_evidence_categories_object
    CHECK (jsonb_typeof(normalized_categories) = 'object'),
  CONSTRAINT text_moderation_evidence_scores_object
    CHECK (jsonb_typeof(normalized_scores) = 'object')
);

CREATE OR REPLACE FUNCTION valid_text_moderation_reason_codes(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(value) AS reason(code)
     WHERE code NOT IN (
       'sexual_minors', 'adult_sexual', 'graphic_violence', 'harassment',
       'threat', 'hate', 'self_harm', 'illicit', 'spam', 'other_policy',
       'age_gate_required', 'provider_unavailable', 'provider_timeout',
       'provider_invalid'
     )
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN (
    SELECT count(*) = count(DISTINCT code)
      FROM jsonb_array_elements_text(value) AS reason(code)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE TABLE text_content_submissions (
  community_id TEXT NOT NULL,
  submission_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('text_post', 'comment', 'reply')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('published', 'manual_review', 'blocked')),
  moderation_decision TEXT NOT NULL
    CHECK (moderation_decision IN ('allow', 'manual_review', 'blocked')),
  public_reason_code TEXT
    CHECK (
      public_reason_code IS NULL
      OR public_reason_code IN ('review_required', 'moderation_unavailable', 'policy_violation')
    ),
  policy_revision_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  internal_reason_codes JSONB NOT NULL,
  evidence_ref TEXT,
  published_post_id TEXT,
  published_comment_id TEXT,
  review_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_content_submissions_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT text_content_submissions_policy_fk
    FOREIGN KEY (policy_revision_id, policy_hash)
    REFERENCES text_moderation_policy_revisions (policy_revision_id, policy_hash),
  CONSTRAINT text_content_submissions_evidence_fk
    FOREIGN KEY (evidence_ref) REFERENCES text_moderation_evidence (evidence_ref),
  CONSTRAINT text_content_submissions_post_fk
    FOREIGN KEY (community_id, published_post_id)
    REFERENCES posts (community_id, post_id),
  CONSTRAINT text_content_submissions_comment_fk
    FOREIGN KEY (community_id, published_comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT text_content_submissions_identifiers_not_blank CHECK (
    btrim(submission_id) <> ''
    AND submission_id = btrim(submission_id)
    AND btrim(actor_user_id) <> ''
    AND actor_user_id = btrim(actor_user_id)
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND (review_ref IS NULL OR (btrim(review_ref) <> '' AND review_ref = btrim(review_ref)))
  ),
  CONSTRAINT text_content_submissions_reasons_array
    CHECK (
      valid_text_moderation_reason_codes(internal_reason_codes)
      AND (
        (moderation_decision = 'allow' AND jsonb_array_length(internal_reason_codes) = 0)
        OR (
          moderation_decision = 'manual_review'
          AND jsonb_array_length(internal_reason_codes) > 0
          AND NOT internal_reason_codes ? 'sexual_minors'
        )
        OR (
          moderation_decision = 'blocked'
          AND jsonb_array_length(internal_reason_codes) > 0
          AND NOT internal_reason_codes ?| ARRAY[
            'age_gate_required',
            'provider_unavailable',
            'provider_timeout',
            'provider_invalid'
          ]
        )
      )
    ),
  CONSTRAINT text_content_submissions_status_shape CHECK (
    (
      status = 'published'
      AND public_reason_code IS NULL
      AND review_ref IS NULL
      AND (
        (surface = 'text_post' AND published_post_id IS NOT NULL AND published_comment_id IS NULL)
        OR (
          surface IN ('comment', 'reply')
          AND published_post_id IS NULL
          AND published_comment_id IS NOT NULL
        )
      )
    )
    OR (
      status = 'manual_review'
      AND public_reason_code IS NOT NULL
      AND public_reason_code IN ('review_required', 'moderation_unavailable')
      AND review_ref IS NOT NULL
      AND published_post_id IS NULL
      AND published_comment_id IS NULL
    )
    OR (
      status = 'blocked'
      AND public_reason_code IS NOT NULL
      AND public_reason_code = 'policy_violation'
      AND review_ref IS NULL
      AND published_post_id IS NULL
      AND published_comment_id IS NULL
    )
  ),
  CONSTRAINT text_content_submissions_time_order CHECK (updated_at >= created_at),
  CONSTRAINT text_content_submissions_community_id_unique UNIQUE (community_id, submission_id),
  CONSTRAINT text_content_submissions_actor_idempotency_unique
    UNIQUE (community_id, actor_user_id, surface, idempotency_key)
);

COMMENT ON COLUMN text_content_submissions.moderation_decision IS
  'Immutable original moderation evaluation; the public result derives from status and public_reason_code after review resolution.';

CREATE INDEX text_content_submissions_actor_created_idx
  ON text_content_submissions (actor_user_id, created_at DESC, submission_id);

CREATE INDEX text_content_submissions_review_idx
  ON text_content_submissions (community_id, status, created_at, submission_id)
  WHERE status = 'manual_review';

CREATE TABLE text_content_held_revisions (
  community_id TEXT NOT NULL,
  held_revision_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_content_held_revisions_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT text_content_held_revisions_identifiers_not_blank CHECK (
    btrim(held_revision_id) <> ''
    AND held_revision_id = btrim(held_revision_id)
  ),
  CONSTRAINT text_content_held_revisions_content_present CHECK (
    (title IS NOT NULL AND btrim(title) <> '')
    OR (body IS NOT NULL AND btrim(body) <> '')
  )
);

CREATE TABLE text_moderation_cases (
  community_id TEXT NOT NULL,
  case_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'approved', 'dismissed', 'blocked')),
  resolved_by_user_id TEXT,
  resolution_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_moderation_cases_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT text_moderation_cases_identifiers_not_blank CHECK (
    btrim(case_id) <> ''
    AND case_id = btrim(case_id)
    AND (
      resolved_by_user_id IS NULL
      OR (btrim(resolved_by_user_id) <> '' AND resolved_by_user_id = btrim(resolved_by_user_id))
    )
  ),
  CONSTRAINT text_moderation_cases_status_shape CHECK (
    (status = 'open' AND resolved_by_user_id IS NULL)
    OR (status <> 'open' AND resolved_by_user_id IS NOT NULL)
  ),
  CONSTRAINT text_moderation_cases_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX text_moderation_cases_open_idx
  ON text_moderation_cases (community_id, created_at, case_id)
  WHERE status = 'open';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM home_feed_projection
     GROUP BY community_id, post_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'home feed projection duplicates require explicit reconciliation before text moderation';
  END IF;
END;
$$;

CREATE UNIQUE INDEX home_feed_projection_post_unique
  ON home_feed_projection (community_id, post_id);

CREATE OR REPLACE FUNCTION reject_text_moderation_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER text_moderation_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON text_moderation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER text_moderation_evidence_append_only
BEFORE UPDATE OR DELETE ON text_moderation_evidence
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER text_content_held_revisions_append_only
BEFORE UPDATE OR DELETE ON text_content_held_revisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE OR REPLACE FUNCTION validate_text_review_child_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  submission_status TEXT;
  submission_review_ref TEXT;
BEGIN
  SELECT status, review_ref
    INTO submission_status, submission_review_ref
    FROM text_content_submissions
   WHERE community_id = NEW.community_id
     AND submission_id = NEW.submission_id
   FOR KEY SHARE;

  IF NOT FOUND OR submission_status <> 'manual_review' THEN
    RAISE EXCEPTION 'review children require a manual-review submission';
  END IF;
  IF TG_TABLE_NAME = 'text_moderation_cases'
    AND (to_jsonb(NEW) ->> 'case_id') <> submission_review_ref
  THEN
    RAISE EXCEPTION 'moderation case must match the submission review reference';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_content_held_revision_insert_guard
BEFORE INSERT ON text_content_held_revisions
FOR EACH ROW EXECUTE FUNCTION validate_text_review_child_insert();

CREATE TRIGGER text_moderation_case_insert_guard
BEFORE INSERT ON text_moderation_cases
FOR EACH ROW EXECUTE FUNCTION validate_text_review_child_insert();

CREATE OR REPLACE FUNCTION guard_text_moderation_case_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.community_id, NEW.case_id, NEW.submission_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.community_id, OLD.case_id, OLD.submission_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'text moderation case identity is immutable';
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('approved', 'dismissed', 'blocked') THEN
    RAISE EXCEPTION 'text moderation case transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text moderation case updated_at must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_moderation_case_update_guard
BEFORE UPDATE ON text_moderation_cases
FOR EACH ROW EXECUTE FUNCTION guard_text_moderation_case_update();

CREATE TRIGGER text_moderation_case_delete_guard
BEFORE DELETE ON text_moderation_cases
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE OR REPLACE FUNCTION guard_text_content_submission_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id,
    NEW.submission_id,
    NEW.actor_user_id,
    NEW.surface,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.moderation_decision,
    NEW.policy_revision_id,
    NEW.policy_hash,
    NEW.input_sha256,
    NEW.internal_reason_codes,
    NEW.evidence_ref,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.community_id,
    OLD.submission_id,
    OLD.actor_user_id,
    OLD.surface,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.moderation_decision,
    OLD.policy_revision_id,
    OLD.policy_hash,
    OLD.input_sha256,
    OLD.internal_reason_codes,
    OLD.evidence_ref,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'text content submission evidence is immutable';
  END IF;

  IF OLD.status <> 'manual_review' OR NEW.status NOT IN ('published', 'blocked') THEN
    RAISE EXCEPTION 'text content submission transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text content submission updated_at must advance';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER text_content_submission_update_guard
BEFORE UPDATE ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_update();

CREATE TRIGGER text_content_submission_delete_guard
BEFORE DELETE ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE OR REPLACE FUNCTION validate_text_content_submission_relations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_community_id TEXT;
  target_submission_id TEXT;
  submission text_content_submissions%ROWTYPE;
  held_count INTEGER;
  case_count INTEGER;
  persisted_case text_moderation_cases%ROWTYPE;
BEGIN
  target_community_id := COALESCE(NEW.community_id, OLD.community_id);
  target_submission_id := COALESCE(NEW.submission_id, OLD.submission_id);

  SELECT * INTO submission
    FROM text_content_submissions
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO held_count
    FROM text_content_held_revisions
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  SELECT count(*) INTO case_count
    FROM text_moderation_cases
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  SELECT * INTO persisted_case
    FROM text_moderation_cases
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;

  IF submission.status = 'manual_review' THEN
    IF submission.moderation_decision <> 'manual_review'
      OR held_count <> 1 OR case_count <> 1 OR persisted_case.status <> 'open'
      OR persisted_case.case_id <> submission.review_ref
    THEN
      RAISE EXCEPTION 'manual-review submission requires one matching held revision and open case';
    END IF;
  ELSIF held_count <> case_count OR held_count > 1 THEN
    RAISE EXCEPTION 'historical review evidence must remain paired';
  ELSIF held_count = 0 AND (
    (submission.status = 'published' AND submission.moderation_decision <> 'allow')
    OR (submission.status = 'blocked' AND submission.moderation_decision <> 'blocked')
  ) THEN
    RAISE EXCEPTION 'direct submission result does not match its moderation decision';
  ELSIF held_count = 1 AND submission.moderation_decision <> 'manual_review' THEN
    RAISE EXCEPTION 'reviewed submission must retain its manual-review decision';
  ELSIF held_count = 1 AND (
    (submission.status = 'published' AND persisted_case.status <> 'approved')
    OR (
      submission.status = 'blocked'
      AND persisted_case.status NOT IN ('blocked', 'dismissed')
    )
  ) THEN
    RAISE EXCEPTION 'submission result does not match its moderation case';
  END IF;

  IF submission.status = 'published' AND submission.surface = 'text_post' AND NOT EXISTS (
    SELECT 1
      FROM posts
     WHERE community_id = submission.community_id
       AND post_id = submission.published_post_id
       AND status = 'published'
       AND post_type = 'text'
       AND author_user_id = submission.actor_user_id
  ) THEN
    RAISE EXCEPTION 'published text submission requires its matching published text post';
  END IF;

  IF submission.status = 'published' AND submission.surface = 'text_post' AND NOT EXISTS (
    SELECT 1
      FROM home_feed_projection
     WHERE community_id = submission.community_id
       AND post_id = submission.published_post_id
  ) THEN
    RAISE EXCEPTION 'published text submission requires its atomic home feed projection';
  END IF;

  IF submission.status = 'published' AND submission.surface IN ('comment', 'reply') AND NOT EXISTS (
    SELECT 1
      FROM comments
     WHERE community_id = submission.community_id
       AND comment_id = submission.published_comment_id
       AND status = 'published'
       AND author_user_id = submission.actor_user_id
  ) THEN
    RAISE EXCEPTION 'published comment submission requires its matching published comment';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER text_content_submission_relations_guard
AFTER INSERT OR UPDATE ON text_content_submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE CONSTRAINT TRIGGER text_content_held_revision_relations_guard
AFTER INSERT ON text_content_held_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE CONSTRAINT TRIGGER text_moderation_case_relations_guard
AFTER INSERT OR UPDATE ON text_moderation_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

-- 0025_community_creation_storage_identity.sql

ALTER TABLE communities
  ADD COLUMN description TEXT;

ALTER TABLE communities
  ADD CONSTRAINT communities_route_slug_length_check
  CHECK (route_slug IS NULL OR char_length(route_slug) <= 256);

ALTER TABLE policy_versions
  DROP CONSTRAINT policy_versions_pkey;

ALTER TABLE policy_versions
  DROP CONSTRAINT policy_versions_community_version_unique;

ALTER TABLE policy_versions
  ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (community_id, policy_version_id);

ALTER TABLE community_policy_provider_bindings
  DROP CONSTRAINT community_policy_provider_bindings_pkey;

ALTER TABLE community_policy_provider_bindings
  ADD CONSTRAINT community_policy_provider_bindings_pkey
  PRIMARY KEY (community_id, policy_key, policy_version_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM community_policy_provider_bindings) THEN
    RAISE EXCEPTION
      'community policy provider bindings require an explicit complete-binding backfill';
  END IF;
END;
$$;

ALTER TABLE community_policy_provider_bindings
  ADD COLUMN issuer TEXT NOT NULL,
  ADD COLUMN scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('none', 'issuer_rp_scope', 'issuer_rp_action_scope')),
  ADD COLUMN issuer_rp_scope TEXT,
  ADD COLUMN issuer_rp_action_scope TEXT,
  ADD COLUMN request_mode TEXT NOT NULL
    CHECK (request_mode IN ('curated', 'dynamic')),
  ADD COLUMN evaluator_id TEXT NOT NULL,
  ADD CONSTRAINT community_policy_provider_bindings_resolution_not_blank CHECK (
    btrim(issuer) <> ''
    AND issuer = btrim(issuer)
    AND btrim(evaluator_id) <> ''
    AND evaluator_id = btrim(evaluator_id)
    AND (
      issuer_rp_scope IS NULL
      OR (btrim(issuer_rp_scope) <> '' AND issuer_rp_scope = btrim(issuer_rp_scope))
    )
    AND (
      issuer_rp_action_scope IS NULL
      OR (
        btrim(issuer_rp_action_scope) <> ''
        AND issuer_rp_action_scope = btrim(issuer_rp_action_scope)
      )
    )
  ),
  ADD CONSTRAINT community_policy_provider_bindings_scope_shape CHECK (
    (scope_kind = 'none' AND issuer_rp_scope IS NULL AND issuer_rp_action_scope IS NULL)
    OR (
      scope_kind = 'issuer_rp_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NULL
    )
    OR (
      scope_kind = 'issuer_rp_action_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NOT NULL
    )
  ),
  ADD CONSTRAINT community_policy_provider_bindings_request_shape CHECK (
    (request_mode = 'curated' AND provider_configuration_kind = 'managed')
    OR (request_mode = 'dynamic' AND provider_configuration_kind = 'dynamic')
  );

CREATE TRIGGER community_creation_intent_update_guard
BEFORE UPDATE ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_intent_update();

CREATE OR REPLACE FUNCTION reject_community_creation_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_creation_intent_revision_append_only
BEFORE UPDATE OR DELETE ON community_creation_intent_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_policy_provider_binding_append_only
BEFORE UPDATE OR DELETE ON community_policy_provider_bindings
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_quota_approval_append_only
BEFORE UPDATE OR DELETE ON community_creation_quota_approvals
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_subject_claim_append_only
BEFORE UPDATE OR DELETE ON community_creation_subject_claims
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_intent_delete_guard
BEFORE DELETE ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

-- 0024_community_creation_preflight_transition.sql

CREATE OR REPLACE FUNCTION guard_community_creation_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.intent_id,
    NEW.actor_id,
    NEW.create_idempotency_key,
    NEW.create_request_hash,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.intent_id,
    OLD.actor_id,
    OLD.create_idempotency_key,
    OLD.create_request_hash,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community creation intent identity is immutable';
  END IF;

  IF OLD.status IN (
    'committed',
    'quota_exceeded',
    'gate_unsupported',
    'expired',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'terminal community creation intent is immutable';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'community creation intent revision must advance exactly once';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'verification_required' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'commit_ready' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
  ) THEN
    RAISE EXCEPTION 'community creation intent transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- 0027_community_routes_and_creation_requirements.sql

-- Canonical community-route authority and two independently fenced creation
-- requirements. This is the additive half of the clean break: legacy
-- communities.route_slug and the single-requirement creation columns remain
-- physically present until the runtime cutover migration.

-- SQL owns the protocol-syntactic ACE envelope. The application-owned,
-- exact-pinned route-label-codec-v1 additionally proves ACE/display/ACE
-- round-trip equality before any write; PostgreSQL cannot express that
-- Unicode-versioned invariant in a CHECK constraint.
CREATE FUNCTION is_community_route_root_label(
  route_family TEXT,
  root_label TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE route_family
    WHEN 'hns' THEN
      octet_length(root_label) BETWEEN 1 AND 63
      AND root_label ~ '^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$'
      AND root_label NOT IN ('example', 'invalid', 'local', 'localhost', 'test')
    WHEN 'spaces' THEN
      octet_length(root_label) BETWEEN 1 AND 62
      AND root_label ~ '^[a-z0-9-]+$'
      AND CASE
        WHEN left(root_label, 4) = 'xn--' AND octet_length(root_label) > 4
          THEN substring(root_label FROM 5)
        ELSE root_label
      END ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ELSE FALSE
  END;
$$;

CREATE FUNCTION is_community_route_root_label_display(root_label_display TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT octet_length(root_label_display) BETWEEN 1 AND 255
    AND root_label_display = btrim(root_label_display)
    AND root_label_display !~ '[[:cntrl:]]'
    AND position('@' IN root_label_display) = 0
    AND position('.' IN root_label_display) = 0
    AND position('%' IN root_label_display) = 0
    AND position('/' IN root_label_display) = 0
    AND position(E'\\' IN root_label_display) = 0;
$$;

CREATE TABLE community_creation_requirement_states (
  intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  status TEXT NOT NULL
    CHECK (status IN ('unmet', 'pending', 'satisfied', 'failed', 'expired')),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  route_family TEXT CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT,
  route_root_label_display TEXT,
  route_path_segment TEXT,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_ceremony_intent_id TEXT,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (intent_id, requirement_kind),
  CONSTRAINT community_creation_requirement_states_actor_intent_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_requirement_states_identifiers_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_requirement_states_route_shape CHECK (
    (
      requirement_kind = 'human_identity'
      AND route_family IS NULL
      AND route_root_label IS NULL
      AND route_root_label_display IS NULL
      AND route_path_segment IS NULL
    )
    OR (
      requirement_kind = 'namespace_ownership'
      AND route_family IS NOT NULL
      AND route_root_label IS NOT NULL
      AND route_root_label_display IS NOT NULL
      AND route_path_segment IS NOT NULL
      AND is_community_route_root_label(route_family, route_root_label) IS TRUE
      AND is_community_route_root_label_display(route_root_label_display) IS TRUE
      AND route_path_segment = CASE route_family
        WHEN 'hns' THEN 'app.' || route_root_label
        WHEN 'spaces' THEN '@' || route_root_label
      END
    )
  ),
  CONSTRAINT community_creation_requirement_states_progress_shape CHECK (
    (
      status = 'unmet'
      AND current_ceremony_intent_id IS NULL
      AND satisfied_at IS NULL
    )
    OR (
      status IN ('pending', 'failed', 'expired')
      AND generation > 0
      AND current_ceremony_intent_id IS NOT NULL
      AND btrim(current_ceremony_intent_id) <> ''
      AND current_ceremony_intent_id = btrim(current_ceremony_intent_id)
      AND satisfied_at IS NULL
    )
    OR (
      status = 'satisfied'
      AND generation > 0
      AND current_ceremony_intent_id IS NOT NULL
      AND btrim(current_ceremony_intent_id) <> ''
      AND current_ceremony_intent_id = btrim(current_ceremony_intent_id)
      AND satisfied_at IS NOT NULL
    )
  ),
  CONSTRAINT community_creation_requirement_states_time_order
    CHECK (updated_at >= created_at)
);

CREATE TABLE community_creation_ceremony_attempts (
  ceremony_intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  route_family TEXT CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT,
  route_root_label_display TEXT,
  route_path_segment TEXT,
  reservation_request_hash TEXT NOT NULL
    CHECK (reservation_request_hash ~ '^[0-9a-f]{64}$'),
  reservation_request JSONB NOT NULL CHECK (jsonb_typeof(reservation_request) = 'object'),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_ceremony_attempts_identity_unique
    UNIQUE (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id),
  CONSTRAINT community_creation_ceremony_attempts_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT community_creation_ceremony_attempts_generation_unique
    UNIQUE (intent_id, requirement_kind, generation),
  CONSTRAINT community_creation_ceremony_attempts_state_fk
    FOREIGN KEY (intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT community_creation_ceremony_attempts_actor_intent_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_ceremony_attempts_identifiers_not_blank CHECK (
    btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_ceremony_attempts_route_shape CHECK (
    (
      requirement_kind = 'human_identity'
      AND route_family IS NULL
      AND route_root_label IS NULL
      AND route_root_label_display IS NULL
      AND route_path_segment IS NULL
    )
    OR (
      requirement_kind = 'namespace_ownership'
      AND route_family IS NOT NULL
      AND route_root_label IS NOT NULL
      AND route_root_label_display IS NOT NULL
      AND route_path_segment IS NOT NULL
      AND is_community_route_root_label(route_family, route_root_label) IS TRUE
      AND is_community_route_root_label_display(route_root_label_display) IS TRUE
      AND route_path_segment = CASE route_family
        WHEN 'hns' THEN 'app.' || route_root_label
        WHEN 'spaces' THEN '@' || route_root_label
      END
    )
  ),
  CONSTRAINT community_creation_ceremony_attempts_time_order CHECK (
    expires_at > reserved_at
    AND created_at >= reserved_at
  )
);

ALTER TABLE community_creation_requirement_states
  ADD CONSTRAINT community_creation_requirement_states_current_ceremony_fk
  FOREIGN KEY (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    current_ceremony_intent_id
  )
  REFERENCES community_creation_ceremony_attempts (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  )
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE verification_start_reservations
  ADD COLUMN creation_intent_id TEXT,
  ADD COLUMN creation_requirement_kind TEXT,
  ADD COLUMN creation_generation BIGINT,
  ADD COLUMN client_idempotency_key TEXT,
  ADD CONSTRAINT verification_start_reservations_creation_shape CHECK (
    (
      creation_intent_id IS NULL
      AND creation_requirement_kind IS NULL
      AND creation_generation IS NULL
      AND client_idempotency_key IS NULL
    )
    OR (
      creation_intent_id IS NOT NULL
      AND creation_requirement_kind IN ('human_identity', 'namespace_ownership')
      AND creation_generation > 0
      AND client_idempotency_key IS NOT NULL
      AND btrim(client_idempotency_key) <> ''
      AND client_idempotency_key = btrim(client_idempotency_key)
    )
  ),
  ADD CONSTRAINT verification_start_reservations_creation_ceremony_fk
  FOREIGN KEY (
    actor_id,
    creation_intent_id,
    creation_requirement_kind,
    creation_generation,
    intent_id
  )
  REFERENCES community_creation_ceremony_attempts (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  );

CREATE UNIQUE INDEX verification_start_reservations_creation_idempotency_uidx
  ON verification_start_reservations (
    actor_id,
    creation_intent_id,
    creation_requirement_kind,
    client_idempotency_key
  )
  WHERE creation_intent_id IS NOT NULL;

ALTER TABLE proof_sessions
  ADD COLUMN creation_ceremony_intent_id TEXT UNIQUE
    REFERENCES community_creation_ceremony_attempts (ceremony_intent_id),
  ADD CONSTRAINT proof_sessions_creation_ceremony_actor_fk
    FOREIGN KEY (actor_id, creation_ceremony_intent_id)
    REFERENCES community_creation_ceremony_attempts (actor_id, ceremony_intent_id),
  ADD CONSTRAINT proof_sessions_creation_ceremony_identity CHECK (
    creation_ceremony_intent_id IS NULL
    OR creation_ceremony_intent_id = intent_id
  );

CREATE TABLE community_creation_ceremony_results (
  ceremony_intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_version TEXT NOT NULL,
  callback_idempotency_key TEXT NOT NULL,
  callback_request_hash TEXT NOT NULL CHECK (callback_request_hash ~ '^[0-9a-f]{64}$'),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('satisfied', 'failed', 'expired')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  proof_session_id TEXT UNIQUE REFERENCES proof_sessions (proof_session_id),
  evidence_receipt_id TEXT,
  evidence_ref TEXT,
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT
    CHECK (provider_identity_digest IS NULL OR provider_identity_digest ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ NOT NULL,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_ceremony_results_attempt_fk
    FOREIGN KEY (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id)
    REFERENCES community_creation_ceremony_attempts (
      actor_id,
      intent_id,
      requirement_kind,
      generation,
      ceremony_intent_id
    ),
  CONSTRAINT community_creation_ceremony_results_receipt_actor_fk
    FOREIGN KEY (evidence_receipt_id, actor_id)
    REFERENCES evidence_receipts (evidence_receipt_id, user_id),
  CONSTRAINT community_creation_ceremony_results_identifiers_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(callback_idempotency_key) <> ''
    AND callback_idempotency_key = btrim(callback_idempotency_key)
    AND (evidence_ref IS NULL OR (btrim(evidence_ref) <> '' AND evidence_ref = btrim(evidence_ref)))
  ),
  CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (requirement_kind <> 'human_identity' OR evidence_receipt_id IS NOT NULL)
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
    )
  ),
  CONSTRAINT community_creation_ceremony_results_time_order CHECK (
    created_at >= terminal_at
    AND (satisfied_at IS NULL OR satisfied_at = terminal_at)
  )
);

CREATE UNIQUE INDEX community_creation_ceremony_results_callback_uidx
  ON community_creation_ceremony_results (
    actor_id,
    ceremony_intent_id,
    callback_idempotency_key
  );

CREATE TABLE community_route_ownership_evidence (
  evidence_ref TEXT PRIMARY KEY,
  creation_ceremony_intent_id TEXT NOT NULL
    REFERENCES community_creation_ceremony_attempts (ceremony_intent_id),
  verified_by_actor_id TEXT NOT NULL REFERENCES users (user_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_version TEXT NOT NULL,
  provider_identity_digest TEXT NOT NULL CHECK (provider_identity_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_receipt_id TEXT REFERENCES evidence_receipts (evidence_receipt_id),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_ownership_evidence_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_route_ownership_evidence_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ),
  CONSTRAINT community_route_ownership_evidence_time_order CHECK (
    created_at >= verified_at
    AND (expires_at IS NULL OR expires_at > verified_at)
  )
);

CREATE TABLE community_canonical_route_bindings (
  route_binding_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL UNIQUE REFERENCES communities (community_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT GENERATED ALWAYS AS (
    CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  href TEXT GENERATED ALWAYS AS (
    '/c/' || CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  ownership_status TEXT NOT NULL
    CHECK (ownership_status IN ('pending', 'verified', 'expired', 'disputed', 'revoked')),
  route_lifecycle_status TEXT NOT NULL DEFAULT 'suspended'
    CHECK (route_lifecycle_status IN ('active', 'suspended')),
  binding_generation BIGINT NOT NULL DEFAULT 1 CHECK (binding_generation > 0),
  verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_canonical_route_bindings_id_not_blank CHECK (
    btrim(route_binding_id) <> ''
    AND route_binding_id = btrim(route_binding_id)
  ),
  CONSTRAINT community_canonical_route_bindings_root_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
  ),
  CONSTRAINT community_canonical_route_bindings_active_shape CHECK (
    route_lifecycle_status <> 'active'
    OR (ownership_status = 'verified' AND verified_evidence_ref IS NOT NULL)
  ),
  CONSTRAINT community_canonical_route_bindings_time_order
    CHECK (updated_at >= created_at),
  CONSTRAINT community_canonical_route_bindings_id_family_unique
    UNIQUE (route_binding_id, family),
  CONSTRAINT community_canonical_route_bindings_community_id_unique
    UNIQUE (community_id, route_binding_id),
  CONSTRAINT community_canonical_route_bindings_path_unique UNIQUE (path_segment)
);

ALTER TABLE communities
  ADD COLUMN canonical_route_binding_id TEXT,
  ADD CONSTRAINT communities_canonical_route_binding_fk
  FOREIGN KEY (community_id, canonical_route_binding_id)
  REFERENCES community_canonical_route_bindings (community_id, route_binding_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE community_route_app_host_health (
  route_binding_id TEXT PRIMARY KEY,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  health_status TEXT NOT NULL
    CHECK (health_status IN ('unconfigured', 'pending', 'healthy', 'unhealthy', 'stale')),
  health_generation BIGINT NOT NULL DEFAULT 0 CHECK (health_generation >= 0),
  observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_app_host_health_route_fk
    FOREIGN KEY (route_binding_id, family)
    REFERENCES community_canonical_route_bindings (route_binding_id, family)
);

CREATE OR REPLACE FUNCTION guard_community_creation_requirement_state_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_changed BOOLEAN;
BEGIN
  IF ROW(NEW.intent_id, NEW.actor_id, NEW.requirement_kind, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.intent_id, OLD.actor_id, OLD.requirement_kind, OLD.created_at) THEN
    RAISE EXCEPTION 'community creation requirement identity is immutable';
  END IF;

  binding_changed := ROW(
    NEW.requirement_hash,
    NEW.provider_id,
    NEW.provider_binding_hash,
    NEW.provider_configuration_kind,
    NEW.provider_configuration_ref,
    NEW.provider_configuration_version,
    NEW.route_family,
    NEW.route_root_label,
    NEW.route_root_label_display,
    NEW.route_path_segment
  ) IS DISTINCT FROM ROW(
    OLD.requirement_hash,
    OLD.provider_id,
    OLD.provider_binding_hash,
    OLD.provider_configuration_kind,
    OLD.provider_configuration_ref,
    OLD.provider_configuration_version,
    OLD.route_family,
    OLD.route_root_label,
    OLD.route_root_label_display,
    OLD.route_path_segment
  );

  IF binding_changed THEN
    IF NEW.status <> 'unmet'
      OR NEW.generation <> OLD.generation
      OR NEW.current_ceremony_intent_id IS NOT NULL
      OR NEW.satisfied_at IS NOT NULL THEN
      RAISE EXCEPTION 'changed requirement binding must invalidate current evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    (
      OLD.status IN ('unmet', 'failed', 'expired')
      AND NEW.status = 'pending'
      AND NEW.generation = OLD.generation + 1
      AND NEW.current_ceremony_intent_id IS NOT NULL
      AND NEW.satisfied_at IS NULL
    )
    OR (
      OLD.status = 'pending'
      AND NEW.status IN ('satisfied', 'failed', 'expired')
      AND NEW.generation = OLD.generation
      AND NEW.current_ceremony_intent_id = OLD.current_ceremony_intent_id
    )
  ) THEN
    RAISE EXCEPTION 'community creation requirement transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_requirement_state_update_guard
BEFORE UPDATE ON community_creation_requirement_states
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_requirement_state_update();

CREATE TRIGGER community_creation_requirement_state_delete_guard
BEFORE DELETE ON community_creation_requirement_states
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = NEW.intent_id
     AND requirement_kind = NEW.requirement_kind
   FOR UPDATE;

  IF NOT FOUND
    OR state_record.actor_id <> NEW.actor_id
    OR state_record.status NOT IN ('unmet', 'failed', 'expired')
    OR NEW.generation <> state_record.generation + 1
    OR NEW.requirement_hash <> state_record.requirement_hash
    OR NEW.provider_id <> state_record.provider_id
    OR NEW.provider_binding_hash <> state_record.provider_binding_hash
    OR NEW.provider_configuration_kind <> state_record.provider_configuration_kind
    OR NEW.provider_configuration_ref <> state_record.provider_configuration_ref
    OR NEW.provider_configuration_version <> state_record.provider_configuration_version
    OR NEW.route_family IS DISTINCT FROM state_record.route_family
    OR NEW.route_root_label IS DISTINCT FROM state_record.route_root_label
    OR NEW.route_root_label_display IS DISTINCT FROM state_record.route_root_label_display
    OR NEW.route_path_segment IS DISTINCT FROM state_record.route_path_segment THEN
    RAISE EXCEPTION 'ceremony reservation does not match the current requirement binding';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_ceremony_attempt_insert_guard
BEFORE INSERT ON community_creation_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_attempt_insert();

CREATE TRIGGER community_creation_ceremony_attempt_append_only
BEFORE UPDATE OR DELETE ON community_creation_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO session_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_configuration_kind <>
        attempt_record.provider_configuration_kind
      OR session_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR session_record.provider_configuration_version <>
        attempt_record.provider_configuration_version THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <>
        attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <>
        attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <>
        attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_ceremony_result_insert_guard
BEFORE INSERT ON community_creation_ceremony_results
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_result_insert();

CREATE TRIGGER community_creation_ceremony_result_append_only
BEFORE UPDATE OR DELETE ON community_creation_ceremony_results
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = attempt_record.intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;

  IF attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR attempt_record.requirement_kind <> 'namespace_ownership'
    OR result_record.outcome_status <> 'satisfied'
    OR state_record.status <> 'satisfied'
    OR state_record.generation <> attempt_record.generation
    OR state_record.current_ceremony_intent_id <> NEW.creation_ceremony_intent_id
    OR NEW.verified_by_actor_id <> attempt_record.actor_id
    OR NEW.family <> attempt_record.route_family
    OR NEW.root_label <> attempt_record.route_root_label
    OR NEW.root_label_display <> attempt_record.route_root_label_display
    OR NEW.path_segment <> attempt_record.route_path_segment
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
    OR NEW.provider_identity_digest <> result_record.provider_identity_digest
    OR NEW.evidence_ref <> result_record.evidence_ref
    OR NEW.evidence_digest <> result_record.evidence_digest
    OR NEW.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
    OR NEW.verified_at <> result_record.satisfied_at THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_ownership_evidence_insert_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW EXECUTE FUNCTION validate_community_route_ownership_evidence_insert();

CREATE TRIGGER community_route_ownership_evidence_append_only
BEFORE UPDATE OR DELETE ON community_route_ownership_evidence
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN
      RETURN NULL;
    END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;

  IF NOT FOUND THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
    END IF;
    RETURN NULL;
  END IF;

  IF state_record.status IN ('satisfied', 'failed', 'expired') THEN
    IF result_record.ceremony_intent_id IS NULL
      OR result_record.outcome_status <> state_record.status
      OR result_record.actor_id <> state_record.actor_id
      OR result_record.intent_id <> state_record.intent_id
      OR result_record.requirement_kind <> state_record.requirement_kind
      OR result_record.generation <> state_record.generation
      OR result_record.requirement_hash <> state_record.requirement_hash
      OR result_record.provider_id <> state_record.provider_id
      OR result_record.provider_binding_hash <> state_record.provider_binding_hash
      OR result_record.provider_configuration_version <>
        state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_creation_requirement_result_state_guard
AFTER INSERT OR UPDATE ON community_creation_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

CREATE CONSTRAINT TRIGGER community_creation_ceremony_result_state_guard
AFTER INSERT ON community_creation_ceremony_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

CREATE OR REPLACE FUNCTION guard_community_canonical_route_binding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community canonical route binding is immutable';
  END IF;

  IF ROW(
    NEW.route_binding_id,
    NEW.community_id,
    NEW.family,
    NEW.root_label,
    NEW.root_label_display,
    NEW.created_at
  )
    IS DISTINCT FROM
    ROW(
      OLD.route_binding_id,
      OLD.community_id,
      OLD.family,
      OLD.root_label,
      OLD.root_label_display,
      OLD.created_at
    ) THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  authority_changed := ROW(
    NEW.ownership_status,
    NEW.route_lifecycle_status,
    NEW.verified_evidence_ref
  ) IS DISTINCT FROM ROW(
    OLD.ownership_status,
    OLD.route_lifecycle_status,
    OLD.verified_evidence_ref
  );

  IF authority_changed AND NEW.binding_generation <> OLD.binding_generation + 1 THEN
    RAISE EXCEPTION 'community canonical route generation must advance exactly once';
  END IF;
  IF NOT authority_changed AND NEW.binding_generation <> OLD.binding_generation THEN
    RAISE EXCEPTION 'community canonical route generation cannot advance without authority change';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_canonical_route_binding_update_guard
BEFORE UPDATE ON community_canonical_route_bindings
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE TRIGGER community_canonical_route_binding_delete_guard
BEFORE DELETE ON community_canonical_route_bindings
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE OR REPLACE FUNCTION guard_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.canonical_route_binding_id IS NOT NULL
    AND NEW.canonical_route_binding_id IS DISTINCT FROM OLD.canonical_route_binding_id THEN
    RAISE EXCEPTION 'community canonical route cannot be rebound or cleared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_canonical_route_reference_guard
BEFORE UPDATE OF canonical_route_binding_id ON communities
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_reference();

CREATE OR REPLACE FUNCTION validate_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  community_binding_id TEXT;
  binding_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    binding_id := NEW.canonical_route_binding_id;
    IF binding_id IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    binding_id := NEW.route_binding_id;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community canonical route binding is missing';
  END IF;

  SELECT canonical_route_binding_id INTO community_binding_id
    FROM communities
   WHERE community_id = binding_record.community_id;
  IF community_binding_id IS DISTINCT FROM binding_record.route_binding_id THEN
    RAISE EXCEPTION 'community canonical route reference is not reciprocal';
  END IF;

  IF binding_record.route_lifecycle_status = 'active' THEN
    SELECT * INTO evidence_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = binding_record.verified_evidence_ref;
    IF NOT FOUND
      OR binding_record.ownership_status <> 'verified'
      OR evidence_record.family <> binding_record.family
      OR evidence_record.root_label <> binding_record.root_label
      OR evidence_record.root_label_display <> binding_record.root_label_display
      OR evidence_record.path_segment <> binding_record.path_segment
      OR evidence_record.binding_generation <> binding_record.binding_generation THEN
      RAISE EXCEPTION 'active community route lacks matching verified ownership evidence';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_canonical_route_reference_guard
AFTER INSERT OR UPDATE ON community_canonical_route_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

CREATE CONSTRAINT TRIGGER communities_canonical_route_binding_guard
AFTER INSERT OR UPDATE OF canonical_route_binding_id ON communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

-- 0028_community_creation_requirement_result_guard.sql

-- Close the deferred requirement/result coherence gap without rewriting 0027.
-- A nonterminal requirement may wait for its result, but a terminal requirement
-- must have a matching immutable result by transaction commit.

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
  state_found BOOLEAN;
  result_found BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN
      RETURN NULL;
    END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;
  state_found := FOUND;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;
  result_found := FOUND;

  IF NOT result_found THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
    END IF;

    IF state_found
      AND state_record.status IN ('satisfied', 'failed', 'expired') THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;

    RETURN NULL;
  END IF;

  IF state_record.status IN ('satisfied', 'failed', 'expired') THEN
    IF result_record.ceremony_intent_id IS NULL
      OR result_record.outcome_status <> state_record.status
      OR result_record.actor_id <> state_record.actor_id
      OR result_record.intent_id <> state_record.intent_id
      OR result_record.requirement_kind <> state_record.requirement_kind
      OR result_record.generation <> state_record.generation
      OR result_record.requirement_hash <> state_record.requirement_hash
      OR result_record.provider_id <> state_record.provider_id
      OR result_record.provider_binding_hash <> state_record.provider_binding_hash
      OR result_record.provider_configuration_version <>
        state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;
-- Durable target-owned namespace-ownership sessions, completion leases, and
-- immutable HNS evidence snapshots.
--
-- Lock order for trigger paths that touch more than one row is fixed as:
-- users(actor) -> creation intent -> requirement state -> namespace session ->
-- completion attempt -> evidence snapshot/result. Provider calls are always
-- outside SQL, after the reservation transaction has committed.

ALTER TABLE community_creation_requirement_states
  ADD CONSTRAINT community_creation_requirement_states_actor_generation_unique
  UNIQUE (actor_id, intent_id, requirement_kind, generation);

CREATE TABLE namespace_ownership_start_reservations (
  reservation_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  client_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  route_family TEXT NOT NULL CHECK (route_family = 'hns'),
  route_root_label TEXT NOT NULL,
  route_root_label_display TEXT NOT NULL,
  route_path_segment TEXT NOT NULL,
  route_href TEXT NOT NULL,
  route_app_host TEXT,
  state TEXT NOT NULL DEFAULT 'acquired'
    CHECK (state IN ('acquired', 'released', 'finalized')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_start_reservations_actor_intent_fk
    FOREIGN KEY (actor_id, creation_intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT namespace_ownership_start_reservations_requirement_fk
    FOREIGN KEY (creation_intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT namespace_ownership_start_reservations_ceremony_fk
    FOREIGN KEY (
      actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id
    )
    REFERENCES community_creation_ceremony_attempts (
      actor_id, intent_id, requirement_kind, generation, ceremony_intent_id
    ),
  CONSTRAINT namespace_ownership_start_reservations_generation_unique
    UNIQUE (creation_intent_id, requirement_kind, generation),
  CONSTRAINT namespace_ownership_start_reservations_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT namespace_ownership_start_reservations_client_key_unique
    UNIQUE (actor_id, creation_intent_id, client_idempotency_key),
  CONSTRAINT namespace_ownership_start_reservations_session_unique
    UNIQUE (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_start_reservations_fence_unique
    UNIQUE (reservation_id, fence_token),
  CONSTRAINT namespace_ownership_start_reservations_identifiers_not_blank CHECK (
    btrim(reservation_id) <> ''
    AND reservation_id = btrim(reservation_id)
    AND btrim(namespace_session_id) <> ''
    AND namespace_session_id = btrim(namespace_session_id)
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(client_idempotency_key) <> ''
    AND client_idempotency_key = btrim(client_idempotency_key)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
  ),
  CONSTRAINT namespace_ownership_start_reservations_route_shape CHECK (
    is_community_route_root_label(route_family, route_root_label) IS TRUE
    AND is_community_route_root_label_display(route_root_label_display) IS TRUE
    AND route_path_segment = 'app.' || route_root_label
    AND route_href = '/c/' || route_path_segment
    AND route_app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_start_reservations_time_order CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX namespace_ownership_start_reservations_lease_idx
  ON namespace_ownership_start_reservations (state, lease_expires_at);

CREATE TABLE namespace_ownership_sessions (
  namespace_session_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  start_reservation_id TEXT NOT NULL,
  start_fence_token BIGINT NOT NULL CHECK (start_fence_token > 0),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  route_family TEXT NOT NULL CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT NOT NULL,
  route_root_label_display TEXT NOT NULL,
  route_path_segment TEXT NOT NULL,
  route_href TEXT NOT NULL,
  route_app_host TEXT,
  upstream_session_ref TEXT NOT NULL,
  presentation_kind TEXT NOT NULL
    CHECK (presentation_kind IN ('redirect', 'deeplink', 'embedded_sdk', 'poll', 'none')),
  presentation_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(presentation_payload) = 'object'),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_sessions_actor_intent_fk
    FOREIGN KEY (actor_id, creation_intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT namespace_ownership_sessions_requirement_fk
    FOREIGN KEY (creation_intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT namespace_ownership_sessions_ceremony_fk
    FOREIGN KEY (
      actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id
    )
    REFERENCES community_creation_ceremony_attempts (
      actor_id, intent_id, requirement_kind, generation, ceremony_intent_id
    ),
  CONSTRAINT namespace_ownership_sessions_start_reservation_fk
    FOREIGN KEY (start_reservation_id, start_fence_token)
    REFERENCES namespace_ownership_start_reservations (reservation_id, fence_token)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT namespace_ownership_sessions_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT namespace_ownership_sessions_generation_unique
    UNIQUE (creation_intent_id, requirement_kind, generation),
  CONSTRAINT namespace_ownership_sessions_identifiers_not_blank CHECK (
    btrim(namespace_session_id) <> ''
    AND namespace_session_id = btrim(namespace_session_id)
    AND btrim(start_reservation_id) <> ''
    AND start_reservation_id = btrim(start_reservation_id)
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
  ),
  CONSTRAINT namespace_ownership_sessions_route_shape CHECK (
    is_community_route_root_label(route_family, route_root_label) IS TRUE
    AND is_community_route_root_label_display(route_root_label_display) IS TRUE
    AND route_path_segment = CASE route_family
      WHEN 'hns' THEN 'app.' || route_root_label
      WHEN 'spaces' THEN '@' || route_root_label
    END
    AND route_href = '/c/' || route_path_segment
    AND route_app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_sessions_upstream_ref_shape CHECK (
    octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_sessions_request_lifecycle_shape CHECK (
    (
      status = 'pending'
      AND completed_at IS NULL
      AND terminal_at IS NULL
    )
    OR (
      status = 'completed'
      AND completed_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND completed_at = terminal_at
    )
    OR (
      status IN ('failed', 'expired')
      AND completed_at IS NULL
      AND terminal_at IS NOT NULL
      AND (status <> 'expired' OR terminal_at >= expires_at)
    )
  ),
  CONSTRAINT namespace_ownership_sessions_time_order CHECK (
    expires_at > started_at
    AND created_at >= started_at
    AND updated_at >= created_at
    AND (terminal_at IS NULL OR terminal_at >= started_at)
  )
);

ALTER TABLE namespace_ownership_sessions
  ADD CONSTRAINT namespace_ownership_sessions_id_actor_unique
  UNIQUE (namespace_session_id, actor_id);

CREATE OR REPLACE FUNCTION guard_namespace_ownership_start_reservation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership start reservations are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Lock order: actor -> intent -> requirement state -> start reservation.
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT * INTO intent_record
      FROM community_creation_intents
     WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
     FOR SHARE;
    SELECT * INTO state_record
      FROM community_creation_requirement_states
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
     FOR UPDATE;
    SELECT * INTO ceremony_record
      FROM community_creation_ceremony_attempts
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
       AND generation = NEW.generation
       AND ceremony_intent_id = NEW.ceremony_intent_id
     FOR SHARE;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
     FOR SHARE;

    IF intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR ceremony_record.ceremony_intent_id IS NULL
      OR state_record.status <> 'pending'
      OR intent_record.revision <> NEW.expected_revision
      OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
      OR state_record.generation <> NEW.generation
      OR state_record.requirement_hash <> NEW.requirement_hash
      OR state_record.provider_id <> NEW.provider_id
      OR state_record.provider_binding_hash <> NEW.provider_binding_hash
      OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR state_record.provider_configuration_version <> NEW.provider_configuration_version
      OR state_record.route_family <> NEW.route_family
      OR state_record.route_root_label <> NEW.route_root_label
      OR state_record.route_root_label_display <> NEW.route_root_label_display
      OR state_record.route_path_segment <> NEW.route_path_segment
      OR ceremony_record.requirement_hash <> NEW.requirement_hash
      OR ceremony_record.provider_id <> NEW.provider_id
      OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
      OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
      OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
      OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
      OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
      OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= clock_timestamp()
      OR (
        session_record.namespace_session_id IS NOT NULL
        AND NEW.lease_expires_at > session_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its ceremony';
    END IF;

    IF session_record.namespace_session_id IS NOT NULL
      AND (
        session_record.start_reservation_id <> NEW.reservation_id
        OR session_record.start_fence_token <> NEW.fence_token
        OR session_record.expected_revision <> NEW.expected_revision
        OR session_record.requirement_hash <> NEW.requirement_hash
        OR session_record.request_hash <> NEW.request_hash
        OR session_record.provider_id <> NEW.provider_id
        OR session_record.provider_binding_hash <> NEW.provider_binding_hash
        OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR session_record.provider_configuration_version <> NEW.provider_configuration_version
        OR session_record.protocol_version <> NEW.protocol_version
        OR session_record.environment <> NEW.environment
        OR session_record.route_family <> NEW.route_family
        OR session_record.route_root_label <> NEW.route_root_label
        OR session_record.route_root_label_display <> NEW.route_root_label_display
        OR session_record.route_path_segment <> NEW.route_path_segment
        OR session_record.route_href <> NEW.route_href
        OR session_record.route_app_host IS DISTINCT FROM NEW.route_app_host
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its session';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.reservation_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.creation_intent_id, NEW.ceremony_intent_id, NEW.requirement_kind,
    NEW.generation, NEW.requirement_hash, NEW.expected_revision,
    NEW.client_idempotency_key, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.reservation_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.creation_intent_id, OLD.ceremony_intent_id, OLD.requirement_kind,
    OLD.generation, OLD.requirement_hash, OLD.expected_revision,
    OLD.client_idempotency_key, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership start reservation authority is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  IF session_record.namespace_session_id IS NOT NULL
    AND NEW.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start lease exceeds its session expiry';
  END IF;

  IF OLD.state = 'acquired'
    AND NEW.state IN ('released', 'finalized')
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'released'
    AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'namespace ownership start reservation transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER namespace_ownership_start_reservation_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON namespace_ownership_start_reservations
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_start_reservation_change();

CREATE TABLE namespace_ownership_completion_attempts (
  -- The number of attempts is intentionally application-owned; no SQL budget
  -- is frozen until the namespace ceremony contract ratifies one.
  completion_attempt_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  idempotency_key TEXT NOT NULL,
  completion_request_hash TEXT NOT NULL CHECK (completion_request_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL,
  submission_channel TEXT NOT NULL DEFAULT 'poll_result'
    CHECK (submission_channel = 'poll_result'),
  state TEXT NOT NULL CHECK (state IN ('leased', 'released', 'consumed')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_completion_attempts_session_actor_fk
    FOREIGN KEY (namespace_session_id, actor_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_completion_attempts_idempotency_unique
    UNIQUE (namespace_session_id, idempotency_key),
  CONSTRAINT namespace_ownership_completion_attempts_evidence_ref_unique
    UNIQUE (evidence_ref),
  CONSTRAINT namespace_ownership_completion_attempts_identifiers_not_blank CHECK (
    btrim(completion_attempt_id) <> ''
    AND completion_attempt_id = btrim(completion_attempt_id)
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
  ),
  CONSTRAINT namespace_ownership_completion_attempts_time_order CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX namespace_ownership_completion_attempts_lease_idx
  ON namespace_ownership_completion_attempts (state, lease_expires_at);

CREATE TABLE namespace_ownership_evidence_snapshots (
  evidence_ref TEXT PRIMARY KEY,
  completion_attempt_id TEXT NOT NULL UNIQUE,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  href TEXT NOT NULL,
  app_host TEXT,
  upstream_session_ref TEXT NOT NULL,
  fence_token BIGINT NOT NULL CHECK (fence_token > 0),
  abi_version TEXT NOT NULL DEFAULT 'pirate-hns-ownership-evidence-v1'
    CHECK (abi_version = 'pirate-hns-ownership-evidence-v1'),
  ownership_source TEXT NOT NULL
    CHECK (ownership_source IN ('hns_parent_chain_txt', 'owner_authoritative_dns_txt')),
  challenge_name TEXT NOT NULL,
  challenge_value_sha256 TEXT NOT NULL CHECK (challenge_value_sha256 ~ '^[0-9a-f]{64}$'),
  root_exists BOOLEAN NOT NULL CHECK (root_exists IS TRUE),
  root_control_verified BOOLEAN NOT NULL CHECK (root_control_verified IS TRUE),
  expiry_horizon_sufficient BOOLEAN NOT NULL CHECK (expiry_horizon_sufficient IS TRUE),
  chain_network TEXT NOT NULL,
  chain_anchor_height BIGINT NOT NULL CHECK (chain_anchor_height > 0),
  chain_anchor_block_hash TEXT NOT NULL CHECK (chain_anchor_block_hash ~ '^[0-9a-f]{64}$'),
  chain_anchor_median_time BIGINT NOT NULL CHECK (chain_anchor_median_time > 0),
  expiry_height BIGINT NOT NULL CHECK (expiry_height > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  provider_evidence_ref TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL CHECK (observation_sha256 ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT NOT NULL CHECK (provider_identity_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  observation JSONB NOT NULL,
  raw_response_bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_evidence_snapshots_attempt_fk
    FOREIGN KEY (completion_attempt_id)
    REFERENCES namespace_ownership_completion_attempts (completion_attempt_id),
  CONSTRAINT namespace_ownership_evidence_snapshots_session_actor_fk
    FOREIGN KEY (namespace_session_id, actor_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_evidence_snapshots_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND octet_length(provider_configuration_ref) <= 512
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
    AND btrim(chain_network) <> ''
    AND chain_network = btrim(chain_network)
    AND btrim(provider_evidence_ref) <> ''
    AND provider_evidence_ref = btrim(provider_evidence_ref)
    AND octet_length(provider_evidence_ref) <= 512
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
    AND href = '/c/' || path_segment
    AND app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_upstream_ref_shape CHECK (
    octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_challenge_shape CHECK (
    btrim(challenge_name) <> ''
    AND challenge_name = btrim(challenge_name)
    AND octet_length(challenge_name) <= 255
    AND challenge_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_observation_shape CHECK (
    jsonb_typeof(observation) = 'object'
    AND observation ->> 'status' = 'verified'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_raw_bytes_shape CHECK (
    octet_length(raw_response_bytes) BETWEEN 1 AND 1048576
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_time_order CHECK (
    expires_at > observed_at
    AND created_at >= observed_at
  )
);

CREATE OR REPLACE FUNCTION validate_namespace_ownership_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
BEGIN
  -- Lock order: actor -> intent -> requirement state -> start reservation -> session.
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR UPDATE;
  SELECT * INTO ceremony_record
    FROM community_creation_ceremony_attempts
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = NEW.requirement_kind
     AND generation = NEW.generation
     AND ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;
  SELECT * INTO reservation_record
    FROM namespace_ownership_start_reservations
   WHERE reservation_id = NEW.start_reservation_id
     AND fence_token = NEW.start_fence_token
   FOR SHARE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR ceremony_record.ceremony_intent_id IS NULL
    OR state_record.status <> 'pending'
    OR intent_record.revision <> NEW.expected_revision
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
    OR state_record.provider_id <> NEW.provider_id
    OR state_record.provider_binding_hash <> NEW.provider_binding_hash
    OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR state_record.provider_configuration_version <> NEW.provider_configuration_version
    OR NEW.status <> 'pending'
    OR NEW.expires_at <= clock_timestamp()
    OR ceremony_record.provider_id <> NEW.provider_id
    OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
    OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
    OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
    OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
    OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
    OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
    OR (
      reservation_record.reservation_id IS NOT NULL
      AND (
        reservation_record.namespace_session_id <> NEW.namespace_session_id
        OR reservation_record.actor_id <> NEW.actor_id
        OR reservation_record.creation_intent_id <> NEW.creation_intent_id
        OR reservation_record.ceremony_intent_id <> NEW.ceremony_intent_id
        OR reservation_record.requirement_kind <> NEW.requirement_kind
        OR reservation_record.generation <> NEW.generation
        OR reservation_record.expected_revision <> NEW.expected_revision
        OR reservation_record.requirement_hash <> NEW.requirement_hash
        OR reservation_record.request_hash <> NEW.request_hash
        OR reservation_record.provider_id <> NEW.provider_id
        OR reservation_record.provider_binding_hash <> NEW.provider_binding_hash
        OR reservation_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR reservation_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR reservation_record.provider_configuration_version <> NEW.provider_configuration_version
        OR reservation_record.protocol_version <> NEW.protocol_version
        OR reservation_record.environment <> NEW.environment
        OR reservation_record.route_family <> NEW.route_family
        OR reservation_record.route_root_label <> NEW.route_root_label
        OR reservation_record.route_root_label_display <> NEW.route_root_label_display
        OR reservation_record.route_path_segment <> NEW.route_path_segment
        OR reservation_record.route_href <> NEW.route_href
        OR reservation_record.route_app_host IS DISTINCT FROM NEW.route_app_host
        OR reservation_record.state NOT IN ('acquired', 'finalized')
        OR reservation_record.lease_expires_at > NEW.expires_at
      )
    ) THEN
    RAISE EXCEPTION 'namespace ownership session does not match its creation ceremony';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_session_insert_guard
BEFORE INSERT ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_session_insert();

CREATE OR REPLACE FUNCTION guard_namespace_ownership_session_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership sessions are append-only';
  END IF;

  IF ROW(
    NEW.namespace_session_id, NEW.actor_id, NEW.creation_intent_id,
    NEW.ceremony_intent_id, NEW.start_reservation_id, NEW.start_fence_token,
    NEW.expected_revision, NEW.requirement_kind, NEW.generation,
    NEW.requirement_hash, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.upstream_session_ref,
    NEW.presentation_kind, NEW.presentation_payload, NEW.started_at, NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.namespace_session_id, OLD.actor_id, OLD.creation_intent_id,
    OLD.ceremony_intent_id, OLD.start_reservation_id, OLD.start_fence_token,
    OLD.expected_revision, OLD.requirement_kind, OLD.generation,
    OLD.requirement_hash, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.upstream_session_ref,
    OLD.presentation_kind, OLD.presentation_payload, OLD.started_at, OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership session identity and launch fields are immutable';
  END IF;

  IF NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.generation = OLD.generation
  ) THEN
    RAISE EXCEPTION 'namespace ownership session transition is not allowed: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_session_update_guard
BEFORE UPDATE ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE TRIGGER namespace_ownership_session_delete_guard
BEFORE DELETE ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_start_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_start_reservations' THEN
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = NEW.reservation_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = reservation_record.namespace_session_id
       AND actor_id = reservation_record.actor_id;
    IF session_record.namespace_session_id IS NULL THEN
      IF reservation_record.state IN ('acquired', 'released') THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'finalized namespace ownership start requires its session';
    END IF;
  ELSE
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = session_record.start_reservation_id
       AND fence_token = session_record.start_fence_token;
  END IF;

  IF reservation_record.reservation_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR reservation_record.state <> 'finalized'
    OR reservation_record.namespace_session_id <> session_record.namespace_session_id
    OR reservation_record.actor_id <> session_record.actor_id
    OR reservation_record.creation_intent_id <> session_record.creation_intent_id
    OR reservation_record.ceremony_intent_id <> session_record.ceremony_intent_id
    OR reservation_record.requirement_kind <> session_record.requirement_kind
    OR reservation_record.generation <> session_record.generation
    OR reservation_record.expected_revision <> session_record.expected_revision
    OR reservation_record.requirement_hash <> session_record.requirement_hash
    OR reservation_record.request_hash <> session_record.request_hash
    OR reservation_record.provider_id <> session_record.provider_id
    OR reservation_record.provider_binding_hash <> session_record.provider_binding_hash
    OR reservation_record.provider_configuration_kind <> session_record.provider_configuration_kind
    OR reservation_record.provider_configuration_ref <> session_record.provider_configuration_ref
    OR reservation_record.provider_configuration_version <> session_record.provider_configuration_version
    OR reservation_record.protocol_version <> session_record.protocol_version
    OR reservation_record.environment <> session_record.environment
    OR reservation_record.route_family <> session_record.route_family
    OR reservation_record.route_root_label <> session_record.route_root_label
    OR reservation_record.route_root_label_display <> session_record.route_root_label_display
    OR reservation_record.route_path_segment <> session_record.route_path_segment
    OR reservation_record.route_href <> session_record.route_href
    OR reservation_record.route_app_host IS DISTINCT FROM session_record.route_app_host
    OR reservation_record.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start reservation/session coherence is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_start_reservation_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_start_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_start_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE OR REPLACE FUNCTION guard_namespace_ownership_completion_attempt_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  transition_at TIMESTAMPTZ;
BEGIN
  transition_at := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership completion attempts are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := transition_at;
    NEW.updated_at := transition_at;
    -- Lock order: actor -> intent -> requirement state -> session -> attempt.
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT ci.* INTO intent_record
      FROM community_creation_intents AS ci
     WHERE ci.actor_id = NEW.actor_id
       AND ci.intent_id = (
         SELECT ns0.creation_intent_id
           FROM namespace_ownership_sessions AS ns0
          WHERE ns0.namespace_session_id = NEW.namespace_session_id
            AND ns0.actor_id = NEW.actor_id
       )
     FOR SHARE;
    SELECT crs.* INTO state_record
      FROM community_creation_requirement_states AS crs
     WHERE crs.actor_id = NEW.actor_id
       AND crs.intent_id = intent_record.intent_id
       AND crs.requirement_kind = 'namespace_ownership'
     FOR SHARE;
    SELECT ns.* INTO session_record
      FROM namespace_ownership_sessions AS ns
     WHERE ns.namespace_session_id = NEW.namespace_session_id
       AND ns.actor_id = NEW.actor_id
     FOR UPDATE;
    IF session_record.namespace_session_id IS NULL
      OR intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR session_record.status <> 'pending'
      OR session_record.expires_at <= transition_at
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'namespace ownership completion attempt requires a live pending session';
    END IF;
    IF NEW.lease_expires_at > session_record.expires_at THEN
      RAISE EXCEPTION 'completion lease exceeds its namespace session expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.completion_attempt_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.idempotency_key, NEW.completion_request_hash, NEW.evidence_ref,
    NEW.submission_channel,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.completion_attempt_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.idempotency_key, OLD.completion_request_hash, OLD.evidence_ref,
    OLD.submission_channel,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership completion attempt identity is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  -- The UPDATE statement already holds the attempt row lock. Read the parent
  -- without taking a second lock; repositories pre-lock the session before
  -- updating an attempt, and the deferred coherence trigger below validates
  -- the pair at commit.
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  IF session_record.namespace_session_id IS NULL
    OR session_record.status <> 'pending'
    OR session_record.expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'completion attempt requires a live pending session';
  END IF;

  IF OLD.state = 'leased' AND NEW.state IN ('released', 'consumed')
    AND NEW.fence_token = OLD.fence_token
    AND OLD.lease_expires_at > clock_timestamp()
    AND NEW.lease_expires_at = OLD.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'released' AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > clock_timestamp()
    AND NEW.lease_expires_at <= session_record.expires_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'namespace ownership completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER namespace_ownership_completion_attempt_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON namespace_ownership_completion_attempts
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_completion_attempt_change();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_attempt_session_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  leased_attempt_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_completion_attempts' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id;

    IF session_record.namespace_session_id IS NULL THEN
      RAISE EXCEPTION 'namespace ownership completion attempt has no session';
    END IF;

    IF NEW.state = 'leased'
      AND (
        session_record.status <> 'pending'
        OR session_record.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'leased namespace ownership attempt requires a live pending session';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  SELECT EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
       AND state = 'leased'
  ) INTO leased_attempt_exists;

  IF session_record.namespace_session_id IS NULL THEN
    RAISE EXCEPTION 'namespace ownership session has no completion attempt parent';
  END IF;

  IF session_record.status <> 'pending' AND leased_attempt_exists THEN
    RAISE EXCEPTION 'terminal namespace ownership session cannot retain a leased attempt';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_attempt_session_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_attempt_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  -- Lock order: actor -> intent -> requirement state -> session -> attempt.
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR session_record.expires_at <= clock_timestamp()
    OR attempt_record.state NOT IN ('leased', 'consumed')
    OR attempt_record.lease_expires_at <= clock_timestamp()
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its live session fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NEW.challenge_name <> '_pirate.' || NEW.root_label THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_evidence_snapshot_insert_guard
BEFORE INSERT ON namespace_ownership_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_evidence_snapshot_insert();

CREATE OR REPLACE FUNCTION reject_namespace_ownership_evidence_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'namespace ownership evidence snapshots are append-only';
END;
$$;

CREATE TRIGGER namespace_ownership_evidence_snapshot_append_only
BEFORE UPDATE OR DELETE ON namespace_ownership_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_namespace_ownership_evidence_snapshot_change();

ALTER TABLE community_creation_ceremony_results
  ADD COLUMN namespace_session_id TEXT,
  ADD COLUMN completion_attempt_id TEXT,
  ADD COLUMN submission_channel TEXT,
  ADD CONSTRAINT community_creation_ceremony_results_namespace_session_fk
    FOREIGN KEY (namespace_session_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_fk
    FOREIGN KEY (completion_attempt_id)
    REFERENCES namespace_ownership_completion_attempts (completion_attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_unique
    UNIQUE (completion_attempt_id),
  ADD CONSTRAINT community_creation_ceremony_results_submission_channel_check
    CHECK (submission_channel IS NULL OR submission_channel = 'poll_result');

ALTER TABLE community_creation_ceremony_results
  DROP CONSTRAINT community_creation_ceremony_results_outcome_shape;

ALTER TABLE community_creation_ceremony_results
  ADD CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND proof_session_id IS NOT NULL
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND proof_session_id IS NULL
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND evidence_receipt_id IS NULL
        )
      )
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.completion_attempt_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion attempt';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = NEW.completion_attempt_id
     FOR SHARE;
    IF session_record.namespace_session_id IS NULL
      OR completion_record.completion_attempt_id IS NULL
      OR completion_record.namespace_session_id <> session_record.namespace_session_id
      OR completion_record.actor_id <> NEW.actor_id
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR completion_record.submission_channel <> 'poll_result'
      OR NEW.callback_idempotency_key <> completion_record.idempotency_key
      OR NEW.callback_request_hash <> completion_record.completion_request_hash
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_terminal_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_sessions' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO result_record
     FROM community_creation_ceremony_results
     WHERE namespace_session_id = session_record.namespace_session_id;
  ELSE
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.ceremony_intent_id;
    IF result_record.namespace_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = result_record.namespace_session_id;
  END IF;

  IF session_record.status = 'pending' THEN
    IF result_record.ceremony_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'pending namespace ownership session cannot have a ceremony result';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.namespace_session_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id <> session_record.namespace_session_id
    OR (
      session_record.status = 'completed'
      AND result_record.outcome_status <> 'satisfied'
    )
    OR (
      session_record.status IN ('failed', 'expired')
      AND result_record.outcome_status <> session_record.status
    )
  THEN
    RAISE EXCEPTION 'terminal namespace ownership session/result correlation is incomplete';
  END IF;

  IF session_record.status = 'completed' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM community_creation_ceremony_results AS result
        JOIN namespace_ownership_evidence_snapshots AS snapshot
          ON snapshot.evidence_ref = result.evidence_ref
         AND snapshot.namespace_session_id = result.namespace_session_id
         AND snapshot.completion_attempt_id = result.completion_attempt_id
         AND snapshot.evidence_digest = result.evidence_digest
         AND snapshot.provider_identity_digest = result.provider_identity_digest
         AND snapshot.observed_at <= clock_timestamp()
         AND snapshot.expires_at > clock_timestamp()
       WHERE result.namespace_session_id = session_record.namespace_session_id
         AND result.outcome_status = 'satisfied'
    ) THEN
      RAISE EXCEPTION 'completed namespace ownership session requires its evidence snapshot';
    END IF;
  ELSE
    IF result_record.evidence_ref IS NOT NULL
      OR result_record.evidence_digest IS NOT NULL
      OR result_record.provider_identity_digest IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM namespace_ownership_evidence_snapshots
         WHERE namespace_session_id = session_record.namespace_session_id
      )
    THEN
      RAISE EXCEPTION 'failed or expired namespace ownership has no evidence snapshot';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_session_terminal_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_result_terminal_coherence
AFTER INSERT ON community_creation_ceremony_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
  state_found BOOLEAN;
  result_found BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN RETURN NULL; END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;
  state_found := FOUND;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;
  result_found := FOUND;

  IF NOT result_found THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
    END IF;

    IF state_found
      AND state_record.status IN ('satisfied', 'failed', 'expired') THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;

    RETURN NULL;
  END IF;

  IF state_record.status IN ('satisfied', 'failed', 'expired') THEN
    IF result_record.ceremony_intent_id IS NULL
      OR result_record.outcome_status <> state_record.status
      OR result_record.actor_id <> state_record.actor_id
      OR result_record.intent_id <> state_record.intent_id
      OR result_record.requirement_kind <> state_record.requirement_kind
      OR result_record.generation <> state_record.generation
      OR result_record.requirement_hash <> state_record.requirement_hash
      OR result_record.provider_id <> state_record.provider_id
      OR result_record.provider_binding_hash <> state_record.provider_binding_hash
      OR result_record.provider_configuration_version <> state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at
    THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = attempt_record.intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;

  IF attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR attempt_record.requirement_kind <> 'namespace_ownership'
    OR result_record.outcome_status <> 'satisfied'
    OR state_record.status <> 'satisfied'
    OR state_record.generation <> attempt_record.generation
    OR state_record.current_ceremony_intent_id <> NEW.creation_ceremony_intent_id
    OR NEW.verified_by_actor_id <> attempt_record.actor_id
    OR NEW.family <> attempt_record.route_family
    OR NEW.root_label <> attempt_record.route_root_label
    OR NEW.root_label_display <> attempt_record.route_root_label_display
    OR NEW.path_segment <> attempt_record.route_path_segment
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
    OR NEW.provider_identity_digest <> result_record.provider_identity_digest
    OR NEW.evidence_ref <> result_record.evidence_ref
    OR NEW.evidence_digest <> result_record.evidence_digest
    OR NEW.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
    OR NEW.verified_at <> result_record.satisfied_at
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  IF result_record.namespace_session_id IS NOT NULL THEN
    SELECT * INTO snapshot_record
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = NEW.evidence_ref
       AND namespace_session_id = result_record.namespace_session_id
       AND completion_attempt_id = result_record.completion_attempt_id;
    IF snapshot_record.evidence_ref IS NULL
      OR snapshot_record.evidence_digest <> NEW.evidence_digest
      OR snapshot_record.provider_identity_digest <> NEW.provider_identity_digest
    THEN
      RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Complete the namespace poll lease/expiry contract without rewriting 0029.
-- An expiry observed before reservation has no completion attempt, while an
-- expiry after reservation consumes that exact fence. Expired leases may be
-- released or reacquired, but a repository still decides whether late
-- provider output is eligible to consume a live attempt.

ALTER TABLE community_creation_ceremony_results
  DROP CONSTRAINT community_creation_ceremony_results_outcome_shape;

ALTER TABLE community_creation_ceremony_results
  ADD CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND proof_session_id IS NOT NULL
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND proof_session_id IS NULL
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND evidence_receipt_id IS NULL
        )
      )
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND namespace_session_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND (
            completion_attempt_id IS NOT NULL
            OR outcome_status = 'expired'
          )
        )
      )
    )
  );

ALTER TABLE namespace_ownership_completion_attempts
  ADD COLUMN consumption_kind TEXT;

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'verified'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'satisfied'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
        AND result.evidence_ref = attempt.evidence_ref
   )
   AND EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
        AND snapshot.evidence_ref = attempt.evidence_ref
   );

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'rejected'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'failed'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
   )
   AND NOT EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
   );

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'expired'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'expired'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
   )
   AND NOT EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
   );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE state = 'consumed' AND consumption_kind IS NULL
  ) THEN
    RAISE EXCEPTION 'existing consumed namespace attempts have ambiguous authority';
  END IF;
END;
$$;

ALTER TABLE namespace_ownership_completion_attempts
  ADD CONSTRAINT namespace_ownership_completion_attempts_consumption_shape CHECK (
    (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND consumption_kind IN ('semantic_contradiction', 'verified', 'rejected', 'expired')
    )
    OR (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
    )
  );

CREATE OR REPLACE FUNCTION guard_namespace_ownership_completion_attempt_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  transition_at TIMESTAMPTZ;
BEGIN
  transition_at := clock_timestamp();

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership completion attempts are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := transition_at;
    NEW.updated_at := transition_at;
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT ci.* INTO intent_record
      FROM community_creation_intents AS ci
     WHERE ci.actor_id = NEW.actor_id
       AND ci.intent_id = (
         SELECT ns0.creation_intent_id
           FROM namespace_ownership_sessions AS ns0
          WHERE ns0.namespace_session_id = NEW.namespace_session_id
            AND ns0.actor_id = NEW.actor_id
       )
     FOR SHARE;
    SELECT crs.* INTO state_record
      FROM community_creation_requirement_states AS crs
     WHERE crs.actor_id = NEW.actor_id
       AND crs.intent_id = intent_record.intent_id
       AND crs.requirement_kind = 'namespace_ownership'
     FOR SHARE;
    SELECT ns.* INTO session_record
      FROM namespace_ownership_sessions AS ns
     WHERE ns.namespace_session_id = NEW.namespace_session_id
       AND ns.actor_id = NEW.actor_id
     FOR UPDATE;
    IF session_record.namespace_session_id IS NULL
      OR intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR session_record.status <> 'pending'
      OR session_record.expires_at <= transition_at
      OR NEW.state <> 'leased'
      OR NEW.consumption_kind IS NOT NULL
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= transition_at
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt requires a live pending session';
    END IF;
    IF NEW.lease_expires_at > session_record.expires_at THEN
      RAISE EXCEPTION 'completion lease exceeds its namespace session expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.completion_attempt_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.idempotency_key, NEW.completion_request_hash, NEW.evidence_ref,
    NEW.submission_channel, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.completion_attempt_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.idempotency_key, OLD.completion_request_hash, OLD.evidence_ref,
    OLD.submission_channel, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership completion attempt identity is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
    AND OLD.consumption_kind IS NOT DISTINCT FROM NEW.consumption_kind
    AND OLD.updated_at = NEW.updated_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  IF session_record.namespace_session_id IS NULL
    OR session_record.status NOT IN ('pending', 'expired')
  THEN
    RAISE EXCEPTION 'completion attempt requires its pending or expired session';
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND OLD.consumption_kind IS NULL
  THEN
    IF NEW.consumption_kind IN ('semantic_contradiction', 'verified', 'rejected') THEN
      IF session_record.status = 'pending'
        AND OLD.lease_expires_at > transition_at
        AND session_record.expires_at > transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.consumption_kind = 'expired' THEN
      IF session_record.status IN ('pending', 'expired')
        AND session_record.expires_at <= transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
  END IF;

  IF OLD.state IN ('released', 'leased')
    AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at <= session_record.expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
      AND NEW.lease_expires_at > transition_at
      AND (
        OLD.state = 'released'
        OR OLD.lease_expires_at <= transition_at
      )
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'namespace ownership completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_attempt_session_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  leased_attempt_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_completion_attempts' THEN
    SELECT * INTO attempt_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = NEW.completion_attempt_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id;

    IF session_record.namespace_session_id IS NULL
      OR attempt_record.completion_attempt_id IS NULL
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt has no session';
    END IF;

    IF attempt_record.state = 'leased'
      AND (
        session_record.status <> 'pending'
        OR session_record.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'leased namespace ownership attempt requires a live pending session';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  SELECT EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
       AND state = 'leased'
  ) INTO leased_attempt_exists;

  IF session_record.namespace_session_id IS NULL THEN
    RAISE EXCEPTION 'namespace ownership session has no completion attempt parent';
  END IF;

  IF session_record.status <> 'pending' AND leased_attempt_exists THEN
    RAISE EXCEPTION 'terminal namespace ownership session cannot retain a leased attempt';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind IS DISTINCT FROM 'verified'
    OR attempt_record.lease_expires_at <= attempt_record.updated_at
    OR session_record.expires_at <= attempt_record.updated_at
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its consumed verified fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NEW.challenge_name <> '_pirate.' || NEW.root_label THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;
 
CREATE OR REPLACE FUNCTION validate_namespace_ownership_consumed_attempt_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  result_record community_creation_ceremony_results%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  IF NEW.state <> 'consumed' THEN RETURN NULL; END IF;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE completion_attempt_id = NEW.completion_attempt_id;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE completion_attempt_id = NEW.completion_attempt_id;

  IF NEW.consumption_kind = 'semantic_contradiction' THEN
    IF result_record.ceremony_intent_id IS NOT NULL
      OR snapshot_record.evidence_ref IS NOT NULL
    THEN
      RAISE EXCEPTION 'semantic contradiction cannot carry terminal namespace authority';
    END IF;
    RETURN NULL;
  END IF;

  IF result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id <> NEW.namespace_session_id
    OR result_record.callback_idempotency_key <> NEW.idempotency_key
    OR result_record.callback_request_hash <> NEW.completion_request_hash
    OR (
      NEW.consumption_kind = 'verified'
      AND (
        result_record.outcome_status <> 'satisfied'
        OR snapshot_record.evidence_ref IS NULL
        OR snapshot_record.evidence_ref <> NEW.evidence_ref
        OR snapshot_record.namespace_session_id <> NEW.namespace_session_id
      )
    )
    OR (
      NEW.consumption_kind = 'rejected'
      AND (
        result_record.outcome_status <> 'failed'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
    OR (
      NEW.consumption_kind = 'expired'
      AND (
        result_record.outcome_status <> 'expired'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'consumed namespace attempt lacks its matching terminal authority';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_consumed_attempt_coherence
AFTER UPDATE OF state, consumption_kind ON namespace_ownership_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_consumed_attempt_coherence();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
  THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
      OR (NEW.outcome_status <> 'expired' AND NEW.completion_attempt_id IS NULL)
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion authority';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NEW.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO completion_record
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = NEW.completion_attempt_id
       FOR SHARE;
    END IF;
    IF session_record.namespace_session_id IS NULL
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR (
        NEW.completion_attempt_id IS NOT NULL
        AND (
          completion_record.completion_attempt_id IS NULL
          OR completion_record.namespace_session_id <> session_record.namespace_session_id
          OR completion_record.actor_id <> NEW.actor_id
          OR completion_record.submission_channel <> 'poll_result'
          OR completion_record.state <> 'consumed'
          OR completion_record.consumption_kind IS DISTINCT FROM CASE NEW.outcome_status
            WHEN 'satisfied' THEN 'verified'
            WHEN 'failed' THEN 'rejected'
            WHEN 'expired' THEN 'expired'
            ELSE NULL
          END
          OR NEW.callback_idempotency_key <> completion_record.idempotency_key
          OR NEW.callback_request_hash <> completion_record.completion_request_hash
        )
      )
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL
  THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version
    THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest
    THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Mark the community-creation runtime clean break and make the two requirement
-- rows structural for route-v1 intents. Legacy slug intents remain retained as
-- audit evidence but are not readable or replayable through the route-v1 API.

ALTER TABLE community_creation_intents
  ADD COLUMN creation_contract_version TEXT NOT NULL DEFAULT 'legacy_slug_v1'
    CHECK (creation_contract_version IN ('legacy_slug_v1', 'route_v1')),
  ADD CONSTRAINT community_creation_intents_route_v1_draft_shape CHECK (
    creation_contract_version <> 'route_v1'
    OR (
      NOT (draft ? 'slug')
      AND jsonb_typeof(draft -> 'route_request') = 'object'
      AND (draft -> 'route_request') ? 'family'
      AND (draft -> 'route_request') ? 'root_label'
      AND ((draft -> 'route_request') - 'family' - 'root_label') = '{}'::jsonb
      AND draft -> 'route_request' ->> 'family' IN ('hns', 'spaces')
      AND is_community_route_root_label(
        draft -> 'route_request' ->> 'family',
        draft -> 'route_request' ->> 'root_label'
      ) IS TRUE
    )
  ),
  ADD CONSTRAINT community_creation_intents_route_v1_committed_href CHECK (
    creation_contract_version <> 'route_v1'
    OR status <> 'committed'
    OR committed_resource_href LIKE '/c/%'
  );

COMMENT ON COLUMN community_creation_intents.creation_contract_version IS
  'Runtime contract fence. route_v1 is the only version exposed after the canonical-route cutover.';

CREATE OR REPLACE FUNCTION guard_community_creation_contract_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.creation_contract_version <> OLD.creation_contract_version THEN
    RAISE EXCEPTION 'community creation contract version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_contract_version_guard
BEFORE UPDATE OF creation_contract_version ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_contract_version();

CREATE OR REPLACE FUNCTION validate_route_v1_creation_requirement_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_intent_id TEXT;
  contract_version TEXT;
  human_count BIGINT;
  namespace_count BIGINT;
BEGIN
  checked_intent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.intent_id ELSE NEW.intent_id END;

  SELECT creation_contract_version INTO contract_version
    FROM community_creation_intents
   WHERE intent_id = checked_intent_id;

  IF NOT FOUND OR contract_version <> 'route_v1' THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE requirement_kind = 'human_identity'),
    COUNT(*) FILTER (WHERE requirement_kind = 'namespace_ownership')
    INTO human_count, namespace_count
    FROM community_creation_requirement_states
   WHERE intent_id = checked_intent_id;

  IF human_count <> 1 OR namespace_count <> 1 THEN
    RAISE EXCEPTION 'route-v1 community creation requires exactly two requirement rows';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER route_v1_creation_intent_requirement_cardinality
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();

CREATE CONSTRAINT TRIGGER route_v1_creation_requirement_cardinality
AFTER INSERT OR UPDATE OR DELETE ON community_creation_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();


CREATE OR REPLACE FUNCTION validate_route_v1_committed_community()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  expected_family TEXT;
  expected_root TEXT;
  guard_at TIMESTAMPTZ;
  human_evidence_valid BOOLEAN;
BEGIN
  IF NEW.creation_contract_version <> 'route_v1'
    OR NEW.status <> 'committed' THEN
    RETURN NULL;
  END IF;

  expected_family := NEW.draft -> 'route_request' ->> 'family';
  expected_root := NEW.draft -> 'route_request' ->> 'root_label';

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.committed_community_id;
  IF NOT FOUND
    OR community_record.status <> 'active'
    OR community_record.canonical_route_binding_id IS NULL THEN
    RAISE EXCEPTION 'route-v1 committed intent requires an active canonical community binding';
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = community_record.canonical_route_binding_id
     AND community_id = community_record.community_id;
  IF NOT FOUND
    OR binding_record.family IS DISTINCT FROM expected_family
    OR binding_record.root_label IS DISTINCT FROM expected_root
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR binding_record.verified_evidence_ref IS NULL
    OR NEW.committed_resource_href IS DISTINCT FROM binding_record.href THEN
    RAISE EXCEPTION 'route-v1 committed intent does not match its verified canonical route';
  END IF;

  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  guard_at := clock_timestamp();
  IF evidence_record.evidence_ref IS NULL
    OR snapshot_record.evidence_ref IS NULL
    OR evidence_record.family IS DISTINCT FROM binding_record.family
    OR evidence_record.root_label IS DISTINCT FROM binding_record.root_label
    OR evidence_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR evidence_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.family IS DISTINCT FROM binding_record.family
    OR snapshot_record.root_label IS DISTINCT FROM binding_record.root_label
    OR snapshot_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR snapshot_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.href IS DISTINCT FROM binding_record.href
    OR snapshot_record.expires_at <= guard_at
    OR (evidence_record.expires_at IS NOT NULL AND evidence_record.expires_at <= guard_at)
  THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live canonical route evidence';
  END IF;

  SELECT (
    COUNT(DISTINCT claim.claim_id) = 1
    AND COUNT(DISTINCT receipt.evidence_receipt_id) = 1
    AND COUNT(DISTINCT assertion.assertion_id) = 2
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'human.personhood'
        AND assertion.assertion_value = '{"personhood": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'credential.subject_unique'
        AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND BOOL_AND(
      claim.community_id = NEW.committed_community_id
      AND claim.verification_requirement_hash = NEW.verification_requirement_hash
      AND receipt.proof_session_id = claim.proof_session_id
      AND receipt.evidence_receipt_id = claim.evidence_receipt_id
      AND receipt.user_id = NEW.actor_id
      AND receipt.subject_key_id = claim.subject_key_id
      AND receipt.evidence_kind = 'very.oauth.id-token-userinfo.v1'
      AND (receipt.expires_at IS NULL OR receipt.expires_at > guard_at)
      AND assertion.user_id = NEW.actor_id
      AND assertion.subject_key_id = claim.subject_key_id
      AND assertion.evidence_receipt_id = claim.evidence_receipt_id
      AND (assertion.expires_at IS NULL OR assertion.expires_at > guard_at)
      AND assertion_binding.user_id = NEW.actor_id
      AND assertion_binding.binding_mode = 'same_subject'
      AND assertion_binding.subject_key_id = claim.subject_key_id
      AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
      AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
      AND active_binding.user_id = NEW.actor_id
      AND active_binding.subject_key_id = claim.subject_key_id
      AND active_binding.binding_event_id = receipt.subject_binding_event_id
      AND active_binding.binding_epoch = receipt.subject_binding_epoch
    )
  ) INTO human_evidence_valid
    FROM community_creation_subject_claims AS claim
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertions AS assertion
      ON assertion.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertion_bindings AS assertion_binding
      ON assertion_binding.binding_group_id = assertion.binding_group_id
    JOIN active_subject_key_bindings AS active_binding
      ON active_binding.subject_key_id = claim.subject_key_id
   WHERE claim.intent_id = NEW.intent_id
     AND claim.actor_id = NEW.actor_id;
  IF human_evidence_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live human creation evidence';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_creation_route_v1_commit_guard
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_committed_community();

-- The namespace terminal is one authority chain.  Every deferred check below
-- compares the immutable ceremony attempt, session, completion attempt,
-- snapshot, result, and route evidence against one wall-clock observation and
-- the same evidence fence.

CREATE OR REPLACE FUNCTION validate_namespace_ownership_terminal_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  route_record community_route_ownership_evidence%ROWTYPE;
  coherence_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_sessions' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE namespace_session_id = session_record.namespace_session_id;
  ELSE
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.ceremony_intent_id;
    IF result_record.namespace_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = result_record.namespace_session_id;
  END IF;

  IF session_record.status = 'pending' THEN
    IF result_record.ceremony_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'pending namespace ownership session cannot have a ceremony result';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.namespace_session_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
    OR (
      session_record.status = 'completed'
      AND result_record.outcome_status IS DISTINCT FROM 'satisfied'
    )
    OR (
      session_record.status IN ('failed', 'expired')
      AND result_record.outcome_status IS DISTINCT FROM session_record.status
    )
  THEN
    RAISE EXCEPTION 'terminal namespace ownership session/result correlation is incomplete';
  END IF;

  IF session_record.status = 'completed' THEN
    SELECT * INTO attempt_record
      FROM community_creation_ceremony_attempts
     WHERE ceremony_intent_id = result_record.ceremony_intent_id;
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO snapshot_record
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = result_record.evidence_ref
       AND namespace_session_id = result_record.namespace_session_id
       AND completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO route_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = result_record.evidence_ref;

    IF attempt_record.ceremony_intent_id IS NULL
      OR completion_record.completion_attempt_id IS NULL
      OR snapshot_record.evidence_ref IS NULL
      OR route_record.evidence_ref IS NULL
      OR result_record.completion_attempt_id IS NULL
      OR result_record.evidence_ref IS NULL
      OR result_record.evidence_digest IS NULL
      OR result_record.provider_identity_digest IS NULL
      OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR result_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR result_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR result_record.generation IS DISTINCT FROM session_record.generation
      OR result_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR result_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR result_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR result_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR attempt_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR attempt_record.requirement_kind IS DISTINCT FROM session_record.requirement_kind
      OR attempt_record.generation IS DISTINCT FROM session_record.generation
      OR attempt_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR attempt_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR attempt_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR attempt_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR attempt_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR attempt_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.route_family IS DISTINCT FROM session_record.route_family
      OR attempt_record.route_root_label IS DISTINCT FROM session_record.route_root_label
      OR attempt_record.route_root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR attempt_record.route_path_segment IS DISTINCT FROM session_record.route_path_segment
      OR completion_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR completion_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR completion_record.state IS DISTINCT FROM 'consumed'
      OR completion_record.consumption_kind IS DISTINCT FROM 'verified'
      OR completion_record.evidence_ref IS DISTINCT FROM result_record.evidence_ref
      OR completion_record.fence_token IS DISTINCT FROM snapshot_record.fence_token
      OR snapshot_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR snapshot_record.creation_intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR snapshot_record.ceremony_intent_id IS DISTINCT FROM session_record.ceremony_intent_id
      OR snapshot_record.generation IS DISTINCT FROM session_record.generation
      OR snapshot_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR snapshot_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR snapshot_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR snapshot_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR snapshot_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR snapshot_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR snapshot_record.protocol_version IS DISTINCT FROM session_record.protocol_version
      OR snapshot_record.environment IS DISTINCT FROM session_record.environment
      OR snapshot_record.family IS DISTINCT FROM session_record.route_family
      OR snapshot_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR snapshot_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR snapshot_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR snapshot_record.href IS DISTINCT FROM session_record.route_href
      OR snapshot_record.upstream_session_ref IS DISTINCT FROM session_record.upstream_session_ref
      OR snapshot_record.fence_token IS DISTINCT FROM completion_record.fence_token
      OR snapshot_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR snapshot_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR snapshot_record.observed_at > coherence_at
      OR snapshot_record.expires_at <= coherence_at
      OR route_record.creation_ceremony_intent_id IS DISTINCT FROM result_record.ceremony_intent_id
      OR route_record.verified_by_actor_id IS DISTINCT FROM session_record.actor_id
      OR route_record.family IS DISTINCT FROM session_record.route_family
      OR route_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR route_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR route_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR route_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR route_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR route_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR route_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR route_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR route_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR route_record.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
      OR route_record.binding_generation IS DISTINCT FROM session_record.generation
      OR route_record.verified_at IS DISTINCT FROM result_record.satisfied_at
      OR (
        route_record.expires_at IS NOT NULL
        AND route_record.expires_at IS DISTINCT FROM snapshot_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership terminal evidence chain is incoherent';
    END IF;
  ELSE
    IF result_record.evidence_ref IS NOT NULL
      OR result_record.evidence_digest IS NOT NULL
      OR result_record.provider_identity_digest IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM namespace_ownership_evidence_snapshots
         WHERE namespace_session_id = session_record.namespace_session_id
      )
      OR EXISTS (
        SELECT 1 FROM community_route_ownership_evidence
         WHERE creation_ceremony_intent_id = result_record.ceremony_intent_id
      )
    THEN
      RAISE EXCEPTION 'failed or expired namespace ownership has no evidence snapshot';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = attempt_record.intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;
  IF result_record.completion_attempt_id IS NOT NULL THEN
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = result_record.completion_attempt_id;
  END IF;

  IF attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR attempt_record.requirement_kind <> 'namespace_ownership'
    OR result_record.outcome_status <> 'satisfied'
    OR state_record.status <> 'satisfied'
    OR state_record.generation IS DISTINCT FROM attempt_record.generation
    OR state_record.current_ceremony_intent_id IS DISTINCT FROM NEW.creation_ceremony_intent_id
    OR NEW.verified_by_actor_id IS DISTINCT FROM attempt_record.actor_id
    OR NEW.family IS DISTINCT FROM attempt_record.route_family
    OR NEW.root_label IS DISTINCT FROM attempt_record.route_root_label
    OR NEW.root_label_display IS DISTINCT FROM attempt_record.route_root_label_display
    OR NEW.path_segment IS DISTINCT FROM attempt_record.route_path_segment
    OR NEW.requirement_hash IS DISTINCT FROM attempt_record.requirement_hash
    OR NEW.provider_id IS DISTINCT FROM attempt_record.provider_id
    OR NEW.provider_binding_hash IS DISTINCT FROM attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version IS DISTINCT FROM attempt_record.provider_configuration_version
    OR NEW.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
    OR NEW.evidence_ref IS DISTINCT FROM result_record.evidence_ref
    OR NEW.evidence_digest IS DISTINCT FROM result_record.evidence_digest
    OR NEW.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
    OR NEW.binding_generation IS DISTINCT FROM attempt_record.generation
    OR NEW.verified_at IS DISTINCT FROM result_record.satisfied_at
    OR completion_record.completion_attempt_id IS NULL
    OR completion_record.namespace_session_id IS DISTINCT FROM result_record.namespace_session_id
    OR completion_record.actor_id IS DISTINCT FROM result_record.actor_id
    OR completion_record.state IS DISTINCT FROM 'consumed'
    OR completion_record.consumption_kind IS DISTINCT FROM 'verified'
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
     AND namespace_session_id = result_record.namespace_session_id
     AND completion_attempt_id = result_record.completion_attempt_id;
  IF snapshot_record.evidence_ref IS NULL
    OR snapshot_record.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR snapshot_record.provider_identity_digest IS DISTINCT FROM NEW.provider_identity_digest
    OR snapshot_record.actor_id IS DISTINCT FROM result_record.actor_id
    OR snapshot_record.creation_intent_id IS DISTINCT FROM result_record.intent_id
    OR snapshot_record.ceremony_intent_id IS DISTINCT FROM result_record.ceremony_intent_id
    OR snapshot_record.generation IS DISTINCT FROM NEW.binding_generation
    OR snapshot_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR snapshot_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR snapshot_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR snapshot_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR snapshot_record.family IS DISTINCT FROM NEW.family
    OR snapshot_record.root_label IS DISTINCT FROM NEW.root_label
    OR snapshot_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR snapshot_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR (
      NEW.expires_at IS NOT NULL
      AND snapshot_record.expires_at IS DISTINCT FROM NEW.expires_at
    )
  THEN
    RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
  END IF;

  RETURN NEW;
END;
$$;
-- Structural route-v1 authority without inventing ownership for retained legacy rows.
-- Legacy slug communities remain readable compatibility data but never satisfy
-- the canonical-route resolver or new privileged-write predicate.

ALTER TABLE communities
  ADD COLUMN route_authority_version TEXT NOT NULL DEFAULT 'legacy_slug_v1'
    CHECK (route_authority_version IN ('legacy_slug_v1', 'route_v1')),
  ADD CONSTRAINT communities_route_v1_binding_presence CHECK (
    route_authority_version <> 'route_v1'
    OR status <> 'active'
    OR canonical_route_binding_id IS NOT NULL
  );

COMMENT ON COLUMN communities.route_authority_version IS
  'Compatibility fence. route_v1 communities require canonical route authority; legacy_slug_v1 rows are retained without gaining route authority.';

CREATE OR REPLACE FUNCTION guard_community_route_authority_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.route_authority_version IS DISTINCT FROM OLD.route_authority_version THEN
    RAISE EXCEPTION 'community route authority version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_route_authority_version_guard
BEFORE UPDATE OF route_authority_version ON communities
FOR EACH ROW EXECUTE FUNCTION guard_community_route_authority_version();

CREATE OR REPLACE FUNCTION validate_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  community_record communities%ROWTYPE;
  binding_id TEXT;
  guard_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
    binding_id := NEW.canonical_route_binding_id;
  ELSE
    binding_id := NEW.route_binding_id;
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
  END IF;

  IF community_record.community_id IS NULL THEN
    RAISE EXCEPTION 'community canonical route owner is missing';
  END IF;

  IF community_record.route_authority_version = 'route_v1'
    AND community_record.status = 'active'
    AND binding_id IS NULL THEN
    RAISE EXCEPTION 'active route-v1 community requires a canonical route binding';
  END IF;

  IF binding_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community canonical route binding is missing';
  END IF;

  IF community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR community_record.community_id IS DISTINCT FROM binding_record.community_id THEN
    RAISE EXCEPTION 'community canonical route reference is not reciprocal';
  END IF;

  IF binding_record.route_lifecycle_status = 'active' THEN
    SELECT * INTO evidence_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = binding_record.verified_evidence_ref;
    IF NOT FOUND
      OR binding_record.ownership_status <> 'verified'
      OR evidence_record.family <> binding_record.family
      OR evidence_record.root_label <> binding_record.root_label
      OR evidence_record.root_label_display <> binding_record.root_label_display
      OR evidence_record.path_segment <> binding_record.path_segment
      OR evidence_record.binding_generation <> binding_record.binding_generation
      OR (
        community_record.route_authority_version = 'route_v1'
        AND (
          evidence_record.verified_at > guard_at
          OR evidence_record.expires_at IS NULL
          OR evidence_record.expires_at <= guard_at
        )
      ) THEN
      RAISE EXCEPTION 'active community route lacks matching verified ownership evidence';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER communities_canonical_route_binding_guard ON communities;

CREATE CONSTRAINT TRIGGER communities_canonical_route_binding_guard
AFTER INSERT OR UPDATE OF status, canonical_route_binding_id, route_authority_version ON communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();
-- Allow both ratified HNS TXT challenge topologies at the persistence boundary.
--
-- The application and evidence ABI already distinguish parent-chain apex TXT
-- from owner-authoritative _pirate TXT. The previous trigger accidentally
-- accepted only the latter.

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind IS DISTINCT FROM 'verified'
    OR attempt_record.lease_expires_at <= attempt_record.updated_at
    OR session_record.expires_at <= attempt_record.updated_at
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its consumed verified fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NOT (
    (
      NEW.ownership_source = 'hns_parent_chain_txt'
      AND NEW.challenge_name = NEW.root_label
    )
    OR (
      NEW.ownership_source = 'owner_authoritative_dns_txt'
      AND NEW.challenge_name = '_pirate.' || NEW.root_label
    )
  ) THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;
