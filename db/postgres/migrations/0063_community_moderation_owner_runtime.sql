-- Owner-only community moderation runtime and V2 case/action cutover.

CREATE OR REPLACE FUNCTION has_community_moderation_capability_v1(
  input_account_id TEXT,
  input_community_id TEXT,
  input_capability TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT input_capability IN ('moderation.view', 'moderation.act')
    AND EXISTS (
      SELECT 1
        FROM community_role_assignments AS assignment
        JOIN communities AS community
          ON community.community_id = assignment.community_id
         AND community.status = 'active'
        JOIN users AS account
          ON account.user_id = assignment.account_id
         AND account.status = 'active'
       WHERE assignment.community_id = input_community_id
         AND assignment.account_id = input_account_id
         AND assignment.role = 'owner'
         AND assignment.status = 'active'
    );
$$;

ALTER TABLE text_content_submissions
  ADD COLUMN author_declared_rating TEXT,
  ADD COLUMN resulting_content_rating TEXT,
  ADD COLUMN matched_categories JSONB,
  ADD COLUMN category_decisions JSONB,
  ADD COLUMN effective_policy_decision TEXT,
  ADD CONSTRAINT text_content_submissions_v2_decision_evidence_shape CHECK (
    num_nonnulls(
      author_declared_rating,
      resulting_content_rating,
      matched_categories,
      category_decisions,
      effective_policy_decision
    ) IN (0, 5)
    AND (
      author_declared_rating IS NULL
      OR (
        author_declared_rating IN ('general', 'adult_18')
        AND resulting_content_rating IN ('general', 'adult_18')
        AND jsonb_typeof(matched_categories) = 'array'
        AND jsonb_typeof(category_decisions) = 'object'
        AND effective_policy_decision IN ('permit', 'review', 'block')
      )
    )
  );

CREATE OR REPLACE FUNCTION require_text_submission_v2_decision_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.platform_policy_revision_id IS NOT NULL
    AND num_nonnulls(
      NEW.author_declared_rating,
      NEW.resulting_content_rating,
      NEW.matched_categories,
      NEW.category_decisions,
      NEW.effective_policy_decision
    ) <> 5
  THEN
    RAISE EXCEPTION 'V2 text submission requires complete decision evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_content_submissions_v2_decision_evidence_guard
BEFORE INSERT ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION require_text_submission_v2_decision_evidence();

CREATE OR REPLACE FUNCTION guard_text_content_submission_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id,
    NEW.submission_id,
    NEW.operation_id,
    NEW.actor_user_id,
    NEW.author_persona_id,
    NEW.surface,
    NEW.target_post_id,
    NEW.target_parent_comment_id,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.moderation_decision,
    NEW.policy_revision_id,
    NEW.policy_hash,
    NEW.platform_policy_revision_id,
    NEW.platform_policy_hash,
    NEW.community_policy_revision_id,
    NEW.community_policy_hash,
    NEW.input_sha256,
    NEW.internal_reason_codes,
    NEW.evidence_ref,
    NEW.author_declared_rating,
    NEW.resulting_content_rating,
    NEW.matched_categories,
    NEW.category_decisions,
    NEW.effective_policy_decision,
    NEW.created_at,
    NEW.response_snapshot_bytes,
    NEW.response_snapshot_sha256
  ) IS DISTINCT FROM ROW(
    OLD.community_id,
    OLD.submission_id,
    OLD.operation_id,
    OLD.actor_user_id,
    OLD.author_persona_id,
    OLD.surface,
    OLD.target_post_id,
    OLD.target_parent_comment_id,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.moderation_decision,
    OLD.policy_revision_id,
    OLD.policy_hash,
    OLD.platform_policy_revision_id,
    OLD.platform_policy_hash,
    OLD.community_policy_revision_id,
    OLD.community_policy_hash,
    OLD.input_sha256,
    OLD.internal_reason_codes,
    OLD.evidence_ref,
    OLD.author_declared_rating,
    OLD.resulting_content_rating,
    OLD.matched_categories,
    OLD.category_decisions,
    OLD.effective_policy_decision,
    OLD.created_at,
    OLD.response_snapshot_bytes,
    OLD.response_snapshot_sha256
  ) THEN
    RAISE EXCEPTION 'text content submission evidence and creation snapshot are immutable';
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

