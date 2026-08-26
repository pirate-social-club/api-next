-- Community moderation authority and provider-independent policy revisions.
-- This migration establishes prospective V2 evidence without selecting the
-- pinned provider policy or changing any historical V1 evaluation.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM communities AS community
      LEFT JOIN users AS creator
        ON creator.user_id = community.created_by_user_id
     WHERE community.created_by_user_id IS NULL
        OR btrim(community.created_by_user_id) = ''
        OR creator.user_id IS NULL
        OR creator.status = 'deleted'
  ) THEN
    RAISE EXCEPTION 'community moderation owner backfill preflight failed';
  END IF;
END;
$$;

CREATE TABLE community_role_assignments (
  role_assignment_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deactivated_at TIMESTAMPTZ,
  CONSTRAINT community_role_assignments_identity_not_blank CHECK (
    btrim(role_assignment_id) <> ''
    AND role_assignment_id = btrim(role_assignment_id)
    AND btrim(community_id) <> ''
    AND community_id = btrim(community_id)
    AND btrim(account_id) <> ''
    AND account_id = btrim(account_id)
  ),
  CONSTRAINT community_role_assignments_status_shape CHECK (
    (status = 'active' AND deactivated_at IS NULL)
    OR (status = 'inactive' AND deactivated_at IS NOT NULL)
  ),
  CONSTRAINT community_role_assignments_time_order CHECK (
    deactivated_at IS NULL OR deactivated_at >= assigned_at
  )
);

INSERT INTO community_role_assignments (
  role_assignment_id,
  community_id,
  account_id,
  role,
  status,
  assigned_at
)
SELECT
  'community-role:' || community.community_id || ':owner:v1',
  community.community_id,
  community.created_by_user_id,
  'owner',
  'active',
  community.created_at
FROM communities AS community;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM communities AS community
      LEFT JOIN community_role_assignments AS assignment
        ON assignment.community_id = community.community_id
       AND assignment.role = 'owner'
       AND assignment.status = 'active'
     GROUP BY community.community_id
    HAVING count(assignment.role_assignment_id) <> 1
  ) THEN
    RAISE EXCEPTION 'community moderation owner backfill invariant failed';
  END IF;
END;
$$;

CREATE UNIQUE INDEX community_role_assignments_one_active_owner_uidx
  ON community_role_assignments (community_id)
  WHERE role = 'owner' AND status = 'active';

CREATE INDEX community_role_assignments_account_status_idx
  ON community_role_assignments (account_id, status, community_id, role_assignment_id);

