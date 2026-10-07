-- New text submissions publish from the author declaration, without provider
-- evidence. Historical moderated decisions and their guards remain intact.
ALTER TABLE text_content_submissions
  ADD COLUMN publication_mode TEXT NOT NULL DEFAULT 'moderated'
    CHECK (publication_mode IN ('moderated', 'author_declared')),
  ALTER COLUMN policy_revision_id DROP NOT NULL,
  ALTER COLUMN policy_hash DROP NOT NULL,
  ADD CONSTRAINT text_submission_publication_mode_shape CHECK (
    (publication_mode = 'moderated'
      AND policy_revision_id IS NOT NULL AND policy_hash IS NOT NULL)
    OR (publication_mode = 'author_declared'
      AND num_nonnulls(author_declared_rating, resulting_content_rating,
        matched_categories, category_decisions, effective_policy_decision) = 5
      AND status = 'published' AND moderation_decision = 'allow'
      AND public_reason_code IS NULL AND review_ref IS NULL
      AND evidence_ref IS NULL AND internal_reason_codes = '[]'::jsonb
      AND matched_categories = '[]'::jsonb AND category_decisions = '{}'::jsonb
      AND effective_policy_decision = 'permit'
      AND num_nonnulls(policy_revision_id, policy_hash,
        platform_policy_revision_id, platform_policy_hash,
        community_policy_revision_id, community_policy_hash) = 0)
  );

CREATE OR REPLACE FUNCTION require_text_moderation_v2_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_provider_policy TEXT;
BEGIN
  IF NEW.publication_mode = 'author_declared' THEN
    IF NEW.resulting_content_rating IS DISTINCT FROM NEW.author_declared_rating THEN
      RAISE EXCEPTION 'unmoderated publication must retain the author declared rating';
    END IF;
    RETURN NEW;
  END IF;
  SELECT policy_revision_id INTO current_provider_policy
    FROM text_moderation_policy_current WHERE singleton = TRUE;
  IF current_provider_policy = 'text-moderation-policy-openai-omni-2024-09-26-v1'
    AND num_nonnulls(NEW.platform_policy_revision_id, NEW.platform_policy_hash,
      NEW.community_policy_revision_id, NEW.community_policy_hash) <> 4
  THEN
    RAISE EXCEPTION 'new text moderation submissions require complete V2 policy evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_text_publication_mode_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.publication_mode <> OLD.publication_mode THEN
    RAISE EXCEPTION 'text publication mode is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_publication_mode_update_guard
BEFORE UPDATE OF publication_mode ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION guard_text_publication_mode_update();