CREATE TABLE community_moderation_cases_v2 (
  case_ref TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  submission_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('text_post', 'comment', 'reply')),
  target_resource_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('automatic', 'member_report', 'mixed', 'platform_held')),
  visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'platform')),
  view_state TEXT NOT NULL CHECK (view_state IN ('open', 'hidden', 'resolved', 'platform_held')),
  target_status TEXT NOT NULL CHECK (target_status IN ('held', 'published', 'hidden', 'blocked')),
  case_revision BIGINT NOT NULL DEFAULT 1 CHECK (case_revision > 0),
  last_action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_moderation_cases_v2_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT community_moderation_cases_v2_identity_not_blank CHECK (
    btrim(case_ref) <> '' AND case_ref = btrim(case_ref)
  ),
  CONSTRAINT community_moderation_cases_v2_visibility_shape CHECK (
    (visibility = 'platform' AND source = 'platform_held' AND view_state = 'platform_held')
    OR (visibility = 'owner' AND source <> 'platform_held' AND view_state <> 'platform_held')
  ),
  CONSTRAINT community_moderation_cases_v2_view_shape CHECK (
    (view_state = 'open' AND target_status IN ('held', 'published'))
    OR (view_state = 'hidden' AND target_status = 'hidden')
    OR (view_state = 'resolved' AND target_status IN ('published', 'blocked'))
    OR (view_state = 'platform_held' AND target_status = 'blocked')
  ),
  CONSTRAINT community_moderation_cases_v2_time_order CHECK (updated_at >= created_at),
  CONSTRAINT community_moderation_cases_v2_community_ref_unique UNIQUE (community_id, case_ref)
);

CREATE UNIQUE INDEX community_moderation_cases_v2_active_submission_uidx
  ON community_moderation_cases_v2 (submission_id)
  WHERE view_state IN ('open', 'hidden', 'platform_held');

CREATE INDEX community_moderation_cases_v2_owner_queue_idx
  ON community_moderation_cases_v2 (community_id, view_state, updated_at DESC, case_ref)
  WHERE visibility = 'owner' AND view_state IN ('open', 'hidden');

CREATE TABLE community_content_reports_v2 (
  report_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_resource_id TEXT NOT NULL,
  case_ref TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL REFERENCES users (user_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'spam', 'harassment', 'hate', 'sexual_content',
      'graphic_content', 'misleading', 'other'
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'coalesced')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_content_reports_v2_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT community_content_reports_v2_case_fk
    FOREIGN KEY (community_id, case_ref)
    REFERENCES community_moderation_cases_v2 (community_id, case_ref),
  CONSTRAINT community_content_reports_v2_reporter_key_unique
    UNIQUE (reporter_user_id, target_type, target_resource_id, idempotency_key)
);

