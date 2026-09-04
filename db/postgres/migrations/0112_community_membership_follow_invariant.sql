-- An active Community membership always carries one active account-scoped
-- follow (spec 016). Repair pre-invariant rows first, preserving the identity
-- and creation time of an existing follow and creating only missing pairs.

UPDATE community_follows AS follow
   SET status = 'active',
       unfollowed_at = NULL,
       updated_at = clock_timestamp()
  FROM community_memberships AS membership
 WHERE membership.community_id = follow.community_id
   AND membership.user_id = follow.user_id
   AND membership.status = 'member'
   AND follow.status <> 'active';

INSERT INTO community_follows (
  community_follow_id, community_id, user_id, status,
  unfollowed_at, created_at, updated_at
)
SELECT 'follow_repair_' || encode(
         sha256(convert_to(membership.community_id || chr(31) || membership.user_id, 'UTF8')),
         'hex'
       ),
       membership.community_id,
       membership.user_id,
       'active',
       NULL,
       COALESCE(membership.joined_at, membership.created_at),
       clock_timestamp()
  FROM community_memberships AS membership
 WHERE membership.status = 'member'
   AND NOT EXISTS (
     SELECT 1
       FROM community_follows AS follow
      WHERE follow.community_id = membership.community_id
        AND follow.user_id = membership.user_id
   );

CREATE FUNCTION require_active_membership_follow_pair_v1(
  expected_community_id TEXT,
  expected_user_id TEXT
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM community_memberships AS membership
     WHERE membership.community_id = expected_community_id
       AND membership.user_id = expected_user_id
       AND membership.status = 'member'
  ) AND NOT EXISTS (
    SELECT 1
      FROM community_follows AS follow
     WHERE follow.community_id = expected_community_id
       AND follow.user_id = expected_user_id
       AND follow.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active Community membership requires an active follow'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_membership_active_follow_guard_v1';
  END IF;
END;
$$;

CREATE FUNCTION validate_active_membership_follow_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM require_active_membership_follow_pair_v1(OLD.community_id, OLD.user_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR OLD.community_id IS DISTINCT FROM NEW.community_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
  ) THEN
    PERFORM require_active_membership_follow_pair_v1(NEW.community_id, NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_memberships_active_follow_guard
AFTER INSERT OR UPDATE OR DELETE ON community_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_active_membership_follow_v1();

CREATE CONSTRAINT TRIGGER community_follows_active_membership_guard
AFTER INSERT OR UPDATE OR DELETE ON community_follows
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_active_membership_follow_v1();
