-- Select the pinned OpenAI Boolean-category moderation policy and require
-- complete V2 policy evidence for every prospective moderation decision.

ALTER TABLE text_moderation_evidence
  ADD COLUMN applied_input_types JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN input_sha256 TEXT CHECK (
    input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN input_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN evidence_hash TEXT CHECK (
    evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN community_id TEXT,
  ADD COLUMN policy_revision_id TEXT,
  ADD COLUMN policy_hash TEXT CHECK (
    policy_hash IS NULL OR policy_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN platform_policy_revision_id TEXT,
  ADD COLUMN platform_policy_hash TEXT CHECK (
    platform_policy_hash IS NULL OR platform_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN community_policy_revision_id TEXT,
  ADD COLUMN community_policy_hash TEXT CHECK (
    community_policy_hash IS NULL OR community_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT text_moderation_evidence_applied_types_object CHECK (
    jsonb_typeof(applied_input_types) = 'object'
  ),
  ADD CONSTRAINT text_moderation_evidence_input_hashes_array CHECK (
    jsonb_typeof(input_hashes) = 'array'
  ),
  ADD CONSTRAINT text_moderation_evidence_v2_shape CHECK (
    num_nonnulls(
      input_sha256,
      evidence_hash,
      community_id,
      policy_revision_id,
      policy_hash,
      platform_policy_revision_id,
      platform_policy_hash,
      community_policy_revision_id,
      community_policy_hash
    ) IN (0, 9)
  ),
  ADD CONSTRAINT text_moderation_evidence_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  ADD CONSTRAINT text_moderation_evidence_provider_policy_fk
    FOREIGN KEY (policy_revision_id, policy_hash)
    REFERENCES text_moderation_policy_revisions (policy_revision_id, policy_hash)
    MATCH FULL,
  ADD CONSTRAINT text_moderation_evidence_platform_policy_fk
    FOREIGN KEY (platform_policy_revision_id, platform_policy_hash)
    REFERENCES moderation_platform_floor_revisions (policy_revision_id, policy_hash)
    MATCH FULL,
  ADD CONSTRAINT text_moderation_evidence_community_policy_fk
    FOREIGN KEY (
      community_id,
      community_policy_revision_id,
      community_policy_hash
    ) REFERENCES community_moderation_policy_revisions (
      community_id,
      policy_revision_id,
      policy_hash
    ) MATCH FULL;

ALTER TABLE text_content_submissions
  ADD CONSTRAINT text_content_submissions_v2_evidence_shape CHECK (
    platform_policy_revision_id IS NULL
    OR (
      internal_reason_codes ?| ARRAY[
        'provider_unavailable', 'provider_timeout', 'provider_invalid'
      ]
      AND evidence_ref IS NULL
    )
    OR (
      NOT (
        internal_reason_codes ?| ARRAY[
          'provider_unavailable', 'provider_timeout', 'provider_invalid'
        ]
      )
      AND evidence_ref IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION require_text_moderation_v2_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_provider_policy TEXT;
BEGIN
  SELECT policy_revision_id INTO current_provider_policy
    FROM text_moderation_policy_current
   WHERE singleton = TRUE;
  IF current_provider_policy = 'text-moderation-policy-openai-omni-2024-09-26-v1'
    AND num_nonnulls(
      NEW.platform_policy_revision_id,
      NEW.platform_policy_hash,
      NEW.community_policy_revision_id,
      NEW.community_policy_hash
    ) <> 4
  THEN
    RAISE EXCEPTION 'new text moderation submissions require complete V2 policy evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_content_submissions_require_v2
BEFORE INSERT ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION require_text_moderation_v2_submission();

CREATE OR REPLACE FUNCTION require_text_moderation_v2_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_provider_policy TEXT;
BEGIN
  SELECT policy_revision_id INTO current_provider_policy
    FROM text_moderation_policy_current
   WHERE singleton = TRUE;
  IF current_provider_policy = 'text-moderation-policy-openai-omni-2024-09-26-v1'
    AND num_nonnulls(
      NEW.platform_policy_revision_id,
      NEW.platform_policy_hash,
      NEW.community_policy_revision_id,
      NEW.community_policy_hash
    ) <> 4
  THEN
    RAISE EXCEPTION 'new text moderation cases require complete V2 policy evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_moderation_cases_require_v2
BEFORE INSERT ON text_moderation_cases
FOR EACH ROW EXECUTE FUNCTION require_text_moderation_v2_case();

CREATE OR REPLACE FUNCTION require_text_moderation_v2_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_provider_policy TEXT;
BEGIN
  SELECT policy_revision_id INTO current_provider_policy
    FROM text_moderation_policy_current
   WHERE singleton = TRUE;
  IF current_provider_policy = 'text-moderation-policy-openai-omni-2024-09-26-v1'
    AND num_nonnulls(
      NEW.input_sha256,
      NEW.evidence_hash,
      NEW.community_id,
      NEW.policy_revision_id,
      NEW.policy_hash,
      NEW.platform_policy_revision_id,
      NEW.platform_policy_hash,
      NEW.community_policy_revision_id,
      NEW.community_policy_hash
    ) <> 9
  THEN
    RAISE EXCEPTION 'new text moderation evidence requires complete V2 policy evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_moderation_evidence_require_v2
BEFORE INSERT ON text_moderation_evidence
FOR EACH ROW EXECUTE FUNCTION require_text_moderation_v2_evidence();

DO $$
DECLARE
  pinned_policy CONSTANT TEXT :=
    'text-moderation-policy-openai-omni-2024-09-26-v1';
  expected_hash TEXT;
  prior_policy TEXT;
  selected_policy TEXT;
BEGIN
  SELECT policy_hash INTO expected_hash
    FROM text_moderation_policy_revisions
   WHERE policy_revision_id = pinned_policy
     AND provider_id = 'openai'
     AND model_identifier = 'omni-moderation-2024-09-26'
     AND base_url_origin = 'https://api.openai.com/v1'
     AND timeout_ms = 10000
     AND normalization_revision = 'text-moderation-input-v1'
     AND decision_mapper_revision = 'openai-boolean-categories-v1';
  IF expected_hash IS NULL THEN
    RAISE EXCEPTION 'pinned OpenAI moderation policy is missing or invalid';
  END IF;

  SELECT policy_revision_id INTO prior_policy
    FROM text_moderation_policy_current
   WHERE singleton = TRUE
   FOR UPDATE;
  IF prior_policy IS NULL THEN
    RAISE EXCEPTION 'text moderation policy pointer is missing';
  END IF;
  IF prior_policy NOT IN ('text-moderation-policy-v1', pinned_policy) THEN
    RAISE EXCEPTION 'unexpected text moderation policy at cutover: %', prior_policy;
  END IF;

  UPDATE text_moderation_policy_current
     SET policy_revision_id = pinned_policy,
         updated_at = CASE
           WHEN policy_revision_id = pinned_policy THEN updated_at
           ELSE clock_timestamp()
         END
   WHERE singleton = TRUE;

  SELECT policy_revision_id INTO selected_policy
    FROM text_moderation_policy_current
   WHERE singleton = TRUE;
  IF selected_policy IS DISTINCT FROM pinned_policy THEN
    RAISE EXCEPTION 'pinned OpenAI moderation policy cutover failed';
  END IF;
END;
$$;

COMMENT ON COLUMN text_moderation_evidence.response_sha256 IS
  'For V2 rows this repeats evidence_hash over normalized restricted evidence; raw provider payloads are not retained.';