CREATE OR REPLACE FUNCTION initialize_community_owner_v1(
  input_community_id TEXT,
  input_creator_account_id TEXT,
  input_created_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  expected_assignment_id TEXT;
  persisted community_role_assignments%ROWTYPE;
BEGIN
  IF input_creator_account_id IS NULL OR btrim(input_creator_account_id) = ''
    OR NOT EXISTS (
      SELECT 1
        FROM users
       WHERE user_id = input_creator_account_id
         AND status = 'active'
    )
  THEN
    RAISE EXCEPTION 'initial community owner requires an active creator account';
  END IF;

  expected_assignment_id := 'community-role:' || input_community_id || ':owner:v1';

  INSERT INTO community_role_assignments (
    role_assignment_id,
    community_id,
    account_id,
    role,
    status,
    assigned_at
  ) VALUES (
    expected_assignment_id,
    input_community_id,
    input_creator_account_id,
    'owner',
    'active',
    input_created_at
  )
  ON CONFLICT (role_assignment_id) DO NOTHING;

  SELECT *
    INTO persisted
    FROM community_role_assignments
   WHERE role_assignment_id = expected_assignment_id;

  IF NOT FOUND
    OR persisted.community_id IS DISTINCT FROM input_community_id
    OR persisted.account_id IS DISTINCT FROM input_creator_account_id
    OR persisted.role IS DISTINCT FROM 'owner'
    OR persisted.status IS DISTINCT FROM 'active'
    OR persisted.assigned_at IS DISTINCT FROM input_created_at
    OR persisted.deactivated_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'initial community owner conflicts with deterministic assignment';
  END IF;

  IF (
    SELECT count(*)
      FROM community_role_assignments
     WHERE community_id = input_community_id
       AND role = 'owner'
       AND status = 'active'
  ) <> 1 THEN
    RAISE EXCEPTION 'community must have exactly one active owner';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION initialize_inserted_community_owner_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM initialize_community_owner_v1(
    NEW.community_id,
    NEW.created_by_user_id,
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_initialize_owner_v1
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION initialize_inserted_community_owner_v1();

CREATE OR REPLACE FUNCTION guard_community_role_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
    AND (
      TG_OP = 'DELETE'
      OR NEW.role IS DISTINCT FROM 'owner'
      OR NEW.status IS DISTINCT FROM 'active'
      OR NEW.community_id IS DISTINCT FROM OLD.community_id
    )
  THEN
    PERFORM 1
      FROM communities
     WHERE community_id = OLD.community_id
     FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
        FROM community_role_assignments AS replacement
       WHERE replacement.community_id = OLD.community_id
         AND replacement.role = 'owner'
         AND replacement.status = 'active'
         AND replacement.role_assignment_id <> OLD.role_assignment_id
    ) THEN
      RAISE EXCEPTION 'community cannot be left without an active owner';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.role_assignment_id,
    NEW.community_id,
    NEW.account_id,
    NEW.role,
    NEW.assigned_at
  ) IS DISTINCT FROM ROW(
    OLD.role_assignment_id,
    OLD.community_id,
    OLD.account_id,
    OLD.role,
    OLD.assigned_at
  ) THEN
    RAISE EXCEPTION 'community role assignment identity is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_role_assignments_change_guard
BEFORE UPDATE OR DELETE ON community_role_assignments
FOR EACH ROW EXECUTE FUNCTION guard_community_role_assignment_change();

