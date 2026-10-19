-- Report actions preserve the original publication provenance. Author-declared
-- text has no provider policy snapshot; moderated text still requires all four
-- policy fields and an exact match to its immutable submission.
ALTER TABLE community_moderation_actions_v2
  ALTER COLUMN platform_policy_revision_id DROP NOT NULL,
  ALTER COLUMN platform_policy_hash DROP NOT NULL,
  ALTER COLUMN community_policy_revision_id DROP NOT NULL,
  ALTER COLUMN community_policy_hash DROP NOT NULL,
  ADD CONSTRAINT community_moderation_action_policy_shape CHECK (
    num_nonnulls(platform_policy_revision_id, platform_policy_hash,
      community_policy_revision_id, community_policy_hash) = 4
    OR (num_nonnulls(platform_policy_revision_id, platform_policy_hash,
      community_policy_revision_id, community_policy_hash) = 0 AND evidence_ref IS NULL)
  );

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
  IF (submission.publication_mode = 'author_declared' AND (
      num_nonnulls(submission.policy_revision_id, submission.policy_hash,
        submission.platform_policy_revision_id, submission.platform_policy_hash,
        submission.community_policy_revision_id, submission.community_policy_hash,
        submission.evidence_ref) <> 0
      OR num_nonnulls(NEW.platform_policy_revision_id, NEW.platform_policy_hash,
        NEW.community_policy_revision_id, NEW.community_policy_hash, NEW.evidence_ref) <> 0
    )) OR (submission.publication_mode = 'moderated' AND (
      num_nonnulls(submission.platform_policy_revision_id, submission.platform_policy_hash,
        submission.community_policy_revision_id, submission.community_policy_hash) <> 4
      OR submission.platform_policy_revision_id IS DISTINCT FROM NEW.platform_policy_revision_id
      OR submission.platform_policy_hash IS DISTINCT FROM NEW.platform_policy_hash
      OR submission.community_policy_revision_id IS DISTINCT FROM NEW.community_policy_revision_id
      OR submission.community_policy_hash IS DISTINCT FROM NEW.community_policy_hash
      OR submission.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    )) THEN
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
