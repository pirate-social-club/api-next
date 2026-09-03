-- Community-persona binding authority (spec 014 section 10, 2026-09-03
-- amendment; matching amendments in specs 015, 018, and 019).
--
-- persona_community_bindings becomes the sole community eligibility
-- authority for a persona. A persona carries at most one immutable binding
-- for its lifetime; community retirement or deletion never releases or
-- retargets it. Membership remains an independent account fact checked
-- through active_community_effect; the two checks are never collapsed.
--
-- The migration installs the read-only preflight first: any persona with
-- evidence in more than one community aborts the whole transaction before
-- the table, backfill, or foreign-key change commits, emitting only bounded
-- conflict identifiers plus the evidence digest. Exactly one evidenced
-- community derives one migration_single_evidence binding; zero evidenced
-- communities leaves the persona unbound and ineligible until an explicit
-- account choice binds it. The preflight and the backfill read the same
-- versioned evidence function and digest.

-- The evidence function is plpgsql with to_regclass guards for sources that
-- only exist later in the chain (dance choreographies and sessions, Study v2
-- sessions). In production the full chain always provides them; the guards
-- exist so exact-schema test plans that legitimately stop before those
-- migrations can still install this one. They never weaken the binding
-- predicate itself: eligibility always requires the exact binding row.
CREATE FUNCTION persona_community_binding_evidence_v1()
RETURNS TABLE (
  persona_id TEXT,
  account_id TEXT,
  community_id TEXT,
  evidence_count BIGINT
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT source.persona_id, source.account_id, source.community_id,
         count(*)::BIGINT AS evidence_count
    FROM (
      SELECT post.author_persona_id AS persona_id,
             post.author_user_id AS account_id,
             post.community_id
        FROM posts AS post
      UNION ALL
      SELECT comment.author_persona_id,
             comment.author_user_id,
             comment.community_id
        FROM comments AS comment
      UNION ALL
      SELECT submission.author_persona_id,
             submission.actor_user_id,
             submission.community_id
        FROM text_content_submissions AS submission
      UNION ALL
      SELECT submission.author_persona_id,
             submission.actor_user_id,
             submission.community_id
        FROM media_post_submissions AS submission
      UNION ALL
      SELECT reservation.actor_persona_id,
             reservation.actor_user_id,
             reservation.community_id
        FROM media_upload_reservations AS reservation
      UNION ALL
      SELECT grant_row.owner_persona_id,
             grant_row.owner_account_id,
             grant_row.community_id
        FROM handle_grants AS grant_row
      UNION ALL
      SELECT role_presentation.persona_id,
             role_presentation.account_id,
             role_presentation.community_id
        FROM persona_role_presentations AS role_presentation
      UNION ALL
      SELECT activity_presentation.persona_id,
             activity_presentation.account_id,
             activity_presentation.community_id
        FROM persona_activity_presentations AS activity_presentation
      UNION ALL
      SELECT study_session.persona_id,
             study_session.account_id,
             study_session.community_id
        FROM study_sessions AS study_session
      UNION ALL
      SELECT karaoke_session.persona_id,
             karaoke_session.account_id,
             karaoke_session.community_id
        FROM karaoke_sessions AS karaoke_session
      UNION ALL
      SELECT qualification.persona_id,
             qualification.account_id,
             qualification.community_id
        FROM activity_qualifications AS qualification
    ) AS source
   GROUP BY source.persona_id, source.account_id, source.community_id;
  IF to_regclass('dance_choreographies') IS NOT NULL THEN
    RETURN QUERY
    SELECT choreography.creator_persona_id,
           choreography.creator_account_id,
           choreography.community_id,
           1::BIGINT AS evidence_count
      FROM dance_choreographies AS choreography;
  END IF;
  IF to_regclass('dance_sessions') IS NOT NULL THEN
    RETURN QUERY
    SELECT dance_session.persona_id,
           dance_session.account_id,
           dance_session.community_id,
           1::BIGINT AS evidence_count
      FROM dance_sessions AS dance_session;
  END IF;
  IF to_regclass('study_sessions_v2') IS NOT NULL THEN
    RETURN QUERY
    SELECT study_session.persona_id,
           study_session.account_id,
           study_session.community_id,
           1::BIGINT AS evidence_count
      FROM study_sessions_v2 AS study_session;
  END IF;
END
$$;

CREATE FUNCTION persona_community_binding_evidence_digest_v1()
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(
    sha256(
      convert_to(
        coalesce(
          string_agg(
            evidence.persona_id || ':' || evidence.account_id || ':' ||
              evidence.community_id || ':' || evidence.evidence_count::text,
            E'\n'
            ORDER BY evidence.persona_id, evidence.account_id, evidence.community_id
          ),
          ''
        ),
        'UTF8'
      )
    ),
    'hex'
  )
    FROM persona_community_binding_evidence_v1() AS evidence
$$;

DO $preflight$
DECLARE
  conflict_total BIGINT;
  conflict_sample TEXT;
  single_community_total BIGINT;
  unbound_total BIGINT;
  evidence_digest TEXT;
BEGIN
  SELECT count(*) INTO conflict_total
    FROM (
      SELECT evidence.persona_id
        FROM persona_community_binding_evidence_v1() AS evidence
       GROUP BY evidence.persona_id
      HAVING count(DISTINCT evidence.community_id) > 1
    ) AS conflicted;
  SELECT count(*) INTO single_community_total
    FROM (
      SELECT evidence.persona_id
        FROM persona_community_binding_evidence_v1() AS evidence
       GROUP BY evidence.persona_id
      HAVING count(DISTINCT evidence.community_id) = 1
    ) AS single_community;
  SELECT count(*) INTO unbound_total
    FROM personas AS persona
   WHERE NOT EXISTS (
     SELECT 1 FROM persona_community_binding_evidence_v1() AS evidence
      WHERE evidence.persona_id = persona.persona_id
   );
  SELECT persona_community_binding_evidence_digest_v1() INTO evidence_digest;
  IF conflict_total > 0 THEN
    SELECT string_agg(persona_id, ', ' ORDER BY persona_id) INTO conflict_sample
      FROM (
        SELECT evidence.persona_id
          FROM persona_community_binding_evidence_v1() AS evidence
         GROUP BY evidence.persona_id
        HAVING count(DISTINCT evidence.community_id) > 1
        LIMIT 50
      ) AS bounded;
    RAISE EXCEPTION
      'persona community binding backfill aborted: % persona(s) evidence multiple communities and require explicit migration resolution (bounded conflict sample: [%s]); single-evidence personas: %; unbound personas: %; evidence digest: %',
      conflict_total, conflict_sample, single_community_total, unbound_total, evidence_digest;
  END IF;
  RAISE NOTICE
    'persona community binding preflight: single-evidence personas: %; unbound personas: %; multi-community conflicts: 0; evidence digest: %',
    single_community_total, unbound_total, evidence_digest;
END
$preflight$;

CREATE TABLE persona_community_bindings (
  persona_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  binding_source TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, account_id, persona_id),
  UNIQUE (persona_id),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT persona_community_bindings_source_check CHECK (
    binding_source IN (
      'first_membership',
      'community_creation',
      'persona_creation',
      'migration_single_evidence',
      'explicit_migration_resolution'
    )
  ),
  CONSTRAINT persona_community_bindings_bound_at_not_future CHECK (
    bound_at <= clock_timestamp()
  )
);