CREATE TABLE community_moderation_actions_v2 (
  action_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  case_ref TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users (user_id),
  owner_role_assignment_id TEXT NOT NULL REFERENCES community_role_assignments (role_assignment_id),
  presenting_persona_id TEXT NOT NULL REFERENCES personas (persona_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expected_case_revision BIGINT NOT NULL CHECK (expected_case_revision > 0),
  action TEXT NOT NULL CHECK (action IN (
    'approve_as_general', 'approve_as_adult_18', 'reject',
    'dismiss_report', 'hide', 'raise_rating_to_adult_18', 'restore'
  )),
  before_view_state TEXT NOT NULL CHECK (before_view_state IN ('open', 'hidden')),
  after_view_state TEXT NOT NULL CHECK (after_view_state IN ('hidden', 'resolved')),
  before_target_status TEXT NOT NULL CHECK (before_target_status IN ('held', 'published', 'hidden')),
  after_target_status TEXT NOT NULL CHECK (after_target_status IN ('published', 'hidden', 'blocked')),
  before_rating TEXT NOT NULL CHECK (before_rating IN ('general', 'adult_18')),
  after_rating TEXT NOT NULL CHECK (after_rating IN ('general', 'adult_18')),
  platform_policy_revision_id TEXT NOT NULL,
  platform_policy_hash TEXT NOT NULL CHECK (platform_policy_hash ~ '^[0-9a-f]{64}$'),
  community_policy_revision_id TEXT NOT NULL,
  community_policy_hash TEXT NOT NULL CHECK (community_policy_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT,
  resolved_age_capability TEXT NOT NULL CHECK (
    resolved_age_capability = 'unavailable_owner_only_mvp'
  ),
  response_snapshot_bytes BYTEA NOT NULL CHECK (octet_length(response_snapshot_bytes) > 0),
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_moderation_actions_v2_case_fk
    FOREIGN KEY (community_id, case_ref)
    REFERENCES community_moderation_cases_v2 (community_id, case_ref),
  CONSTRAINT community_moderation_actions_v2_response_hash CHECK (
    encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT community_moderation_actions_v2_actor_key_unique
    UNIQUE (case_ref, actor_user_id, idempotency_key)
);

ALTER TABLE community_moderation_cases_v2
  ADD CONSTRAINT community_moderation_cases_v2_last_action_fk
  FOREIGN KEY (last_action_id) REFERENCES community_moderation_actions_v2 (action_id);

CREATE OR REPLACE FUNCTION guard_community_moderation_action_v2_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_case community_moderation_cases_v2%ROWTYPE;
  rating TEXT;
BEGIN
  SELECT * INTO target_case
    FROM community_moderation_cases_v2
   WHERE community_id = NEW.community_id
     AND case_ref = NEW.case_ref
   FOR UPDATE;
  IF NOT FOUND
    OR target_case.visibility <> 'owner'
    OR target_case.view_state NOT IN ('open', 'hidden')
  THEN
    RAISE EXCEPTION 'moderation case is not owner-actionable';
  END IF;
  IF NOT has_community_moderation_capability_v1(
    NEW.actor_user_id,
    NEW.community_id,
    'moderation.act'
  ) THEN
    RAISE EXCEPTION 'moderation action requires active owner authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM community_role_assignments AS assignment
     WHERE assignment.role_assignment_id = NEW.owner_role_assignment_id
       AND assignment.community_id = NEW.community_id
       AND assignment.account_id = NEW.actor_user_id
       AND assignment.role = 'owner'
       AND assignment.status = 'active'
  ) THEN
    RAISE EXCEPTION 'moderation action owner snapshot is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM personas AS persona
     WHERE persona.persona_id = NEW.presenting_persona_id
       AND persona.account_id = NEW.actor_user_id
       AND persona.status = 'active'
  ) THEN
    RAISE EXCEPTION 'moderation action presenting persona is invalid';
  END IF;
  SELECT COALESCE(submission.resulting_content_rating, 'adult_18')
    INTO rating
    FROM text_content_submissions AS submission
   WHERE submission.community_id = target_case.community_id
     AND submission.submission_id = target_case.submission_id;
  IF NEW.expected_case_revision <> target_case.case_revision
    OR NEW.before_view_state <> target_case.view_state
    OR NEW.before_target_status <> target_case.target_status
    OR NEW.before_rating <> rating
  THEN
    RAISE EXCEPTION 'moderation action case revision is stale';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM text_content_submissions AS submission
     WHERE submission.community_id = target_case.community_id
       AND submission.submission_id = target_case.submission_id
       AND submission.platform_policy_revision_id = NEW.platform_policy_revision_id
       AND submission.platform_policy_hash = NEW.platform_policy_hash
       AND submission.community_policy_revision_id = NEW.community_policy_revision_id
       AND submission.community_policy_hash = NEW.community_policy_hash
       AND submission.evidence_ref IS NOT DISTINCT FROM NEW.evidence_ref
  ) THEN
    RAISE EXCEPTION 'moderation action policy evidence snapshot is invalid';
  END IF;
  IF NEW.action IN ('approve_as_adult_18', 'raise_rating_to_adult_18') THEN
    RAISE EXCEPTION 'adult rating actions require the rating projection lane';
  END IF;
  IF rating = 'adult_18' AND NEW.action NOT IN ('hide', 'reject') THEN
    RAISE EXCEPTION 'adult moderation action fails closed';
  END IF;
  IF NOT (
    (NEW.action = 'approve_as_general'
      AND target_case.view_state = 'open'
      AND target_case.target_status = 'held'
      AND rating = 'general'
      AND NEW.after_view_state = 'resolved'
      AND NEW.after_target_status = 'published'
      AND NEW.after_rating = 'general')
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

CREATE TRIGGER community_moderation_actions_v2_insert_guard
BEFORE INSERT ON community_moderation_actions_v2
FOR EACH ROW EXECUTE FUNCTION guard_community_moderation_action_v2_insert();

CREATE OR REPLACE FUNCTION guard_community_moderation_case_v2_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.case_ref,
    NEW.community_id,
    NEW.submission_id,
    NEW.target_type,
    NEW.source,
    NEW.visibility,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.case_ref,
    OLD.community_id,
    OLD.submission_id,
    OLD.target_type,
    OLD.source,
    OLD.visibility,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community moderation case identity is immutable';
  END IF;
  IF OLD.visibility <> 'owner'
    OR OLD.view_state NOT IN ('open', 'hidden')
    OR NEW.case_revision <> OLD.case_revision + 1
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.last_action_id IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM community_moderation_actions_v2 AS action
       WHERE action.action_id = NEW.last_action_id
         AND action.community_id = OLD.community_id
         AND action.case_ref = OLD.case_ref
         AND action.expected_case_revision = OLD.case_revision
         AND action.before_view_state = OLD.view_state
         AND action.after_view_state = NEW.view_state
         AND action.before_target_status = OLD.target_status
         AND action.after_target_status = NEW.target_status
         AND action.created_at = NEW.updated_at
    )
  THEN
    RAISE EXCEPTION 'community moderation case transition lacks its exact action';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_moderation_cases_v2_update_guard
