-- Durable text moderation policy, evidence, submission, and held-review state.
-- Provider calls happen outside transactions; these tables contain only the
-- normalized decision evidence committed with the resulting submission.

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