CREATE OR REPLACE FUNCTION moderation_policy_category_ordinal_v1(input_category TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE input_category
    WHEN 'harassment' THEN 1
    WHEN 'harassment/threatening' THEN 2
    WHEN 'hate' THEN 3
    WHEN 'hate/threatening' THEN 4
    WHEN 'illicit' THEN 5
    WHEN 'illicit/violent' THEN 6
    WHEN 'self-harm' THEN 7
    WHEN 'self-harm/intent' THEN 8
    WHEN 'self-harm/instructions' THEN 9
    WHEN 'sexual' THEN 10
    WHEN 'sexual/minors' THEN 11
    WHEN 'violence' THEN 12
    WHEN 'violence/graphic' THEN 13
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION moderation_policy_decision_severity_v1(input_decision TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE input_decision
    WHEN 'permit' THEN 1
    WHEN 'review' THEN 2
    WHEN 'block' THEN 3
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION initial_platform_floor_decision_v1(input_category TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE input_category
    WHEN 'harassment' THEN 'permit'
    WHEN 'harassment/threatening' THEN 'review'
    WHEN 'hate' THEN 'review'
    WHEN 'hate/threatening' THEN 'review'
    WHEN 'illicit' THEN 'permit'
    WHEN 'illicit/violent' THEN 'review'
    WHEN 'self-harm' THEN 'permit'
    WHEN 'self-harm/intent' THEN 'review'
    WHEN 'self-harm/instructions' THEN 'review'
    WHEN 'sexual' THEN 'permit'
    WHEN 'sexual/minors' THEN 'block'
    WHEN 'violence' THEN 'permit'
    WHEN 'violence/graphic' THEN 'permit'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION initial_community_policy_decision_v1(input_category TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN moderation_policy_category_ordinal_v1(input_category) IS NULL THEN NULL
    WHEN input_category = 'sexual/minors' THEN 'block'
    ELSE 'review'
  END;
$$;

CREATE TABLE moderation_platform_floor_revisions (
  policy_revision_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL UNIQUE CHECK (revision > 0),
  policy_preimage TEXT NOT NULL,
  policy_hash TEXT NOT NULL UNIQUE CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_platform_floor_revision_identity_not_blank CHECK (
    btrim(policy_revision_id) <> '' AND policy_revision_id = btrim(policy_revision_id)
  ),
  CONSTRAINT moderation_platform_floor_revision_hash_unique
    UNIQUE (policy_revision_id, policy_hash)
);

CREATE TABLE moderation_platform_floor_category_decisions (
  policy_revision_id TEXT NOT NULL
    REFERENCES moderation_platform_floor_revisions (policy_revision_id),
  category TEXT NOT NULL CHECK (moderation_policy_category_ordinal_v1(category) IS NOT NULL),
  decision TEXT NOT NULL CHECK (moderation_policy_decision_severity_v1(decision) IS NOT NULL),
  PRIMARY KEY (policy_revision_id, category)
);

CREATE TABLE moderation_platform_floor_current (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  policy_revision_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_platform_floor_current_revision_fk
    FOREIGN KEY (policy_revision_id, policy_hash)
    REFERENCES moderation_platform_floor_revisions (policy_revision_id, policy_hash)
    MATCH FULL
);

CREATE OR REPLACE FUNCTION moderation_platform_floor_preimage_v1(
  input_policy_revision_id TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT format(
    '["moderation-platform-floor-v1",%s,[%s]]',
    to_json(input_policy_revision_id)::text,
    string_agg(
      format('[%s,%s]', to_json(category)::text, to_json(decision)::text),
      ',' ORDER BY moderation_policy_category_ordinal_v1(category)
    )
  )
  FROM moderation_platform_floor_category_decisions
  WHERE policy_revision_id = input_policy_revision_id;
$$;

CREATE OR REPLACE FUNCTION validate_moderation_platform_floor_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_revision_id TEXT;
  persisted moderation_platform_floor_revisions%ROWTYPE;
  expected_preimage TEXT;
BEGIN
  target_revision_id := COALESCE(NEW.policy_revision_id, OLD.policy_revision_id);

  SELECT *
    INTO persisted
    FROM moderation_platform_floor_revisions
   WHERE policy_revision_id = target_revision_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF (
    SELECT count(*)
      FROM moderation_platform_floor_category_decisions
     WHERE policy_revision_id = target_revision_id
  ) <> 13 THEN
    RAISE EXCEPTION 'moderation platform floor revision must contain exactly thirteen categories';
  END IF;

  expected_preimage := moderation_platform_floor_preimage_v1(target_revision_id);
  IF persisted.policy_preimage IS DISTINCT FROM expected_preimage
    OR persisted.policy_hash IS DISTINCT FROM encode(
      sha256(convert_to(expected_preimage, 'UTF8')),
      'hex'
    )
  THEN
    RAISE EXCEPTION 'moderation platform floor revision canonical hash mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER moderation_platform_floor_revision_completeness_guard
AFTER INSERT OR UPDATE ON moderation_platform_floor_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_moderation_platform_floor_revision();

CREATE CONSTRAINT TRIGGER moderation_platform_floor_category_completeness_guard
AFTER INSERT OR UPDATE OR DELETE ON moderation_platform_floor_category_decisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_moderation_platform_floor_revision();

WITH categories(category) AS (
  VALUES
    ('harassment'),
    ('harassment/threatening'),
    ('hate'),
    ('hate/threatening'),
    ('illicit'),
    ('illicit/violent'),
    ('self-harm'),
    ('self-harm/intent'),
    ('self-harm/instructions'),
    ('sexual'),
    ('sexual/minors'),
    ('violence'),
    ('violence/graphic')
), preimage(value) AS (
  SELECT format(
    '["moderation-platform-floor-v1","moderation-platform-floor-v1",[%s]]',
    string_agg(
      format(
        '[%s,%s]',
        to_json(category)::text,
        to_json(initial_platform_floor_decision_v1(category))::text
      ),
      ',' ORDER BY moderation_policy_category_ordinal_v1(category)
    )
  )
  FROM categories
)
INSERT INTO moderation_platform_floor_revisions (
  policy_revision_id,
  revision,
  policy_preimage,
  policy_hash
)
SELECT
  'moderation-platform-floor-v1',
  1,
  value,
  encode(sha256(convert_to(value, 'UTF8')), 'hex')
FROM preimage;

INSERT INTO moderation_platform_floor_category_decisions (
  policy_revision_id,
  category,
  decision
)
SELECT
  'moderation-platform-floor-v1',
  category,
  initial_platform_floor_decision_v1(category)
FROM (
  VALUES
    ('harassment'),
    ('harassment/threatening'),
    ('hate'),
    ('hate/threatening'),
    ('illicit'),
    ('illicit/violent'),
    ('self-harm'),
    ('self-harm/intent'),
    ('self-harm/instructions'),
    ('sexual'),
    ('sexual/minors'),
    ('violence'),
    ('violence/graphic')
) AS categories(category);

INSERT INTO moderation_platform_floor_current (
  singleton,
  policy_revision_id,
  policy_hash
)
SELECT TRUE, policy_revision_id, policy_hash
  FROM moderation_platform_floor_revisions
 WHERE policy_revision_id = 'moderation-platform-floor-v1';

CREATE TRIGGER moderation_platform_floor_revisions_append_only
BEFORE UPDATE OR DELETE ON moderation_platform_floor_revisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER moderation_platform_floor_categories_append_only
BEFORE UPDATE OR DELETE ON moderation_platform_floor_category_decisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TABLE community_moderation_policy_revisions (
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  policy_revision_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  platform_floor_revision_id TEXT NOT NULL,
  platform_floor_hash TEXT NOT NULL CHECK (platform_floor_hash ~ '^[0-9a-f]{64}$'),
  policy_preimage TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, policy_revision_id),
  CONSTRAINT community_moderation_policy_revision_number_unique
    UNIQUE (community_id, revision),
  CONSTRAINT community_moderation_policy_revision_hash_unique
    UNIQUE (community_id, policy_revision_id, policy_hash),
  CONSTRAINT community_moderation_policy_revision_identity_not_blank CHECK (
    btrim(policy_revision_id) <> '' AND policy_revision_id = btrim(policy_revision_id)
  ),
  CONSTRAINT community_moderation_policy_platform_floor_fk
    FOREIGN KEY (platform_floor_revision_id, platform_floor_hash)
    REFERENCES moderation_platform_floor_revisions (policy_revision_id, policy_hash)
    MATCH FULL
);

CREATE TABLE community_moderation_policy_category_decisions (
  community_id TEXT NOT NULL,
  policy_revision_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (moderation_policy_category_ordinal_v1(category) IS NOT NULL),
  decision TEXT NOT NULL CHECK (moderation_policy_decision_severity_v1(decision) IS NOT NULL),
  PRIMARY KEY (community_id, policy_revision_id, category),
  CONSTRAINT community_moderation_policy_category_revision_fk
    FOREIGN KEY (community_id, policy_revision_id)
    REFERENCES community_moderation_policy_revisions (community_id, policy_revision_id)
);

CREATE TABLE community_moderation_policy_current (
  community_id TEXT PRIMARY KEY REFERENCES communities (community_id),
  policy_revision_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_moderation_policy_current_revision_fk
    FOREIGN KEY (community_id, policy_revision_id, policy_hash)
    REFERENCES community_moderation_policy_revisions (
      community_id,
      policy_revision_id,
      policy_hash
    )
);

CREATE OR REPLACE FUNCTION community_moderation_policy_preimage_v1(
  input_community_id TEXT,
  input_policy_revision_id TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT format(
    '["community-moderation-policy-v1",%s,%s,%s,%s,%s,[%s]]',
    to_json(revision.community_id)::text,
    to_json(revision.policy_revision_id)::text,
    revision.revision,
    to_json(revision.platform_floor_revision_id)::text,
    to_json(revision.platform_floor_hash)::text,
    string_agg(
      format('[%s,%s]', to_json(category.category)::text, to_json(category.decision)::text),
      ',' ORDER BY moderation_policy_category_ordinal_v1(category.category)
    )
  )
  FROM community_moderation_policy_revisions AS revision
  JOIN community_moderation_policy_category_decisions AS category
    ON category.community_id = revision.community_id
   AND category.policy_revision_id = revision.policy_revision_id
  WHERE revision.community_id = input_community_id
    AND revision.policy_revision_id = input_policy_revision_id
  GROUP BY
    revision.community_id,
    revision.policy_revision_id,
    revision.revision,
    revision.platform_floor_revision_id,
    revision.platform_floor_hash;
$$;

CREATE OR REPLACE FUNCTION validate_community_moderation_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_community_id TEXT;
  target_revision_id TEXT;
  persisted community_moderation_policy_revisions%ROWTYPE;
  expected_preimage TEXT;
BEGIN
  target_community_id := COALESCE(NEW.community_id, OLD.community_id);
  target_revision_id := COALESCE(NEW.policy_revision_id, OLD.policy_revision_id);

  SELECT *
    INTO persisted
    FROM community_moderation_policy_revisions
   WHERE community_id = target_community_id
     AND policy_revision_id = target_revision_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF (
    SELECT count(*)
      FROM community_moderation_policy_category_decisions
     WHERE community_id = target_community_id
       AND policy_revision_id = target_revision_id
  ) <> 13 THEN
    RAISE EXCEPTION 'community moderation policy revision must contain exactly thirteen categories';
  END IF;

  expected_preimage := community_moderation_policy_preimage_v1(
    target_community_id,
    target_revision_id
  );
  IF persisted.policy_preimage IS DISTINCT FROM expected_preimage
    OR persisted.policy_hash IS DISTINCT FROM encode(
      sha256(convert_to(expected_preimage, 'UTF8')),
      'hex'
    )
  THEN
    RAISE EXCEPTION 'community moderation policy revision canonical hash mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_moderation_policy_floor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  floor_decision TEXT;
BEGIN
  SELECT floor_category.decision
    INTO floor_decision
    FROM community_moderation_policy_revisions AS revision
    JOIN moderation_platform_floor_category_decisions AS floor_category
      ON floor_category.policy_revision_id = revision.platform_floor_revision_id
     AND floor_category.category = NEW.category
   WHERE revision.community_id = NEW.community_id
     AND revision.policy_revision_id = NEW.policy_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'community moderation policy requires a complete platform floor';
  END IF;
  IF moderation_policy_decision_severity_v1(NEW.decision)
    < moderation_policy_decision_severity_v1(floor_decision)
  THEN
    RAISE EXCEPTION 'community moderation policy cannot weaken its platform floor';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_moderation_policy_category_floor_guard
BEFORE INSERT ON community_moderation_policy_category_decisions
FOR EACH ROW EXECUTE FUNCTION validate_community_moderation_policy_floor();

CREATE CONSTRAINT TRIGGER community_moderation_policy_revision_completeness_guard
AFTER INSERT OR UPDATE ON community_moderation_policy_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_moderation_policy_revision();

CREATE CONSTRAINT TRIGGER community_moderation_policy_category_completeness_guard
AFTER INSERT OR UPDATE OR DELETE ON community_moderation_policy_category_decisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_moderation_policy_revision();

CREATE TRIGGER community_moderation_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON community_moderation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER community_moderation_policy_categories_append_only
BEFORE UPDATE OR DELETE ON community_moderation_policy_category_decisions
FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE OR REPLACE FUNCTION initialize_community_moderation_policy_v1(
  input_community_id TEXT,
  input_created_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  expected_revision_id TEXT;
  expected_preimage TEXT;
  expected_hash TEXT;
  floor_revision_id TEXT;
  floor_hash TEXT;
  persisted community_moderation_policy_revisions%ROWTYPE;
BEGIN
  SELECT current.policy_revision_id, current.policy_hash
    INTO floor_revision_id, floor_hash
    FROM moderation_platform_floor_current AS current
   WHERE current.singleton
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'initial community moderation policy requires a current platform floor';
  END IF;

  expected_revision_id := 'community-moderation-policy:' || input_community_id || ':r1';

  SELECT format(
    '["community-moderation-policy-v1",%s,%s,1,%s,%s,[%s]]',
    to_json(input_community_id)::text,
    to_json(expected_revision_id)::text,
    to_json(floor_revision_id)::text,
    to_json(floor_hash)::text,
    string_agg(
      format(
        '[%s,%s]',
        to_json(category)::text,
        to_json(initial_community_policy_decision_v1(category))::text
      ),
      ',' ORDER BY moderation_policy_category_ordinal_v1(category)
    )
  )
    INTO expected_preimage
    FROM (
      VALUES
        ('harassment'),
        ('harassment/threatening'),
        ('hate'),
        ('hate/threatening'),
        ('illicit'),
        ('illicit/violent'),
        ('self-harm'),
        ('self-harm/intent'),
        ('self-harm/instructions'),
        ('sexual'),
        ('sexual/minors'),
        ('violence'),
        ('violence/graphic')
    ) AS categories(category);
  expected_hash := encode(sha256(convert_to(expected_preimage, 'UTF8')), 'hex');

  INSERT INTO community_moderation_policy_revisions (
    community_id,
    policy_revision_id,
    revision,
    platform_floor_revision_id,
    platform_floor_hash,
    policy_preimage,
    policy_hash,
    created_at
  ) VALUES (
    input_community_id,
    expected_revision_id,
    1,
    floor_revision_id,
    floor_hash,
    expected_preimage,
    expected_hash,
    input_created_at
  )
  ON CONFLICT (community_id, policy_revision_id) DO NOTHING;

  SELECT *
    INTO persisted
    FROM community_moderation_policy_revisions
   WHERE community_id = input_community_id
     AND policy_revision_id = expected_revision_id;
  IF NOT FOUND
    OR persisted.revision IS DISTINCT FROM 1
    OR persisted.platform_floor_revision_id IS DISTINCT FROM floor_revision_id
    OR persisted.platform_floor_hash IS DISTINCT FROM floor_hash
    OR persisted.policy_preimage IS DISTINCT FROM expected_preimage
    OR persisted.policy_hash IS DISTINCT FROM expected_hash
    OR persisted.created_at IS DISTINCT FROM input_created_at
  THEN
    RAISE EXCEPTION 'initial community moderation policy conflicts with deterministic revision';
  END IF;

  INSERT INTO community_moderation_policy_category_decisions (
    community_id,
    policy_revision_id,
    category,
    decision
  )
  SELECT
    input_community_id,
    expected_revision_id,
    category,
    initial_community_policy_decision_v1(category)
  FROM (
    VALUES
      ('harassment'),
      ('harassment/threatening'),
      ('hate'),
      ('hate/threatening'),
      ('illicit'),
      ('illicit/violent'),
      ('self-harm'),
      ('self-harm/intent'),
      ('self-harm/instructions'),
      ('sexual'),
      ('sexual/minors'),
      ('violence'),
      ('violence/graphic')
  ) AS categories(category)
  ON CONFLICT (community_id, policy_revision_id, category) DO NOTHING;

  IF (
    SELECT count(*) = 13
      AND bool_and(decision = initial_community_policy_decision_v1(category))
      FROM community_moderation_policy_category_decisions
     WHERE community_id = input_community_id
       AND policy_revision_id = expected_revision_id
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'initial community moderation policy category conflict';
  END IF;

  INSERT INTO community_moderation_policy_current (
    community_id,
    policy_revision_id,
    policy_hash,
    updated_at
  ) VALUES (
    input_community_id,
    expected_revision_id,
    expected_hash,
    input_created_at
  )
  ON CONFLICT (community_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM community_moderation_policy_current
     WHERE community_id = input_community_id
       AND policy_revision_id = expected_revision_id
       AND policy_hash = expected_hash
       AND updated_at = input_created_at
  ) THEN
    RAISE EXCEPTION 'initial community moderation policy current pointer conflict';
  END IF;
END;
$$;

SELECT initialize_community_moderation_policy_v1(
  community.community_id,
  community.created_at
)
FROM communities AS community;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM communities AS community
      LEFT JOIN community_moderation_policy_current AS current
        ON current.community_id = community.community_id
      LEFT JOIN community_moderation_policy_category_decisions AS category
        ON category.community_id = current.community_id
       AND category.policy_revision_id = current.policy_revision_id
     GROUP BY community.community_id
    HAVING count(DISTINCT current.policy_revision_id) <> 1
        OR count(category.category) <> 13
  ) THEN
    RAISE EXCEPTION 'community moderation policy backfill invariant failed';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION initialize_inserted_community_moderation_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM initialize_community_moderation_policy_v1(NEW.community_id, NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_initialize_moderation_policy_v1
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION initialize_inserted_community_moderation_policy_v1();

CREATE OR REPLACE FUNCTION guard_community_moderation_policy_current_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_revision BIGINT;
  next_revision BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community moderation policy current pointer cannot be deleted';
  END IF;
  IF NEW.community_id IS DISTINCT FROM OLD.community_id THEN
    RAISE EXCEPTION 'community moderation policy current identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'community moderation policy current timestamp must advance';
  END IF;

  SELECT revision INTO prior_revision
    FROM community_moderation_policy_revisions
   WHERE community_id = OLD.community_id
     AND policy_revision_id = OLD.policy_revision_id;
  SELECT revision INTO next_revision
    FROM community_moderation_policy_revisions
   WHERE community_id = NEW.community_id
     AND policy_revision_id = NEW.policy_revision_id
     AND policy_hash = NEW.policy_hash;
  IF next_revision IS NULL OR next_revision <= prior_revision THEN
    RAISE EXCEPTION 'community moderation policy current revision must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_moderation_policy_current_change_guard
BEFORE UPDATE OR DELETE ON community_moderation_policy_current
FOR EACH ROW EXECUTE FUNCTION guard_community_moderation_policy_current_change();

ALTER TABLE text_content_submissions
  ADD COLUMN platform_policy_revision_id TEXT,
  ADD COLUMN platform_policy_hash TEXT,
  ADD COLUMN community_policy_revision_id TEXT,
  ADD COLUMN community_policy_hash TEXT,
  ADD CONSTRAINT text_content_submissions_policy_evidence_shape CHECK (
    num_nonnulls(
      platform_policy_revision_id,
      platform_policy_hash,
      community_policy_revision_id,
      community_policy_hash
    ) IN (0, 4)
  ),
  ADD CONSTRAINT text_content_submissions_platform_policy_fk
    FOREIGN KEY (platform_policy_revision_id, platform_policy_hash)
    REFERENCES moderation_platform_floor_revisions (policy_revision_id, policy_hash)
    MATCH FULL,
  ADD CONSTRAINT text_content_submissions_community_policy_fk
    FOREIGN KEY (
      community_id,
      community_policy_revision_id,
      community_policy_hash
    ) REFERENCES community_moderation_policy_revisions (
      community_id,
      policy_revision_id,
      policy_hash
    );

ALTER TABLE text_moderation_cases
  ADD COLUMN platform_policy_revision_id TEXT,
  ADD COLUMN platform_policy_hash TEXT,
  ADD COLUMN community_policy_revision_id TEXT,
  ADD COLUMN community_policy_hash TEXT,
  ADD CONSTRAINT text_moderation_cases_policy_evidence_shape CHECK (
    num_nonnulls(
      platform_policy_revision_id,
      platform_policy_hash,
      community_policy_revision_id,
      community_policy_hash
    ) IN (0, 4)
  ),
  ADD CONSTRAINT text_moderation_cases_platform_policy_fk
    FOREIGN KEY (platform_policy_revision_id, platform_policy_hash)
    REFERENCES moderation_platform_floor_revisions (policy_revision_id, policy_hash)
    MATCH FULL,
  ADD CONSTRAINT text_moderation_cases_community_policy_fk
    FOREIGN KEY (
      community_id,
      community_policy_revision_id,
      community_policy_hash
    ) REFERENCES community_moderation_policy_revisions (
      community_id,
      policy_revision_id,
      policy_hash
    );

COMMENT ON COLUMN text_content_submissions.platform_policy_revision_id IS
  'Nullable only for historical TextModerationEvaluationV1 rows before the V2 cutover fence.';
COMMENT ON COLUMN text_moderation_cases.platform_policy_revision_id IS
  'Nullable only for historical moderation cases before the V2 cutover fence.';

CREATE OR REPLACE FUNCTION guard_text_moderation_case_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id,
    NEW.case_id,
    NEW.submission_id,
    NEW.created_at,
    NEW.platform_policy_revision_id,
    NEW.platform_policy_hash,
    NEW.community_policy_revision_id,
    NEW.community_policy_hash
  ) IS DISTINCT FROM ROW(
    OLD.community_id,
    OLD.case_id,
    OLD.submission_id,
    OLD.created_at,
    OLD.platform_policy_revision_id,
    OLD.platform_policy_hash,
    OLD.community_policy_revision_id,
    OLD.community_policy_hash
  ) THEN
    RAISE EXCEPTION 'text moderation case identity and policy evidence are immutable';
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

DO $$
DECLARE
  expected_preimage CONSTANT TEXT :=
    '{"base_url":"https://api.openai.com/v1","decision_mapper_revision":"openai-boolean-categories-v1","model":"omni-moderation-2024-09-26","normalization_revision":"text-moderation-input-v1","provider_id":"openai","timeout_ms":10000,"version":"text-moderation-policy-openai-omni-2024-09-26-v1"}';
  expected_hash TEXT;
  persisted text_moderation_policy_revisions%ROWTYPE;
BEGIN
  expected_hash := encode(sha256(convert_to(expected_preimage, 'UTF8')), 'hex');

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
    'text-moderation-policy-openai-omni-2024-09-26-v1',
    expected_hash,
    expected_preimage,
    expected_preimage::jsonb,
    'openai',
    'omni-moderation-2024-09-26',
    'https://api.openai.com/v1',
    10000,
    0,
    'text-moderation-input-v1',
    'openai-boolean-categories-v1'
  )
  ON CONFLICT (policy_revision_id) DO NOTHING;

  SELECT *
    INTO persisted
    FROM text_moderation_policy_revisions
   WHERE policy_revision_id = 'text-moderation-policy-openai-omni-2024-09-26-v1';
  IF NOT FOUND
    OR persisted.policy_hash IS DISTINCT FROM expected_hash
    OR persisted.policy_preimage IS DISTINCT FROM expected_preimage
    OR persisted.policy_document IS DISTINCT FROM expected_preimage::jsonb
    OR persisted.provider_id IS DISTINCT FROM 'openai'
    OR persisted.model_identifier IS DISTINCT FROM 'omni-moderation-2024-09-26'
    OR persisted.base_url_origin IS DISTINCT FROM 'https://api.openai.com/v1'
    OR persisted.timeout_ms IS DISTINCT FROM 10000
    OR persisted.sexual_minors_block_threshold IS DISTINCT FROM 0
    OR persisted.normalization_revision IS DISTINCT FROM 'text-moderation-input-v1'
    OR persisted.decision_mapper_revision IS DISTINCT FROM 'openai-boolean-categories-v1'
  THEN
    RAISE EXCEPTION 'pinned moderation provider policy conflicts with immutable revision';
  END IF;
END;
$$;