BEFORE UPDATE ON community_moderation_cases_v2
FOR EACH ROW EXECUTE FUNCTION guard_community_moderation_case_v2_update();

CREATE OR REPLACE FUNCTION reject_community_moderation_v2_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_moderation_cases_v2_delete_guard
BEFORE DELETE ON community_moderation_cases_v2
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_v2_delete();
CREATE TRIGGER community_content_reports_v2_change_guard
BEFORE UPDATE OR DELETE ON community_content_reports_v2
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_v2_delete();
CREATE TRIGGER community_moderation_actions_v2_change_guard
BEFORE UPDATE OR DELETE ON community_moderation_actions_v2
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_v2_delete();

ALTER TABLE comment_moderation_actions
  ADD COLUMN response_snapshot_bytes BYTEA,
  ADD COLUMN response_snapshot_sha256 TEXT;

UPDATE comment_moderation_actions
   SET response_snapshot_bytes = convert_to(format(
         '{"action_id":%s,"case_ref":%s,"action":%s,"target_status":%s}',
         to_json(action_id)::text,
         to_json(case_ref)::text,
         to_json(action)::text,
         to_json(target_status)::text
       ), 'UTF8');

UPDATE comment_moderation_actions
   SET response_snapshot_sha256 = encode(sha256(response_snapshot_bytes), 'hex');

ALTER TABLE comment_moderation_actions
  ALTER COLUMN response_snapshot_bytes SET NOT NULL,
  ALTER COLUMN response_snapshot_sha256 SET NOT NULL,
  ADD CONSTRAINT comment_moderation_actions_response_snapshot_nonempty
    CHECK (octet_length(response_snapshot_bytes) > 0),
  ADD CONSTRAINT comment_moderation_actions_response_snapshot_sha256_check
    CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT comment_moderation_actions_response_snapshot_hash
    CHECK (encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256);

CREATE TABLE community_moderation_system_actions_v1 (
  action_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action = 'legacy_removed_normalized_to_hidden'),
  community_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('text_post', 'comment')),
  target_resource_id TEXT NOT NULL,
  before_status TEXT NOT NULL CHECK (before_status = 'removed'),
  after_status TEXT NOT NULL CHECK (after_status = 'hidden'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (target_type, target_resource_id)
);

INSERT INTO community_moderation_system_actions_v1 (
  action_id, action, community_id, target_type, target_resource_id,
  before_status, after_status
)
SELECT
  'moderation-system:legacy-removed:' || comment.comment_id,
  'legacy_removed_normalized_to_hidden',
  comment.community_id,
  'comment',
  comment.comment_id,
  'removed',
  'hidden'
