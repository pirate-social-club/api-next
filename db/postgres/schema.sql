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
-- Gates v2 evidence ledger, immutable policy artifacts, observations, and
-- action-grant consumption. Provider and claim identifiers intentionally stay
-- text-backed so adding an adapter does not require a schema migration.

CREATE TABLE proof_sessions (
  proof_session_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  method TEXT NOT NULL,
  issuer TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('issuer_rp_scope', 'issuer_rp_action_scope', 'none')
  ),
  issuer_rp_scope TEXT,
  issuer_rp_action_scope TEXT,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  upstream_session_ref TEXT,
  requested_claim_ids JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_sessions_actor_fk
    FOREIGN KEY (actor_id) REFERENCES users (user_id),
  CONSTRAINT proof_sessions_identifiers_not_blank CHECK (
    btrim(intent_id) <> '' AND btrim(request_hash) <> ''
    AND btrim(provider_id) <> '' AND btrim(method) <> '' AND btrim(issuer) <> ''
    AND btrim(protocol_version) <> '' AND btrim(environment) <> ''
  ),
  CONSTRAINT proof_sessions_requested_claims_check CHECK (
    jsonb_typeof(requested_claim_ids) = 'array'
    AND jsonb_array_length(requested_claim_ids) > 0
  ),
  CONSTRAINT proof_sessions_scope_shape_check CHECK (
    (scope_kind = 'issuer_rp_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NULL)
    OR (scope_kind = 'issuer_rp_action_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NOT NULL)
    OR (scope_kind = 'none'
      AND issuer_rp_scope IS NULL
      AND issuer_rp_action_scope IS NULL)
  ),
  CONSTRAINT proof_sessions_scope_values_not_blank CHECK (
    (issuer_rp_scope IS NULL OR btrim(issuer_rp_scope) <> '')
    AND (issuer_rp_action_scope IS NULL OR btrim(issuer_rp_action_scope) <> '')
  ),
  CONSTRAINT proof_sessions_id_actor_unique UNIQUE (proof_session_id, actor_id)
);

CREATE UNIQUE INDEX proof_sessions_provider_ref_uidx
  ON proof_sessions (provider_id, upstream_session_ref)
  WHERE upstream_session_ref IS NOT NULL;

CREATE INDEX proof_sessions_actor_status_idx
  ON proof_sessions (actor_id, status, created_at DESC);

CREATE TABLE evidence_receipts (
  evidence_receipt_id TEXT PRIMARY KEY,
  proof_session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  method TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('issuer_rp_scope', 'issuer_rp_action_scope', 'none')
  ),
  issuer_rp_scope TEXT,
  issuer_rp_action_scope TEXT,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  receipt_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  provenance_kind TEXT NOT NULL DEFAULT 'proof_session'
    CHECK (provenance_kind = 'proof_session'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_receipts_session_actor_fk
    FOREIGN KEY (proof_session_id, user_id)
    REFERENCES proof_sessions (proof_session_id, actor_id),
  CONSTRAINT evidence_receipts_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT evidence_receipts_identifiers_not_blank CHECK (
    btrim(provider_id) <> '' AND btrim(issuer) <> '' AND btrim(method) <> ''
    AND btrim(protocol_version) <> '' AND btrim(environment) <> ''
    AND btrim(evidence_kind) <> ''
  ),
  CONSTRAINT evidence_receipts_payload_object_check
    CHECK (jsonb_typeof(receipt_metadata) = 'object'),
  CONSTRAINT evidence_receipts_scope_shape_check CHECK (
    (scope_kind = 'issuer_rp_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NULL)
    OR (scope_kind = 'issuer_rp_action_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NOT NULL)
    OR (scope_kind = 'none'
      AND issuer_rp_scope IS NULL
      AND issuer_rp_action_scope IS NULL)
  ),
  CONSTRAINT evidence_receipts_scope_values_not_blank CHECK (
    (issuer_rp_scope IS NULL OR btrim(issuer_rp_scope) <> '')
    AND (issuer_rp_action_scope IS NULL OR btrim(issuer_rp_action_scope) <> '')
  ),
  CONSTRAINT evidence_receipts_id_user_unique UNIQUE (evidence_receipt_id, user_id)
);

CREATE UNIQUE INDEX evidence_receipts_session_hash_uidx
  ON evidence_receipts (proof_session_id, evidence_hash)
  WHERE proof_session_id IS NOT NULL;

CREATE INDEX evidence_receipts_user_observed_idx
  ON evidence_receipts (user_id, observed_at DESC, evidence_receipt_id);

CREATE INDEX evidence_receipts_session_observed_idx
  ON evidence_receipts (proof_session_id, observed_at DESC, evidence_receipt_id);

CREATE TABLE subject_keys (
  subject_key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  method TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('issuer_rp_scope', 'issuer_rp_action_scope')
  ),
  issuer_rp_scope TEXT,
  issuer_rp_action_scope TEXT,
  subject_digest TEXT NOT NULL,
  digest_algorithm TEXT NOT NULL DEFAULT 'sha256',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subject_keys_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT subject_keys_identifiers_not_blank CHECK (
    btrim(issuer) <> '' AND btrim(method) <> '' AND btrim(subject_digest) <> ''
    AND btrim(digest_algorithm) <> ''
  ),
  CONSTRAINT subject_keys_scope_shape_check CHECK (
    (scope_kind = 'issuer_rp_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NULL)
    OR (scope_kind = 'issuer_rp_action_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NOT NULL)
  ),
  CONSTRAINT subject_keys_scope_values_not_blank CHECK (
    (issuer_rp_scope IS NULL OR btrim(issuer_rp_scope) <> '')
    AND (issuer_rp_action_scope IS NULL OR btrim(issuer_rp_action_scope) <> '')
  ),
  CONSTRAINT subject_keys_id_user_unique UNIQUE (subject_key_id, user_id)
);

CREATE UNIQUE INDEX subject_keys_rp_scope_uidx
  ON subject_keys (issuer, method, issuer_rp_scope, subject_digest)
  WHERE scope_kind = 'issuer_rp_scope';

CREATE UNIQUE INDEX subject_keys_action_scope_uidx
  ON subject_keys (issuer, method, issuer_rp_scope, issuer_rp_action_scope, subject_digest)
  WHERE scope_kind = 'issuer_rp_action_scope';

CREATE INDEX subject_keys_user_scope_idx
  ON subject_keys (user_id, issuer, method, scope_kind, created_at DESC);

ALTER TABLE evidence_receipts
  ADD COLUMN subject_key_id TEXT,
  ADD CONSTRAINT evidence_receipts_subject_fk
    FOREIGN KEY (subject_key_id, user_id)
    REFERENCES subject_keys (subject_key_id, user_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_evidence_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record proof_sessions%ROWTYPE;
  subject_record subject_keys%ROWTYPE;
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
     WHERE subject_key_id = NEW.subject_key_id
       AND user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence receipt subject key is missing or belongs to another user'
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
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_receipts_validate_metadata
BEFORE INSERT OR UPDATE ON evidence_receipts
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_evidence_receipt();

CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  resolver_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL CHECK (
    observation_kind IN ('asset_inventory', 'asset_balance', 'disclosed_predicate')
  ),
  subject_ref TEXT NOT NULL,
  observation_value JSONB NOT NULL,
  chain_id TEXT,
  account_caip10 TEXT,
  asset_caip19 TEXT,
  aggregation_mode TEXT NOT NULL CHECK (
    aggregation_mode IN ('single_wallet', 'any_wallet', 'sum_across_wallets')
  ),
  trust_mode TEXT NOT NULL CHECK (trust_mode IN ('onchain_pinned', 'provider_asserted')),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'unknown')),
  snapshot_ref JSONB NOT NULL,
  source_response_hash TEXT NOT NULL CHECK (source_response_hash ~ '^[0-9a-f]{64}$'),
  descriptor_version TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT observations_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT observations_identifiers_not_blank CHECK (
    btrim(resolver_id) <> ''
    AND btrim(source_id) <> ''
    AND btrim(claim_id) <> ''
    AND btrim(observation_kind) <> ''
    AND btrim(subject_ref) <> ''
    AND btrim(aggregation_mode) <> ''
    AND btrim(descriptor_version) <> ''
  ),
  CONSTRAINT observations_value_object_check
    CHECK (jsonb_typeof(observation_value) = 'object'),
  CONSTRAINT observations_variant_shape_check CHECK (
    observation_value ->> 'kind' = observation_kind
    AND (
      (observation_kind IN ('asset_inventory', 'asset_balance')
        AND chain_id IS NOT NULL
        AND account_caip10 IS NOT NULL
        AND asset_caip19 IS NOT NULL
        AND chain_id = observation_value ->> 'chain_id'
        AND account_caip10 = observation_value ->> 'account_id'
        AND asset_caip19 = observation_value ->> 'asset_id')
      OR (observation_kind = 'disclosed_predicate'
        AND chain_id IS NULL
        AND account_caip10 IS NULL
        AND asset_caip19 IS NULL)
    )
  ),
  CONSTRAINT observations_snapshot_shape_check CHECK (
    jsonb_typeof(snapshot_ref) = 'object'
    AND jsonb_typeof(snapshot_ref -> 'kind') = 'string'
    AND jsonb_typeof(snapshot_ref -> 'reference') = 'string'
    AND btrim(snapshot_ref ->> 'kind') <> ''
    AND btrim(snapshot_ref ->> 'reference') <> ''
    AND snapshot_ref ->> 'kind' IN ('block', 'provider_snapshot', 'receipt')
  ),
  CONSTRAINT observations_id_user_unique UNIQUE (observation_id, user_id)
);

CREATE INDEX observations_snapshot_response_idx
  ON observations (resolver_id, source_response_hash);

CREATE INDEX observations_user_kind_observed_idx
  ON observations (user_id, observation_kind, observed_at DESC, observation_id);

CREATE INDEX observations_chain_asset_observed_idx
  ON observations (user_id, chain_id, asset_caip19, observed_at DESC);

CREATE INDEX observations_snapshot_idx
  ON observations USING gin (snapshot_ref);

CREATE TABLE assertion_bindings (
  binding_group_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  binding_mode TEXT NOT NULL CHECK (binding_mode IN ('same_subject', 'same_receipt')),
  subject_key_id TEXT,
  evidence_receipt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assertion_bindings_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT assertion_bindings_subject_fk
    FOREIGN KEY (subject_key_id, user_id)
    REFERENCES subject_keys (subject_key_id, user_id),
  CONSTRAINT assertion_bindings_receipt_fk
    FOREIGN KEY (evidence_receipt_id, user_id)
    REFERENCES evidence_receipts (evidence_receipt_id, user_id),
  CONSTRAINT assertion_bindings_anchor_shape_check CHECK (
    (binding_mode = 'same_subject' AND subject_key_id IS NOT NULL AND evidence_receipt_id IS NULL)
    OR (binding_mode = 'same_receipt' AND subject_key_id IS NULL AND evidence_receipt_id IS NOT NULL)
  ),
  CONSTRAINT assertion_bindings_id_user_unique UNIQUE (binding_group_id, user_id)
);

CREATE INDEX assertion_bindings_user_idx
  ON assertion_bindings (user_id, created_at DESC);

CREATE TABLE assertions (
  assertion_id TEXT PRIMARY KEY,
  binding_group_id TEXT NOT NULL,
  evidence_receipt_id TEXT NOT NULL,
  subject_key_id TEXT,
  user_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  assertion_value JSONB NOT NULL,
  assurance TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assertions_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT assertions_binding_user_fk
    FOREIGN KEY (binding_group_id, user_id)
    REFERENCES assertion_bindings (binding_group_id, user_id),
  CONSTRAINT assertions_receipt_user_fk
    FOREIGN KEY (evidence_receipt_id, user_id)
    REFERENCES evidence_receipts (evidence_receipt_id, user_id),
  CONSTRAINT assertions_subject_user_fk
    FOREIGN KEY (subject_key_id, user_id)
    REFERENCES subject_keys (subject_key_id, user_id),
  CONSTRAINT assertions_identifiers_not_blank CHECK (
    btrim(claim_id) <> '' AND btrim(assurance) <> ''
  ),
  CONSTRAINT assertions_id_binding_unique UNIQUE (assertion_id, binding_group_id),
  CONSTRAINT assertions_id_user_unique UNIQUE (assertion_id, user_id)
);

CREATE INDEX assertions_user_claim_observed_idx
  ON assertions (user_id, claim_id, observed_at DESC);

CREATE INDEX assertions_binding_claim_idx
  ON assertions (binding_group_id, claim_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_assertion_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_mode_value TEXT;
  binding_subject_key_id TEXT;
  binding_receipt_id TEXT;
  receipt_subject_key_id TEXT;
BEGIN
  SELECT binding_mode, subject_key_id, evidence_receipt_id
    INTO binding_mode_value, binding_subject_key_id, binding_receipt_id
    FROM assertion_bindings
   WHERE binding_group_id = NEW.binding_group_id
     AND user_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assertion binding group is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  SELECT subject_key_id
    INTO receipt_subject_key_id
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
    AND NEW.subject_key_id IS DISTINCT FROM binding_subject_key_id THEN
    RAISE EXCEPTION 'assertion subject key must match its same-subject binding anchor'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_subject_binding_match';
  END IF;

  IF binding_mode_value = 'same_receipt'
    AND NEW.evidence_receipt_id IS DISTINCT FROM binding_receipt_id THEN
    RAISE EXCEPTION 'assertion receipt must match its same-receipt binding anchor'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_receipt_binding_match';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER assertions_validate_binding
BEFORE INSERT OR UPDATE ON assertions
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_assertion_binding();

CREATE TABLE assertion_revalidation_events (
  assertion_revalidation_event_id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  evidence_receipt_id TEXT,
  observation_id TEXT,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('accepted', 'stale', 'revoked', 'indeterminate')),
  reason TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assertion_revalidation_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT assertion_revalidation_assertion_fk
    FOREIGN KEY (assertion_id, user_id)
    REFERENCES assertions (assertion_id, user_id),
  CONSTRAINT assertion_revalidation_receipt_fk
    FOREIGN KEY (evidence_receipt_id, user_id)
    REFERENCES evidence_receipts (evidence_receipt_id, user_id),
  CONSTRAINT assertion_revalidation_observation_fk
    FOREIGN KEY (observation_id, user_id)
    REFERENCES observations (observation_id, user_id),
  CONSTRAINT assertion_revalidation_source_check CHECK (
    evidence_receipt_id IS NOT NULL OR observation_id IS NOT NULL
  )
);

CREATE INDEX assertion_revalidation_assertion_idx
  ON assertion_revalidation_events (assertion_id, observed_at DESC);

CREATE INDEX assertion_revalidation_receipt_idx
  ON assertion_revalidation_events (evidence_receipt_id, observed_at DESC)
  WHERE evidence_receipt_id IS NOT NULL;

CREATE TABLE policy_versions (
  policy_version_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  policy JSONB NOT NULL,
  compiled_plan JSONB NOT NULL,
  compiler_version TEXT NOT NULL,
  uniqueness_model JSONB NOT NULL,
  created_by_user_id TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_versions_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT policy_versions_author_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT policy_versions_identifiers_not_blank CHECK (
    btrim(policy_key) <> '' AND btrim(compiler_version) <> ''
  ),
  CONSTRAINT policy_versions_json_shape_check CHECK (
    jsonb_typeof(policy) = 'object'
    AND jsonb_typeof(compiled_plan) = 'object'
    AND jsonb_typeof(uniqueness_model) = 'object'
  ),
  CONSTRAINT policy_versions_community_version_unique
    UNIQUE (community_id, policy_version_id),
  CONSTRAINT policy_versions_community_key_version_unique
    UNIQUE (community_id, policy_key, policy_version_id),
  CONSTRAINT policy_versions_revision_unique
    UNIQUE (community_id, policy_key, revision),
  CONSTRAINT policy_versions_hash_unique
    UNIQUE (community_id, policy_key, policy_hash),
  CONSTRAINT policy_versions_community_id_hash_unique
    UNIQUE (community_id, policy_version_id, policy_hash)
);

CREATE TABLE community_policy_current (
  community_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT community_policy_current_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT community_policy_current_policy_fk
    FOREIGN KEY (community_id, policy_key, policy_version_id)
    REFERENCES policy_versions (community_id, policy_key, policy_version_id),
  CONSTRAINT community_policy_current_pk PRIMARY KEY (community_id, policy_key)
);

CREATE INDEX community_policy_current_version_idx
  ON community_policy_current (policy_version_id);

CREATE TABLE decision_records (
  decision_record_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  evaluation_mode TEXT NOT NULL CHECK (evaluation_mode IN ('preview', 'enforce', 'diagnose')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'needs_evidence', 'indeterminate')),
  winning_witness JSONB NOT NULL DEFAULT '[]'::jsonb,
  trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  indeterminate_reason TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_records_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT decision_records_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT decision_records_policy_hash_fk
    FOREIGN KEY (community_id, policy_version_id, policy_hash)
    REFERENCES policy_versions (community_id, policy_version_id, policy_hash),
  CONSTRAINT decision_records_witness_shape_check CHECK (
    jsonb_typeof(winning_witness) = 'array'
    AND jsonb_typeof(trace) = 'array'
  ),
  CONSTRAINT decision_records_request_not_blank CHECK (
    request_id IS NULL OR btrim(request_id) <> ''
  ),
  CONSTRAINT decision_records_pass_witness_check CHECK (
    outcome <> 'pass' OR jsonb_array_length(winning_witness) > 0
  )
);

CREATE UNIQUE INDEX decision_records_request_uidx
  ON decision_records (community_id, user_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX decision_records_user_created_idx
  ON decision_records (user_id, created_at DESC, decision_record_id);

CREATE INDEX decision_records_policy_created_idx
  ON decision_records (policy_version_id, created_at DESC, decision_record_id);

CREATE TABLE action_intents (
  action_intent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  community_id TEXT,
  action_kind TEXT NOT NULL,
  action_scope TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL CHECK (action_payload_hash ~ '^[0-9a-f]{64}$'),
  intent_binding_hash TEXT NOT NULL CHECK (intent_binding_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'fulfilled', 'expired', 'canceled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_intents_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT action_intents_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT action_intents_identifiers_not_blank CHECK (
    btrim(action_kind) <> '' AND btrim(action_scope) <> '' AND btrim(idempotency_key) <> ''
  ),
  CONSTRAINT action_intents_user_action_idempotency_unique
    UNIQUE (user_id, action_kind, idempotency_key),
  CONSTRAINT action_intents_identity_unique
    UNIQUE (action_intent_id, user_id, action_kind, action_scope, action_payload_hash)
);

CREATE INDEX action_intents_expiry_idx
  ON action_intents (status, expires_at, action_intent_id);

CREATE TABLE action_challenges (
  action_challenge_id TEXT PRIMARY KEY,
  action_intent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('issued', 'verified', 'expired', 'canceled')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_challenges_intent_fk
    FOREIGN KEY (action_intent_id) REFERENCES action_intents (action_intent_id),
  CONSTRAINT action_challenges_provider_not_blank CHECK (btrim(provider_id) <> ''),
  CONSTRAINT action_challenges_intent_hash_unique
    UNIQUE (action_intent_id, challenge_hash),
  CONSTRAINT action_challenges_id_intent_provider_unique
    UNIQUE (action_challenge_id, action_intent_id, provider_id)
);

CREATE INDEX action_challenges_intent_status_idx
  ON action_challenges (action_intent_id, status, expires_at DESC);

CREATE TABLE action_grants (
  action_grant_id TEXT PRIMARY KEY,
  action_intent_id TEXT NOT NULL,
  action_challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_scope TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL CHECK (action_payload_hash ~ '^[0-9a-f]{64}$'),
  grant_nonce TEXT NOT NULL,
  signed_grant TEXT NOT NULL,
  signer_key_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_grants_intent_fk
    FOREIGN KEY (action_intent_id) REFERENCES action_intents (action_intent_id),
  CONSTRAINT action_grants_challenge_intent_fk
    FOREIGN KEY (action_challenge_id, action_intent_id, provider_id)
    REFERENCES action_challenges (action_challenge_id, action_intent_id, provider_id),
  CONSTRAINT action_grants_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT action_grants_intent_identity_fk
    FOREIGN KEY (action_intent_id, user_id, action_kind, action_scope, action_payload_hash)
    REFERENCES action_intents (
      action_intent_id, user_id, action_kind, action_scope, action_payload_hash
    ),
  CONSTRAINT action_grants_identifiers_not_blank CHECK (
    btrim(provider_id) <> '' AND btrim(action_kind) <> '' AND btrim(action_scope) <> ''
    AND btrim(grant_nonce) <> '' AND btrim(signed_grant) <> '' AND btrim(signer_key_id) <> ''
  ),
  CONSTRAINT action_grants_intent_unique UNIQUE (action_intent_id),
  CONSTRAINT action_grants_nonce_unique UNIQUE (grant_nonce),
  CONSTRAINT action_grants_consumption_identity_unique UNIQUE (
    action_grant_id,
    grant_nonce,
    action_intent_id,
    action_kind,
    action_scope,
    action_payload_hash
  )
);

CREATE INDEX action_grants_user_expiry_idx
  ON action_grants (user_id, expires_at DESC, action_grant_id);

CREATE TABLE used_action_grants (
  grant_nonce TEXT PRIMARY KEY,
  action_grant_id TEXT NOT NULL,
  action_intent_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_scope TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL CHECK (action_payload_hash ~ '^[0-9a-f]{64}$'),
  action_result_ref TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT used_action_grants_grant_intent_fk
    FOREIGN KEY (
      action_grant_id,
      grant_nonce,
      action_intent_id,
      action_kind,
      action_scope,
      action_payload_hash
    )
    REFERENCES action_grants (
      action_grant_id,
      grant_nonce,
      action_intent_id,
      action_kind,
      action_scope,
      action_payload_hash
    ),
  CONSTRAINT used_action_grants_identifiers_not_blank CHECK (
    btrim(grant_nonce) <> ''
    AND btrim(action_kind) <> ''
    AND btrim(action_scope) <> ''
    AND btrim(action_result_ref) <> ''
  ),
  CONSTRAINT used_action_grants_grant_unique UNIQUE (action_grant_id)
);

CREATE INDEX used_action_grants_intent_idx
  ON used_action_grants (action_intent_id, consumed_at DESC);

-- These rows are evidence and published artifacts, not mutable projections.
-- Action intents/challenges and the current policy pointer are intentionally
-- mutable because they represent lifecycle state rather than historical fact.
CREATE OR REPLACE FUNCTION gates_v2_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'gates_v2_append_only';
END;
$$;

CREATE TRIGGER evidence_receipts_append_only
BEFORE UPDATE OR DELETE ON evidence_receipts
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER subject_keys_append_only
BEFORE UPDATE OR DELETE ON subject_keys
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertion_bindings_append_only
BEFORE UPDATE OR DELETE ON assertion_bindings
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertions_append_only
BEFORE UPDATE OR DELETE ON assertions
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertion_revalidation_events_append_only
BEFORE UPDATE OR DELETE ON assertion_revalidation_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER observations_append_only
BEFORE UPDATE OR DELETE ON observations
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER policy_versions_append_only
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER decision_records_append_only
BEFORE UPDATE OR DELETE ON decision_records
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER action_grants_append_only
BEFORE UPDATE OR DELETE ON action_grants
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER used_action_grants_append_only
BEFORE UPDATE OR DELETE ON used_action_grants
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();
-- Make subject identity independent from account ownership, then add the
-- recoverable binding and proof-completion lifecycles required before the
-- first production provider.

ALTER TABLE evidence_receipts
  DROP CONSTRAINT evidence_receipts_subject_fk;

ALTER TABLE assertion_bindings
  DROP CONSTRAINT assertion_bindings_subject_fk;

ALTER TABLE assertions
  DROP CONSTRAINT assertions_subject_user_fk;

DROP INDEX subject_keys_user_scope_idx;

ALTER TABLE subject_keys
  DROP CONSTRAINT subject_keys_id_user_unique,
  DROP CONSTRAINT subject_keys_user_fk,
  DROP COLUMN user_id;

ALTER TABLE subject_keys
  ADD CONSTRAINT subject_keys_sha256_digest_check CHECK (
    digest_algorithm = 'sha256' AND subject_digest ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE proof_sessions
  ADD COLUMN subject_binding_intent TEXT NOT NULL
    CHECK (subject_binding_intent IN ('establish', 'recover', 'none'));

CREATE INDEX subject_keys_scope_created_idx
  ON subject_keys (issuer, method, scope_kind, created_at DESC, subject_key_id);

CREATE TABLE subject_key_binding_events (
  binding_event_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  user_id TEXT NOT NULL,
  proof_session_id TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('initial', 'recovery')),
  previous_binding_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subject_key_binding_events_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  CONSTRAINT subject_key_binding_events_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT subject_key_binding_events_session_actor_fk
    FOREIGN KEY (proof_session_id, user_id)
    REFERENCES proof_sessions (proof_session_id, actor_id),
  CONSTRAINT subject_key_binding_events_not_blank CHECK (
    btrim(binding_event_id) <> '' AND btrim(idempotency_key) <> ''
  ),
  CONSTRAINT subject_key_binding_events_subject_epoch_unique
    UNIQUE (subject_key_id, binding_epoch),
  CONSTRAINT subject_key_binding_events_subject_idempotency_unique
    UNIQUE (subject_key_id, idempotency_key),
  CONSTRAINT subject_key_binding_events_event_subject_unique
    UNIQUE (binding_event_id, subject_key_id),
  CONSTRAINT subject_key_binding_events_receipt_identity_unique
    UNIQUE (binding_event_id, subject_key_id, binding_epoch, user_id),
  CONSTRAINT subject_key_binding_events_previous_fk
    FOREIGN KEY (previous_binding_event_id, subject_key_id)
    REFERENCES subject_key_binding_events (binding_event_id, subject_key_id)
);

CREATE INDEX subject_key_binding_events_user_bound_idx
  ON subject_key_binding_events (user_id, bound_at DESC, binding_event_id);

CREATE TABLE active_subject_key_bindings (
  subject_key_id TEXT PRIMARY KEY,
  binding_event_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  user_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT active_subject_key_bindings_event_fk
    FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  CONSTRAINT active_subject_key_bindings_subject_user_unique
    UNIQUE (subject_key_id, user_id)
);

CREATE INDEX active_subject_key_bindings_user_idx
  ON active_subject_key_bindings (user_id, activated_at DESC, subject_key_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_subject_key_binding_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER subject_key_binding_events_validate
BEFORE INSERT ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_subject_key_binding_event();

CREATE OR REPLACE FUNCTION gates_v2_project_subject_key_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER subject_key_binding_events_project
AFTER INSERT ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_project_subject_key_binding();

CREATE OR REPLACE FUNCTION gates_v2_active_binding_projection_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER active_subject_key_bindings_projection_only
BEFORE INSERT OR UPDATE OR DELETE ON active_subject_key_bindings
FOR EACH ROW EXECUTE FUNCTION gates_v2_active_binding_projection_guard();

CREATE TRIGGER subject_key_binding_events_append_only
BEFORE UPDATE OR DELETE ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

ALTER TABLE evidence_receipts
  ADD COLUMN subject_binding_event_id TEXT,
  ADD COLUMN subject_binding_epoch BIGINT,
  ADD CONSTRAINT evidence_receipts_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  ADD CONSTRAINT evidence_receipts_subject_binding_shape_check CHECK (
    (subject_key_id IS NULL
      AND subject_binding_event_id IS NULL
      AND subject_binding_epoch IS NULL)
    OR (subject_key_id IS NOT NULL
      AND subject_binding_event_id IS NOT NULL
      AND subject_binding_epoch IS NOT NULL)
  ),
  ADD CONSTRAINT evidence_receipts_subject_binding_fk
    FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  ADD CONSTRAINT evidence_receipts_binding_identity_unique
    UNIQUE (
      evidence_receipt_id,
      subject_key_id,
      subject_binding_event_id,
      subject_binding_epoch,
      user_id
    );

CREATE UNIQUE INDEX evidence_receipts_provider_evidence_uidx
  ON evidence_receipts (provider_id, environment, evidence_hash);

ALTER TABLE assertion_bindings
  DROP CONSTRAINT assertion_bindings_anchor_shape_check,
  ADD COLUMN subject_binding_event_id TEXT,
  ADD COLUMN subject_binding_epoch BIGINT,
  ADD CONSTRAINT assertion_bindings_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  ADD CONSTRAINT assertion_bindings_subject_binding_fk
    FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  ADD CONSTRAINT assertion_bindings_anchor_shape_check CHECK (
    (binding_mode = 'same_subject'
      AND subject_key_id IS NOT NULL
      AND subject_binding_event_id IS NOT NULL
      AND subject_binding_epoch IS NOT NULL
      AND evidence_receipt_id IS NULL)
    OR (binding_mode = 'same_receipt'
      AND subject_key_id IS NULL
      AND subject_binding_event_id IS NULL
      AND subject_binding_epoch IS NULL
      AND evidence_receipt_id IS NOT NULL)
  );

ALTER TABLE assertions
  ADD CONSTRAINT assertions_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_evidence_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE OR REPLACE FUNCTION gates_v2_validate_assertion_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

ALTER TABLE proof_sessions
  ADD COLUMN completion_idempotency_key TEXT,
  ADD COLUMN completion_result_hash TEXT,
  ADD COLUMN terminal_at TIMESTAMPTZ,
  ADD CONSTRAINT proof_sessions_actor_intent_unique UNIQUE (actor_id, intent_id),
  ADD CONSTRAINT proof_sessions_terminal_shape_check CHECK (
    (status = 'pending'
      AND completion_idempotency_key IS NULL
      AND completion_result_hash IS NULL
      AND terminal_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed'
      AND completion_idempotency_key IS NOT NULL
      AND btrim(completion_idempotency_key) <> ''
      AND completion_result_hash ~ '^[0-9a-f]{64}$'
      AND terminal_at IS NOT NULL
      AND completed_at = terminal_at)
    OR (status IN ('failed', 'expired')
      AND completion_idempotency_key IS NOT NULL
      AND btrim(completion_idempotency_key) <> ''
      AND completion_result_hash ~ '^[0-9a-f]{64}$'
      AND terminal_at IS NOT NULL
      AND completed_at IS NULL)
  );

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER proof_sessions_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON proof_sessions
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_lifecycle();

CREATE TABLE proof_session_completion_events (
  completion_event_id TEXT PRIMARY KEY,
  proof_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('completed', 'failed', 'expired')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_session_completion_events_session_actor_fk
    FOREIGN KEY (proof_session_id, actor_id)
    REFERENCES proof_sessions (proof_session_id, actor_id),
  CONSTRAINT proof_session_completion_events_not_blank CHECK (
    btrim(completion_event_id) <> '' AND btrim(idempotency_key) <> ''
  ),
  CONSTRAINT proof_session_completion_events_session_unique UNIQUE (proof_session_id),
  CONSTRAINT proof_session_completion_events_idempotency_unique
    UNIQUE (proof_session_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_completion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER proof_session_completion_events_validate
BEFORE INSERT ON proof_session_completion_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_completion_event();

CREATE TRIGGER proof_session_completion_events_append_only
BEFORE UPDATE OR DELETE ON proof_session_completion_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE OR REPLACE FUNCTION gates_v2_require_terminal_completion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE CONSTRAINT TRIGGER proof_sessions_terminal_completion_event
AFTER INSERT OR UPDATE ON proof_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gates_v2_require_terminal_completion_event();

CREATE TABLE reward_uniqueness_authorities (
  campaign_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  method TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('issuer_rp_scope', 'issuer_rp_action_scope')
  ),
  issuer_rp_scope TEXT NOT NULL,
  issuer_rp_action_scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reward_uniqueness_authorities_not_blank CHECK (
    btrim(campaign_id) <> '' AND btrim(issuer) <> '' AND btrim(method) <> ''
    AND btrim(issuer_rp_scope) <> ''
    AND (issuer_rp_action_scope IS NULL OR btrim(issuer_rp_action_scope) <> '')
  ),
  CONSTRAINT reward_uniqueness_authorities_scope_shape_check CHECK (
    (scope_kind = 'issuer_rp_scope' AND issuer_rp_action_scope IS NULL)
    OR (scope_kind = 'issuer_rp_action_scope' AND issuer_rp_action_scope IS NOT NULL)
  )
);

ALTER TABLE policy_versions
  ADD COLUMN policy_purpose TEXT NOT NULL
    CHECK (policy_purpose IN ('access', 'reward')),
  ADD COLUMN uniqueness_authority_id TEXT,
  ADD CONSTRAINT policy_versions_uniqueness_authority_fk
    FOREIGN KEY (uniqueness_authority_id)
    REFERENCES reward_uniqueness_authorities (campaign_id),
  ADD CONSTRAINT policy_versions_reward_authority_check CHECK (
    (policy_purpose = 'access' AND uniqueness_authority_id IS NULL)
    OR (policy_purpose = 'reward'
      AND uniqueness_authority_id IS NOT NULL
      AND uniqueness_model ->> 'kind' = 'single_authority'
      AND uniqueness_model ->> 'authority_id' = uniqueness_authority_id)
  );

CREATE TABLE reward_subject_consumptions (
  reward_subject_consumption_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subject_key_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  binding_event_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  evidence_receipt_id TEXT,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reward_subject_consumptions_campaign_fk
    FOREIGN KEY (campaign_id)
    REFERENCES reward_uniqueness_authorities (campaign_id),
  CONSTRAINT reward_subject_consumptions_binding_fk
    FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  CONSTRAINT reward_subject_consumptions_receipt_fk
    FOREIGN KEY (
      evidence_receipt_id,
      subject_key_id,
      binding_event_id,
      binding_epoch,
      user_id
    ) REFERENCES evidence_receipts (
      evidence_receipt_id,
      subject_key_id,
      subject_binding_event_id,
      subject_binding_epoch,
      user_id
    ),
  CONSTRAINT reward_subject_consumptions_campaign_subject_unique
    UNIQUE (campaign_id, subject_key_id)
);

CREATE OR REPLACE FUNCTION gates_v2_validate_reward_subject_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER reward_subject_consumptions_validate
BEFORE INSERT ON reward_subject_consumptions
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_reward_subject_consumption();

CREATE TRIGGER reward_uniqueness_authorities_append_only
BEFORE UPDATE OR DELETE ON reward_uniqueness_authorities
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER reward_subject_consumptions_append_only
BEFORE UPDATE OR DELETE ON reward_subject_consumptions
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();