-- Bindings are append-only: retirement, deletion, and retargeting never
-- release or move an existing binding (spec 014 sections 10.1 and 10.3).
CREATE FUNCTION guard_persona_community_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'persona community binding is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER persona_community_binding_immutable
BEFORE DELETE OR UPDATE ON persona_community_bindings
FOR EACH ROW EXECUTE FUNCTION guard_persona_community_binding();

CREATE FUNCTION active_owned_community_persona(
  expected_account_id TEXT,
  expected_persona_id TEXT,
  expected_community_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM personas AS persona
      JOIN persona_community_bindings AS binding
        ON binding.persona_id = persona.persona_id
       AND binding.community_id = expected_community_id
     WHERE persona.account_id = expected_account_id
       AND persona.persona_id = expected_persona_id
       AND persona.status = 'active'
  )
$$;

COMMENT ON FUNCTION persona_community_binding_evidence_v1() IS
  'Versioned community-use evidence for the persona binding backfill (spec 014 section 10.5). The preflight and backfill must keep reading this one function.';

INSERT INTO persona_community_bindings (
  persona_id, account_id, community_id, binding_source
)
SELECT evidence.persona_id,
       evidence.account_id,
       min(evidence.community_id),
       'migration_single_evidence'
  FROM persona_community_binding_evidence_v1() AS evidence
 GROUP BY evidence.persona_id, evidence.account_id
HAVING count(DISTINCT evidence.community_id) = 1;

DO $verify$
DECLARE
  backfill_digest TEXT;
BEGIN
  SELECT persona_community_binding_evidence_digest_v1() INTO backfill_digest;
  IF EXISTS (
    SELECT 1
      FROM personas AS persona
     WHERE NOT EXISTS (
       SELECT 1 FROM persona_community_bindings AS binding
        WHERE binding.persona_id = persona.persona_id
     )
       AND EXISTS (
         SELECT 1 FROM persona_community_binding_evidence_v1() AS evidence
          WHERE evidence.persona_id = persona.persona_id
       )
  ) THEN
    RAISE EXCEPTION
      'persona community binding backfill left an evidenced persona unbound; evidence digest: %',
      backfill_digest;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM persona_community_bindings AS binding
     WHERE binding.binding_source <> 'migration_single_evidence'
  ) THEN
    RAISE EXCEPTION 'persona community binding backfill wrote an unexpected source';
  END IF;
END
$verify$;

-- Tables that durably pair a community with a presenting persona now
-- reference the binding's composite key directly, so a presentation row
-- cannot exist for a persona that lacks the exact community binding
-- (spec 014 sections 10.1 and 10.6).
ALTER TABLE persona_activity_presentations
  DROP CONSTRAINT persona_activity_presentations_account_id_persona_id_fkey,
  ADD CONSTRAINT persona_activity_presentations_community_binding_fkey
    FOREIGN KEY (community_id, account_id, persona_id)
    REFERENCES persona_community_bindings (community_id, account_id, persona_id);

ALTER TABLE persona_role_presentations
  DROP CONSTRAINT persona_role_presentations_account_id_persona_id_fkey,
  ADD CONSTRAINT persona_role_presentations_community_binding_fkey
    FOREIGN KEY (community_id, account_id, persona_id)
    REFERENCES persona_community_bindings (community_id, account_id, persona_id);