FROM comments AS comment
WHERE comment.status = 'removed';

UPDATE comment_publication_projection
   SET status = 'hidden', updated_at = clock_timestamp()
 WHERE status = 'removed';
UPDATE comments
   SET status = 'hidden', updated_at = clock_timestamp()
 WHERE status = 'removed';

INSERT INTO community_moderation_system_actions_v1 (
  action_id, action, community_id, target_type, target_resource_id,
  before_status, after_status
)
SELECT
  'moderation-system:legacy-removed:' || post.post_id,
  'legacy_removed_normalized_to_hidden',
  post.community_id,
  'text_post',
  post.post_id,
  'removed',
  'hidden'
FROM posts AS post
WHERE post.status = 'removed';

DELETE FROM home_feed_projection AS projection
USING posts AS post
WHERE projection.community_id = post.community_id
  AND projection.post_id = post.post_id
  AND post.status = 'removed';
UPDATE posts
   SET status = 'hidden', updated_at = clock_timestamp()
 WHERE status = 'removed';

CREATE TRIGGER community_moderation_system_actions_v1_change_guard
BEFORE UPDATE OR DELETE ON community_moderation_system_actions_v1
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_v2_delete();

INSERT INTO community_moderation_cases_v2 (
  case_ref, community_id, submission_id, target_type, target_resource_id,
  source, visibility, view_state, target_status, case_revision, created_at, updated_at
)
SELECT
  text_case.case_id,
  text_case.community_id,
  text_case.submission_id,
  submission.surface,
  COALESCE(submission.published_post_id, submission.published_comment_id),
  'automatic',
  'owner',
  'open',
  'held',
  1,
  text_case.created_at,
  text_case.updated_at
FROM text_moderation_cases AS text_case
JOIN text_content_submissions AS submission
  ON submission.community_id = text_case.community_id
 AND submission.submission_id = text_case.submission_id
WHERE text_case.status = 'open'
  AND submission.status = 'manual_review'
ON CONFLICT (case_ref) DO NOTHING;

INSERT INTO community_moderation_cases_v2 (
  case_ref, community_id, submission_id, target_type, target_resource_id,
  source, visibility, view_state, target_status, case_revision, created_at, updated_at
)
SELECT
  comment_case.case_ref,
  comment_case.community_id,
  comment_case.submission_id,
  submission.surface,
  comment_case.comment_id,
  'member_report',
  'owner',
  CASE WHEN comment.status = 'hidden' THEN 'hidden' ELSE 'open' END,
  CASE WHEN comment.status = 'hidden' THEN 'hidden' ELSE 'published' END,
  1,
  comment_case.created_at,
  comment_case.updated_at
FROM comment_moderation_cases AS comment_case
JOIN text_content_submissions AS submission
  ON submission.community_id = comment_case.community_id
 AND submission.submission_id = comment_case.submission_id
JOIN comments AS comment
  ON comment.community_id = comment_case.community_id
 AND comment.comment_id = comment_case.comment_id
WHERE comment_case.source = 'report'
  AND comment.status IN ('published', 'hidden')
  AND NOT EXISTS (
    SELECT 1
      FROM community_moderation_cases_v2 AS current_case
     WHERE current_case.submission_id = comment_case.submission_id
       AND current_case.view_state IN ('open', 'hidden', 'platform_held')
  )
ON CONFLICT (case_ref) DO NOTHING;

INSERT INTO community_moderation_cases_v2 (
  case_ref, community_id, submission_id, target_type, target_resource_id,
  source, visibility, view_state, target_status, case_revision, created_at, updated_at
)
SELECT
  'platform-hold:' || submission.submission_id,
  submission.community_id,
  submission.submission_id,
  submission.surface,
  NULL,
  'platform_held',
  'platform',
  'platform_held',
  'blocked',
  1,
  submission.created_at,
  submission.updated_at
FROM text_content_submissions AS submission
WHERE submission.status = 'blocked'
  AND submission.internal_reason_codes ? 'sexual_minors'
ON CONFLICT (case_ref) DO NOTHING;

