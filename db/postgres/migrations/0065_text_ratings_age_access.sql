-- Text content ratings and account-scoped adult access.
--
-- Song and uploaded-media ratings remain outside this migration. A nullable
-- posts.content_rating therefore means "not a text resource", never an
-- unknown text rating.

CREATE TABLE account_minimum_age_attestations (
  account_id TEXT PRIMARY KEY REFERENCES users (user_id),
  version TEXT NOT NULL CHECK (version = 'minimum-age-attestation-v1'),
  minimum_age INTEGER NOT NULL CHECK (minimum_age = 16),
  affirmed BOOLEAN NOT NULL CHECK (affirmed),
  attested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION guard_account_minimum_age_attestation_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.account_id, NEW.version, NEW.minimum_age, NEW.affirmed)
      IS DISTINCT FROM ROW(OLD.account_id, OLD.version, OLD.minimum_age, OLD.affirmed) THEN
    RAISE EXCEPTION 'minimum-age attestation is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.attested_at <> OLD.attested_at THEN
    RAISE EXCEPTION 'minimum-age attestation timestamp is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_minimum_age_attestation_guard_v1
BEFORE UPDATE OR DELETE ON account_minimum_age_attestations
FOR EACH ROW EXECUTE FUNCTION guard_account_minimum_age_attestation_v1();

CREATE OR REPLACE FUNCTION current_account_age_capability_v1(target_account_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM assertions AS assertion
      JOIN evidence_receipts AS receipt
        ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
       AND receipt.user_id = assertion.user_id
      JOIN proof_sessions AS session
        ON session.proof_session_id = receipt.proof_session_id
       AND session.actor_id = assertion.user_id
       AND session.status = 'completed'
       AND session.completed_at = session.terminal_at
       AND session.intent_id = 'platform.document.age-18'
       AND session.method = 'document'
       AND session.scope_kind = 'issuer_rp_scope'
       AND session.issuer_rp_scope = 'pirate-social'
       AND session.issuer_rp_action_scope IS NULL
       AND session.requested_requirements = '[{"claim_id":"age.minimum","minimum_age":"18"},{"claim_id":"credential.subject_unique"},{"claim_id":"document.valid"}]'::jsonb
       AND session.requested_claim_ids = '["age.minimum","credential.subject_unique","document.valid"]'::jsonb
      JOIN assertion_bindings AS binding
        ON binding.binding_group_id = assertion.binding_group_id
       AND binding.user_id = assertion.user_id
       AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = assertion.subject_key_id
      JOIN active_subject_key_bindings AS active_binding
        ON active_binding.subject_key_id = assertion.subject_key_id
       AND active_binding.user_id = assertion.user_id
       AND active_binding.binding_event_id = binding.subject_binding_event_id
       AND active_binding.binding_epoch = binding.subject_binding_epoch
     WHERE assertion.user_id = target_account_id
       AND assertion.claim_id = 'age.minimum'
       AND assertion.assurance = 'document_zk'
       AND receipt.provider_id IN ('self.pass', 'self.enterprise', 'zkpassport')
       AND receipt.subject_key_id = assertion.subject_key_id
       AND assertion.assertion_value ? 'minimum_age'
       AND assertion.assertion_value->>'minimum_age' ~ '^(0|[1-9][0-9]*)$'
       AND (assertion.assertion_value->>'minimum_age')::NUMERIC >= 18
       AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
       AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
       AND EXISTS (
         SELECT 1
           FROM assertions AS credential
           JOIN evidence_receipts AS credential_receipt
             ON credential_receipt.evidence_receipt_id = credential.evidence_receipt_id
            AND credential_receipt.proof_session_id = session.proof_session_id
            AND credential_receipt.user_id = assertion.user_id
            AND credential_receipt.subject_key_id = assertion.subject_key_id
          WHERE credential.user_id = assertion.user_id
            AND credential.binding_group_id = assertion.binding_group_id
            AND credential.subject_key_id = assertion.subject_key_id
            AND credential.claim_id = 'credential.subject_unique'
            AND credential.assertion_value = '{"subject_unique":true}'::jsonb
            AND credential.assurance = 'document_zk'
            AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            AND (credential_receipt.expires_at IS NULL OR credential_receipt.expires_at > clock_timestamp())
       )
       AND EXISTS (
         SELECT 1
           FROM assertions AS document
           JOIN evidence_receipts AS document_receipt
             ON document_receipt.evidence_receipt_id = document.evidence_receipt_id
            AND document_receipt.proof_session_id = session.proof_session_id
            AND document_receipt.user_id = assertion.user_id
            AND document_receipt.subject_key_id = assertion.subject_key_id
          WHERE document.user_id = assertion.user_id
            AND document.binding_group_id = assertion.binding_group_id
            AND document.subject_key_id = assertion.subject_key_id
            AND document.claim_id = 'document.valid'
            AND document.assertion_value = '{"valid":true}'::jsonb
            AND document.assurance = 'document_zk'
            AND (document.expires_at IS NULL OR document.expires_at > clock_timestamp())
            AND (document_receipt.expires_at IS NULL OR document_receipt.expires_at > clock_timestamp())
       )
       AND NOT EXISTS (
         SELECT 1
           FROM LATERAL (
             SELECT event.outcome
               FROM assertion_revalidation_events AS event
              WHERE event.assertion_id = assertion.assertion_id
                AND event.user_id = assertion.user_id
           ORDER BY event.observed_at DESC, event.created_at DESC,
                    event.assertion_revalidation_event_id DESC
              LIMIT 1
           ) AS latest
          WHERE latest.outcome <> 'accepted'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM assertions AS sibling
           JOIN LATERAL (
             SELECT event.outcome
               FROM assertion_revalidation_events AS event
              WHERE event.assertion_id = sibling.assertion_id
                AND event.user_id = sibling.user_id
           ORDER BY event.observed_at DESC, event.created_at DESC,
                    event.assertion_revalidation_event_id DESC
              LIMIT 1
           ) AS latest ON TRUE
          WHERE sibling.user_id = assertion.user_id
            AND sibling.binding_group_id = assertion.binding_group_id
            AND latest.outcome <> 'accepted'
       )
  ) THEN 'adult_18' ELSE 'general' END;