CREATE TYPE community_moderation_policy_update_result_v1 AS (
  outcome TEXT,
  policy_revision_id TEXT
);

CREATE OR REPLACE FUNCTION create_community_moderation_policy_revision_v1(
  input_account_id TEXT,
  input_community_id TEXT,
  input_expected_policy_revision TEXT,
  input_decisions JSONB
)
RETURNS community_moderation_policy_update_result_v1
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision community_moderation_policy_current%ROWTYPE;
  floor_revision moderation_platform_floor_current%ROWTYPE;
  next_revision BIGINT;
  next_revision_id TEXT;
  next_preimage TEXT;
  next_hash TEXT;
  created_at TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM communities WHERE community_id = input_community_id FOR UPDATE;
  IF NOT FOUND OR NOT has_community_moderation_capability_v1(
    input_account_id,
    input_community_id,
    'moderation.act'
  ) THEN
    RETURN ('not_found', NULL)::community_moderation_policy_update_result_v1;
  END IF;
  SELECT * INTO current_revision
    FROM community_moderation_policy_current
   WHERE community_id = input_community_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN ('not_found', NULL)::community_moderation_policy_update_result_v1;
  END IF;
  IF current_revision.policy_revision_id <> input_expected_policy_revision THEN
    RETURN ('conflict', current_revision.policy_revision_id)::community_moderation_policy_update_result_v1;
  END IF;
  IF jsonb_typeof(input_decisions) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(input_decisions)) <> 13
    OR EXISTS (
      SELECT 1
        FROM jsonb_each_text(input_decisions) AS choice(category, decision)
       WHERE moderation_policy_category_ordinal_v1(choice.category) IS NULL
          OR moderation_policy_decision_severity_v1(choice.decision) IS NULL
    )
    OR EXISTS (
      SELECT 1
        FROM moderation_platform_floor_category_decisions AS floor_choice
       WHERE floor_choice.policy_revision_id = (
         SELECT policy_revision_id FROM moderation_platform_floor_current WHERE singleton
       )
         AND moderation_policy_decision_severity_v1(input_decisions ->> floor_choice.category)
           < moderation_policy_decision_severity_v1(floor_choice.decision)
    )
  THEN
    RETURN ('constraint', NULL)::community_moderation_policy_update_result_v1;
  END IF;
  SELECT * INTO floor_revision
    FROM moderation_platform_floor_current
   WHERE singleton
   FOR SHARE;
  SELECT revision + 1 INTO next_revision
    FROM community_moderation_policy_revisions
   WHERE community_id = input_community_id
     AND policy_revision_id = current_revision.policy_revision_id;
  IF next_revision IS NULL THEN
    RETURN ('not_found', NULL)::community_moderation_policy_update_result_v1;
  END IF;
  next_revision_id := 'community-moderation-policy:' || input_community_id || ':r' || next_revision;
  SELECT format(
    '["community-moderation-policy-v1",%s,%s,%s,%s,%s,[%s]]',
    to_json(input_community_id)::text,
    to_json(next_revision_id)::text,
    next_revision,
    to_json(floor_revision.policy_revision_id)::text,
    to_json(floor_revision.policy_hash)::text,
    string_agg(
      format('[%s,%s]', to_json(choice.category)::text, to_json(choice.decision)::text),
      ',' ORDER BY moderation_policy_category_ordinal_v1(choice.category)
    )
  ) INTO next_preimage
  FROM jsonb_each_text(input_decisions) AS choice(category, decision);
  next_hash := encode(sha256(convert_to(next_preimage, 'UTF8')), 'hex');
  created_at := clock_timestamp();
  INSERT INTO community_moderation_policy_revisions (
    community_id, policy_revision_id, revision,
    platform_floor_revision_id, platform_floor_hash,
    policy_preimage, policy_hash, created_at
  ) VALUES (
    input_community_id, next_revision_id, next_revision,
    floor_revision.policy_revision_id, floor_revision.policy_hash,
    next_preimage, next_hash, created_at
  );
  INSERT INTO community_moderation_policy_category_decisions (
    community_id, policy_revision_id, category, decision
  )
  SELECT input_community_id, next_revision_id, choice.category, choice.decision
    FROM jsonb_each_text(input_decisions) AS choice(category, decision);
  UPDATE community_moderation_policy_current
     SET policy_revision_id = next_revision_id,
         policy_hash = next_hash,
         updated_at = created_at
   WHERE community_id = input_community_id;
  RETURN ('updated', next_revision_id)::community_moderation_policy_update_result_v1;
END;
$$;

CREATE OR REPLACE FUNCTION validate_media_moderation_action_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF NOT has_community_moderation_capability_v1(
    NEW.authority_actor_user_id,
    NEW.community_id,
    'moderation.act'
  ) THEN
    RAISE EXCEPTION 'moderation action requires active owner authority';
  END IF;
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
      AND submission_id = NEW.submission_id AND operation_id = NEW.operation_id
    FOR UPDATE;
  IF submission_record.submission_id IS NULL OR submission_record.status <> 'manual_review'
     OR submission_record.held_revision IS DISTINCT FROM NEW.held_revision
     OR submission_record.review_ref IS NULL THEN
    RAISE EXCEPTION 'moderation action is not bound to a held review';
  END IF;
  IF NEW.held_revision IS DISTINCT FROM submission_record.held_revision THEN
    RAISE EXCEPTION 'moderation held revision does not match';
  END IF;
  IF NEW.action_kind = 'approve' AND (
    NEW.decision_revision IS NULL
    OR NEW.decision_revision <> submission_record.decision_revision + 1
    OR NEW.decision_snapshot IS DISTINCT FROM (
      SELECT decision_snapshot FROM media_publication_decisions
       WHERE community_id = NEW.community_id
         AND actor_user_id = NEW.actor_user_id
         AND submission_id = NEW.submission_id
         AND operation_id = NEW.operation_id
         AND decision_revision = NEW.decision_revision
    )
  ) THEN
    RAISE EXCEPTION 'moderation approval decision revision is not current';
  END IF;
  IF NEW.action_kind = 'approve' AND (
    SELECT acr_decision FROM media_analysis_evidence
     WHERE community_id = NEW.community_id
       AND actor_user_id = NEW.actor_user_id
       AND submission_id = NEW.submission_id
       AND operation_id = NEW.operation_id
       AND analysis_revision = submission_record.analysis_revision
  ) = 'inconclusive' AND (
    NEW.approval_kind IS DISTINCT FROM 'acr_override'
    OR NEW.reason_code IS DISTINCT FROM CASE
      WHEN submission_record.review_exhaustion_code = 'acr_exhausted'
      THEN 'acr_exhausted' ELSE 'acr_inconclusive' END
  ) THEN
    RAISE EXCEPTION 'inconclusive ACR moderation mapping is not exact';
  END IF;
  IF NEW.action_kind = 'approve' AND (
    SELECT acr_decision FROM media_analysis_evidence
     WHERE community_id = NEW.community_id
       AND actor_user_id = NEW.actor_user_id
       AND submission_id = NEW.submission_id
       AND operation_id = NEW.operation_id
       AND analysis_revision = submission_record.analysis_revision
  ) = 'skipped' AND (
    NEW.approval_kind IS DISTINCT FROM 'acr_override'
    OR NEW.reason_code IS DISTINCT FROM 'acr_skipped'
  ) THEN
    RAISE EXCEPTION 'skipped ACR moderation mapping is not exact';
  END IF;
  IF NEW.action_kind = 'approve' AND (
    SELECT acr_decision FROM media_analysis_evidence
     WHERE community_id = NEW.community_id
       AND actor_user_id = NEW.actor_user_id
       AND submission_id = NEW.submission_id
       AND operation_id = NEW.operation_id
       AND analysis_revision = submission_record.analysis_revision
  ) = 'allow' AND (
    NEW.approval_kind IS DISTINCT FROM 'standard' OR NEW.reason_code IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'allow ACR moderation mapping is not exact';
  END IF;
  IF NEW.action_kind = 'approve'
    AND NEW.reason_code = 'acr_exhausted'
    AND submission_record.review_exhaustion_code IS DISTINCT FROM 'acr_exhausted'
  THEN
    RAISE EXCEPTION 'ACR exhaustion override lacks its private exhaustion hold';
  END IF;
  RETURN NEW;
END;
$$;