$$;

CREATE OR REPLACE FUNCTION can_account_view_content_rating_v1(
  target_account_id TEXT,
  target_rating TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN target_rating = 'general' THEN TRUE
    WHEN target_rating = 'adult_18' AND target_account_id IS NOT NULL
      THEN current_account_age_capability_v1(target_account_id) = 'adult_18'
    ELSE FALSE
  END;
$$;

ALTER TABLE posts
  ADD COLUMN author_declared_rating TEXT,
  ADD COLUMN content_rating TEXT;

UPDATE posts
   SET author_declared_rating = 'general', content_rating = 'general'
 WHERE post_type = 'text';

ALTER TABLE posts
  ADD CONSTRAINT posts_text_rating_shape CHECK (
    (post_type = 'text'
      AND author_declared_rating IN ('general', 'adult_18')
      AND content_rating IN ('general', 'adult_18')
      AND (content_rating = 'adult_18' OR author_declared_rating = 'general'))
    OR (post_type <> 'text'
      AND author_declared_rating IS NULL
      AND content_rating IS NULL)
  );

CREATE OR REPLACE FUNCTION default_text_post_rating_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.post_type = 'text' THEN
    NEW.author_declared_rating := COALESCE(NEW.author_declared_rating, 'general');
    NEW.content_rating := COALESCE(NEW.content_rating, 'general');
  ELSIF NEW.author_declared_rating IS NOT NULL OR NEW.content_rating IS NOT NULL THEN
    RAISE EXCEPTION 'non-text post cannot carry a text content rating';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER posts_text_rating_default_v1
BEFORE INSERT ON posts
FOR EACH ROW EXECUTE FUNCTION default_text_post_rating_v1();

ALTER TABLE comments
  ADD COLUMN author_declared_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (author_declared_rating IN ('general', 'adult_18')),
  ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (content_rating IN ('general', 'adult_18')),
  ADD CONSTRAINT comments_rating_raise_only CHECK (
    content_rating = 'adult_18' OR author_declared_rating = 'general'
  );

ALTER TABLE comment_publication_projection
  ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (content_rating IN ('general', 'adult_18'));

CREATE OR REPLACE FUNCTION enforce_text_rating_ancestry_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_rating TEXT;
BEGIN
  IF NEW.parent_comment_id IS NULL THEN
    SELECT post.content_rating INTO parent_rating
      FROM posts AS post
     WHERE post.community_id = NEW.community_id
       AND post.post_id = NEW.post_id
       AND post.post_type = 'text';
  ELSE
    SELECT parent.content_rating INTO parent_rating
      FROM comments AS parent
     WHERE parent.community_id = NEW.community_id
       AND parent.comment_id = NEW.parent_comment_id;
  END IF;
  IF parent_rating IS NULL THEN
    RAISE EXCEPTION 'comment rating requires a text parent';
  END IF;
  IF parent_rating = 'adult_18' THEN
    NEW.content_rating := 'adult_18';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER comments_text_rating_ancestry_v1
BEFORE INSERT OR UPDATE OF community_id, post_id, parent_comment_id, content_rating
ON comments
FOR EACH ROW EXECUTE FUNCTION enforce_text_rating_ancestry_v1();

CREATE OR REPLACE FUNCTION raise_text_rating_with_descendants_v1(
  target_community_id TEXT,
  target_kind TEXT,
  target_resource_id TEXT,
  transition_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  changed_count INTEGER := 0;
  latest_count INTEGER := 0;
BEGIN
  IF target_kind = 'text_post' THEN
    UPDATE posts
       SET content_rating = 'adult_18', updated_at = transition_at
     WHERE community_id = target_community_id
       AND post_id = target_resource_id
       AND post_type = 'text';
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    UPDATE comments
       SET content_rating = 'adult_18', updated_at = transition_at
     WHERE community_id = target_community_id
       AND post_id = target_resource_id
       AND content_rating <> 'adult_18';
    GET DIAGNOSTICS latest_count = ROW_COUNT;
    changed_count := changed_count + latest_count;
  ELSIF target_kind IN ('comment', 'reply') THEN
    WITH RECURSIVE descendants AS (
      SELECT comment_id
        FROM comments
       WHERE community_id = target_community_id
         AND comment_id = target_resource_id
      UNION ALL
      SELECT child.comment_id
        FROM comments AS child
        JOIN descendants AS parent ON parent.comment_id = child.parent_comment_id
       WHERE child.community_id = target_community_id
    )
    UPDATE comments AS comment
       SET content_rating = 'adult_18', updated_at = transition_at
      FROM descendants
     WHERE comment.community_id = target_community_id
       AND comment.comment_id = descendants.comment_id
       AND comment.content_rating <> 'adult_18';
    GET DIAGNOSTICS changed_count = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unsupported text rating target kind';
  END IF;

  UPDATE comment_publication_projection AS projection
     SET content_rating = comment.content_rating, updated_at = transition_at
    FROM comments AS comment
   WHERE projection.community_id = target_community_id
     AND comment.community_id = projection.community_id
     AND comment.comment_id = projection.comment_id
     AND projection.content_rating IS DISTINCT FROM comment.content_rating;
  RETURN changed_count;
END;
$$;

CREATE OR REPLACE FUNCTION guard_comment_publication_rating_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resource_rating TEXT;
BEGIN
  SELECT comment.content_rating INTO resource_rating
    FROM comments AS comment
   WHERE comment.community_id = NEW.community_id
     AND comment.comment_id = NEW.comment_id;
  IF resource_rating IS NULL THEN
    RAISE EXCEPTION 'comment projection rating disagrees with resource';
  END IF;
  NEW.content_rating := resource_rating;
  RETURN NEW;
END;
$$;

CREATE TRIGGER comment_publication_rating_guard_v1
BEFORE INSERT OR UPDATE OF content_rating ON comment_publication_projection
FOR EACH ROW EXECUTE FUNCTION guard_comment_publication_rating_v1();

ALTER TABLE community_moderation_actions_v2
  DROP CONSTRAINT community_moderation_actions_v2_resolved_age_capability_check,
  ADD CONSTRAINT community_moderation_actions_v2_resolved_age_capability_check
    CHECK (resolved_age_capability IN ('general', 'adult_18'));

CREATE OR REPLACE FUNCTION guard_community_moderation_action_v2_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_case community_moderation_cases_v2%ROWTYPE;
  submission text_content_submissions%ROWTYPE;
  rating TEXT;
  age_capability TEXT;
BEGIN
  SELECT * INTO target_case
    FROM community_moderation_cases_v2
   WHERE community_id = NEW.community_id AND case_ref = NEW.case_ref
   FOR UPDATE;
  IF NOT FOUND OR target_case.visibility <> 'owner'
    OR target_case.view_state NOT IN ('open', 'hidden') THEN
    RAISE EXCEPTION 'moderation case is not owner-actionable';
  END IF;
  IF NOT has_community_moderation_capability_v1(
    NEW.actor_user_id, NEW.community_id, 'moderation.act'
  ) THEN
    RAISE EXCEPTION 'moderation action requires active owner authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM community_role_assignments AS assignment
     WHERE assignment.role_assignment_id = NEW.owner_role_assignment_id
       AND assignment.community_id = NEW.community_id
       AND assignment.account_id = NEW.actor_user_id
       AND assignment.role = 'owner' AND assignment.status = 'active'
  ) THEN
    RAISE EXCEPTION 'moderation action owner snapshot is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM personas AS persona
     WHERE persona.persona_id = NEW.presenting_persona_id
       AND persona.account_id = NEW.actor_user_id
       AND persona.status = 'active'
  ) THEN
    RAISE EXCEPTION 'moderation action presenting persona is invalid';
  END IF;

  SELECT * INTO submission
    FROM text_content_submissions
   WHERE community_id = target_case.community_id
     AND submission_id = target_case.submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'moderation action submission is missing';
  END IF;
  rating := NEW.before_rating;
  IF COALESCE(submission.resulting_content_rating, 'adult_18') <> rating
    AND NOT (
      NEW.action = 'approve_as_adult_18'
      AND submission.resulting_content_rating = NEW.after_rating
    ) THEN
    RAISE EXCEPTION 'moderation action submission rating is stale';
  END IF;
  age_capability := current_account_age_capability_v1(NEW.actor_user_id);
  IF NEW.resolved_age_capability <> age_capability THEN
    RAISE EXCEPTION 'moderation action age capability snapshot is stale';
  END IF;
  IF NEW.expected_case_revision <> target_case.case_revision
    OR NEW.before_view_state <> target_case.view_state
    OR NEW.before_target_status <> target_case.target_status
    OR NEW.before_rating <> rating THEN
    RAISE EXCEPTION 'moderation action case revision is stale';
  END IF;
  IF submission.platform_policy_revision_id <> NEW.platform_policy_revision_id
    OR submission.platform_policy_hash <> NEW.platform_policy_hash
    OR submission.community_policy_revision_id <> NEW.community_policy_revision_id
    OR submission.community_policy_hash <> NEW.community_policy_hash
    OR submission.evidence_ref IS DISTINCT FROM NEW.evidence_ref THEN
    RAISE EXCEPTION 'moderation action policy evidence snapshot is invalid';
  END IF;
  IF NEW.action = 'approve_as_general'
    AND submission.author_declared_rating = 'adult_18' THEN
    RAISE EXCEPTION 'adult author declaration cannot be approved as general';
  END IF;
  IF (
    NEW.action = 'approve_as_adult_18'
    OR (rating = 'adult_18' AND NEW.action IN ('dismiss_report', 'restore'))
  ) AND age_capability <> 'adult_18' THEN
    RAISE EXCEPTION 'moderation action requires adult capability';
  END IF;

  IF NOT (
    (NEW.action IN ('approve_as_general', 'approve_as_adult_18')
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'held'
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'published'
      AND NEW.after_rating = CASE NEW.action
        WHEN 'approve_as_adult_18' THEN 'adult_18' ELSE rating END)
    OR (NEW.action = 'reject'
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'held'
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'blocked'
      AND NEW.after_rating = rating)
    OR (NEW.action = 'dismiss_report'
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'published'
      AND target_case.source IN ('member_report', 'mixed')
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'published'
      AND NEW.after_rating = rating)
    OR (NEW.action = 'hide'
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'published'
      AND NEW.after_view_state = 'hidden'
      AND NEW.after_target_status = 'hidden'
      AND NEW.after_rating = rating)
    OR (NEW.action = 'raise_rating_to_adult_18'
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'published'
      AND rating = 'general'
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'published'
      AND NEW.after_rating = 'adult_18')
    OR (NEW.action = 'restore'
      AND target_case.view_state = 'hidden'
      AND target_case.target_status = 'hidden'
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'published'
      AND NEW.after_rating = rating)
  ) THEN
    RAISE EXCEPTION 'moderation action is outside the closed state matrix';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_text_content_submission_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.submission_id, NEW.operation_id, NEW.actor_user_id,
    NEW.author_persona_id, NEW.surface, NEW.target_post_id,
    NEW.target_parent_comment_id, NEW.idempotency_key, NEW.request_hash,
    NEW.moderation_decision, NEW.policy_revision_id, NEW.policy_hash,
    NEW.platform_policy_revision_id, NEW.platform_policy_hash,
    NEW.community_policy_revision_id, NEW.community_policy_hash,
    NEW.input_sha256, NEW.internal_reason_codes, NEW.evidence_ref,
    NEW.created_at, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256,
    NEW.author_declared_rating, NEW.matched_categories,
    NEW.category_decisions, NEW.effective_policy_decision
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.submission_id, OLD.operation_id, OLD.actor_user_id,
    OLD.author_persona_id, OLD.surface, OLD.target_post_id,
    OLD.target_parent_comment_id, OLD.idempotency_key, OLD.request_hash,
    OLD.moderation_decision, OLD.policy_revision_id, OLD.policy_hash,
    OLD.platform_policy_revision_id, OLD.platform_policy_hash,
    OLD.community_policy_revision_id, OLD.community_policy_hash,
    OLD.input_sha256, OLD.internal_reason_codes, OLD.evidence_ref,
    OLD.created_at, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256,
    OLD.author_declared_rating, OLD.matched_categories,
    OLD.category_decisions, OLD.effective_policy_decision
  ) THEN
    RAISE EXCEPTION 'text content submission evidence and creation snapshot are immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text content submission updated_at must advance';
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'published' THEN
    IF OLD.resulting_content_rating <> 'general'
      OR NEW.resulting_content_rating <> 'adult_18'
      OR ROW(NEW.public_reason_code, NEW.published_post_id,
             NEW.published_comment_id, NEW.review_ref)
         IS DISTINCT FROM
         ROW(OLD.public_reason_code, OLD.published_post_id,
             OLD.published_comment_id, OLD.review_ref) THEN
      RAISE EXCEPTION 'published text submission permits only an adult rating raise';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'manual_review' OR NEW.status NOT IN ('published', 'blocked') THEN
    RAISE EXCEPTION 'text content submission transition is not allowed: % -> %',
      OLD.status, NEW.status;
  END IF;
  IF OLD.resulting_content_rating = 'adult_18'
    AND NEW.resulting_content_rating <> 'adult_18' THEN
    RAISE EXCEPTION 'text content submission rating cannot be lowered';
  END IF;
  RETURN NEW;
END;
$$;
