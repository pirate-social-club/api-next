-- Spec 012 section 5.2: one account-scoped cleanup rename for the generated
-- platform-global .pirate placeholder. This migration adds stable identity
-- authority over the existing append-only label rows. It performs no live
-- rename and makes no provider, wallet, DNS, HNS, or external call.

ALTER TABLE public_handle_index
  ADD COLUMN platform_handle_id TEXT,
  ADD COLUMN generation BIGINT,
  ADD COLUMN confusability_key TEXT GENERATED ALWAYS AS (
    translate(replace(label_normalized, '-', ''), '013457', 'oleast')
  ) STORED,
  ADD COLUMN rename_transition_hash TEXT;

DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public_handle_index
     WHERE octet_length(label_normalized) < 3
        OR octet_length(label_normalized) > 32
        OR label_normalized LIKE 'xn--%'
  ) THEN
    RAISE EXCEPTION '0062 cannot map an existing platform label into policy v1';
  END IF;
  IF EXISTS (
    SELECT confusability_key
      FROM public_handle_index
     GROUP BY confusability_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0062 found an ambiguous platform-label confusability key';
  END IF;
  IF EXISTS (
    SELECT owner_user_id
      FROM public_handle_index
     WHERE status = 'active'
     GROUP BY owner_user_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION '0062 found ambiguous active platform identities';
  END IF;
END;
$audit$;

UPDATE public_handle_index AS label
   SET platform_handle_id = COALESCE(
         (
           SELECT candidate.handle_id
             FROM public_handle_index AS candidate
            WHERE candidate.owner_user_id = label.owner_user_id
              AND candidate.status = 'active'
            LIMIT 1
         ),
         CASE WHEN label.status = 'redirect' THEN label.redirect_target_handle_id ELSE label.handle_id END
       );

UPDATE public_handle_index
   SET platform_handle_id = COALESCE(
         platform_handle_id,
         CASE WHEN status = 'redirect' THEN redirect_target_handle_id ELSE handle_id END
       );

WITH ordered AS (
  SELECT handle_id,
         row_number() OVER (
           PARTITION BY platform_handle_id
           ORDER BY CASE WHEN status = 'active' THEN 1 ELSE 0 END,
                    created_at,
                    handle_id
         ) AS assigned_generation
    FROM public_handle_index
)
UPDATE public_handle_index AS label
   SET generation = ordered.assigned_generation
  FROM ordered
 WHERE ordered.handle_id = label.handle_id;

ALTER TABLE public_handle_index
  ALTER COLUMN platform_handle_id SET NOT NULL,
  ALTER COLUMN generation SET NOT NULL,
  ADD CONSTRAINT public_handle_index_platform_id_shape CHECK (
    btrim(platform_handle_id) <> ''
    AND platform_handle_id = btrim(platform_handle_id)
    AND octet_length(platform_handle_id) <= 256
  ),
  ADD CONSTRAINT public_handle_index_generation_positive CHECK (
    generation BETWEEN 1 AND 9007199254740991
  ),
  ADD CONSTRAINT public_handle_index_transition_hash_shape CHECK (
    rename_transition_hash IS NULL OR rename_transition_hash ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX public_handle_index_confusability_key_uidx
  ON public_handle_index (confusability_key COLLATE "C");
CREATE INDEX public_handle_index_platform_generation_idx
  ON public_handle_index (platform_handle_id, generation);
CREATE UNIQUE INDEX public_handle_index_one_active_platform_uidx
  ON public_handle_index (platform_handle_id) WHERE status = 'active';
CREATE INDEX public_handle_index_platform_status_idx
  ON public_handle_index (platform_handle_id, status, generation DESC);

CREATE TABLE platform_pirate_label_policy_revisions (
  label_policy_revision BIGINT PRIMARY KEY CHECK (label_policy_revision > 0),
  label_policy_id TEXT NOT NULL CHECK (label_policy_id = 'pirate_ascii_ldh_3_32_v1'),
  label_policy_hash TEXT NOT NULL UNIQUE CHECK (label_policy_hash ~ '^[0-9a-f]{64}$'),
  reserved_labels_id TEXT NOT NULL CHECK (
    reserved_labels_id = 'pirate_platform_reserved_labels_v1'
  ),
  reserved_labels_revision BIGINT NOT NULL CHECK (reserved_labels_revision > 0),
  reserved_labels_hash TEXT NOT NULL CHECK (reserved_labels_hash ~ '^[0-9a-f]{64}$'),
  confusability_policy_id TEXT NOT NULL CHECK (
    confusability_policy_id = 'pirate_ascii_skeleton_v1'
  ),
  confusability_policy_revision BIGINT NOT NULL CHECK (
    confusability_policy_revision > 0
  ),
  confusability_policy_hash TEXT NOT NULL CHECK (
    confusability_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  exact_labels TEXT[] NOT NULL,
  reserved_prefixes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (reserved_labels_id, reserved_labels_revision),
  UNIQUE (confusability_policy_id, confusability_policy_revision)
);

INSERT INTO platform_pirate_label_policy_revisions (
  label_policy_revision,
  label_policy_id,
  label_policy_hash,
  reserved_labels_id,
  reserved_labels_revision,
  reserved_labels_hash,
  confusability_policy_id,
  confusability_policy_revision,
  confusability_policy_hash,
  exact_labels,
  reserved_prefixes
) VALUES (
  1,
  'pirate_ascii_ldh_3_32_v1',
  '7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873',
  'pirate_platform_reserved_labels_v1',
  1,
  'e7f1a3e99c5eb1bd51e880db3aa6c7caeca83f2b7dcce4dfddb54c45c49ea304',
  'pirate_ascii_skeleton_v1',
  1,
  'b50884c3e97a4ea50fc6da0c2b0d15669bcb0647886011521b5dbb1fd7ddfa92',
  ARRAY[
    'abuse','admin','api','app','auth','billing','blog','cdn','dev','docs',
    'gateway','help','hns','login','logout','mail','mod','moderator','new',
    'official','pirate','root','security','settings','staff','staging','status',
    'support','system','www'
  ]::TEXT[],
  ARRAY['new-']::TEXT[]
);

DO $reserved_audit$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS label
     WHERE label.label_normalized = ANY(ARRAY[
       'abuse','admin','api','app','auth','billing','blog','cdn','dev','docs',
       'gateway','help','hns','login','logout','mail','mod','moderator','new',
       'official','pirate','root','security','settings','staff','staging','status',
       'support','system','www'
     ]::TEXT[])
        OR label.confusability_key IN (
          SELECT translate(replace(reserved, '-', ''), '013457', 'oleast')
            FROM unnest(ARRAY[
              'abuse','admin','api','app','auth','billing','blog','cdn','dev','docs',
              'gateway','help','hns','login','logout','mail','mod','moderator','new',
              'official','pirate','root','security','settings','staff','staging','status',
              'support','system','www'
            ]::TEXT[]) AS reserved
        )
  ) THEN
    RAISE EXCEPTION '0062 found an existing label colliding with reserved policy v1';
  END IF;
END;
$reserved_audit$;

CREATE TABLE platform_pirate_handles (
  platform_handle_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL UNIQUE REFERENCES users (user_id),
  owner_persona_id TEXT NOT NULL UNIQUE,
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  active_handle_id TEXT NOT NULL UNIQUE REFERENCES public_handle_index (handle_id)
    DEFERRABLE INITIALLY DEFERRED,
  cleanup_rename_consumed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (actor_account_id, owner_persona_id)
    REFERENCES personas (account_id, persona_id),
  CONSTRAINT platform_pirate_handle_time_order CHECK (updated_at >= created_at)
);

INSERT INTO platform_pirate_handles (
  platform_handle_id,
  actor_account_id,
  owner_persona_id,
  generation,
  active_handle_id,
  cleanup_rename_consumed,
  created_at,
  updated_at
)
SELECT active.platform_handle_id,
       active.owner_user_id,
       active.owner_persona_id,
       active.generation,
       active.handle_id,
       CASE
         WHEN active.label_normalized !~ '^new-[0-9a-f]{20}$' THEN true
         ELSE COALESCE((account.account #>> '{global_handle,free_rename_consumed}')::boolean, false)
       END,
       active.created_at,
       active.updated_at
  FROM public_handle_index AS active
  JOIN users AS account ON account.user_id = active.owner_user_id
 WHERE active.status = 'active';

ALTER TABLE public_handle_index
  ADD CONSTRAINT public_handle_index_platform_identity_fk
  FOREIGN KEY (platform_handle_id) REFERENCES platform_pirate_handles (platform_handle_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION prepare_platform_pirate_label_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target public_handle_index%ROWTYPE;
BEGIN
  IF NEW.platform_handle_id IS NULL THEN
    IF NEW.status = 'redirect' THEN
      SELECT * INTO target
        FROM public_handle_index
       WHERE handle_id=NEW.redirect_target_handle_id;
      IF target.handle_id IS NULL THEN
        NEW.platform_handle_id := NEW.handle_id;
        NEW.generation := 1;
        RETURN NEW;
      END IF;
      NEW.platform_handle_id := target.platform_handle_id;
      NEW.generation := GREATEST(1, target.generation - 1);
    ELSE
      NEW.platform_handle_id := NEW.handle_id;
      NEW.generation := 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_pirate_label_insert_defaults
BEFORE INSERT ON public_handle_index
FOR EACH ROW EXECUTE FUNCTION prepare_platform_pirate_label_insert_v1();

CREATE FUNCTION initialize_platform_pirate_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    INSERT INTO platform_pirate_handles (
      platform_handle_id,actor_account_id,owner_persona_id,generation,
      active_handle_id,cleanup_rename_consumed,created_at,updated_at
    ) VALUES (
      NEW.platform_handle_id,NEW.owner_user_id,NEW.owner_persona_id,NEW.generation,
      NEW.handle_id,NEW.label_normalized !~ '^new-[0-9a-f]{20}$',NEW.created_at,NEW.updated_at
    )
    ON CONFLICT (platform_handle_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_pirate_identity_initialize
AFTER INSERT ON public_handle_index
FOR EACH ROW EXECUTE FUNCTION initialize_platform_pirate_identity_v1();

CREATE TABLE platform_pirate_handle_rename_actions (
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL DEFAULT '/platform-pirate-handles/rename'
    CHECK (endpoint_template = '/platform-pirate-handles/rename'),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  platform_handle_id TEXT NOT NULL REFERENCES platform_pirate_handles (platform_handle_id),
  owner_persona_id TEXT NOT NULL,
  response_json JSONB NOT NULL,
  transition_hash TEXT NOT NULL CHECK (transition_hash ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_account_id, endpoint_template, idempotency_key),
  FOREIGN KEY (actor_account_id, owner_persona_id)
    REFERENCES personas (account_id, persona_id)
);

CREATE TABLE platform_pirate_handle_rate_submissions (
  submission_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  operation TEXT NOT NULL CHECK (operation IN ('availability', 'rename')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX platform_pirate_handle_rate_account_operation_idx
  ON platform_pirate_handle_rate_submissions (
    actor_account_id,
    operation,
    submitted_at DESC
  );

CREATE FUNCTION prevent_platform_pirate_identity_rewrite_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform Pirate identity cannot be deleted';
  END IF;
  IF NEW.platform_handle_id IS DISTINCT FROM OLD.platform_handle_id
     OR NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id
     OR NEW.owner_persona_id IS DISTINCT FROM OLD.owner_persona_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'platform Pirate identity ownership is immutable';
  END IF;
  IF NEW.generation < OLD.generation
     OR (OLD.cleanup_rename_consumed AND NOT NEW.cleanup_rename_consumed) THEN
    RAISE EXCEPTION 'platform Pirate identity state is append-only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_pirate_identity_immutable
BEFORE UPDATE OR DELETE ON platform_pirate_handles
FOR EACH ROW EXECUTE FUNCTION prevent_platform_pirate_identity_rewrite_v1();

CREATE FUNCTION prevent_platform_pirate_label_rewrite_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform Pirate label history cannot be deleted';
  END IF;
  IF NEW.handle_id IS DISTINCT FROM OLD.handle_id
     OR NEW.platform_handle_id IS DISTINCT FROM OLD.platform_handle_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.owner_persona_id IS DISTINCT FROM OLD.owner_persona_id
     OR NEW.label_normalized IS DISTINCT FROM OLD.label_normalized
     OR NEW.label_display IS DISTINCT FROM OLD.label_display
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'platform Pirate label identity is immutable';
  END IF;
  IF OLD.status <> 'active'
     AND current_setting('pirate.platform_handle_rename', true) IS DISTINCT FROM 'on'
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'historical platform Pirate label is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_pirate_label_immutable
BEFORE UPDATE OR DELETE ON public_handle_index
FOR EACH ROW EXECUTE FUNCTION prevent_platform_pirate_label_rewrite_v1();

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
       AND target.owner_persona_id = NEW.owner_persona_id
       AND target.platform_handle_id = NEW.platform_handle_id
  ) THEN
    RAISE EXCEPTION 'redirect target must be the direct active label for the same stable identity'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1
      FROM public_handle_index AS source
     WHERE source.redirect_target_handle_id = NEW.handle_id
       AND (
         source.owner_user_id <> NEW.owner_user_id
         OR source.owner_persona_id <> NEW.owner_persona_id
         OR source.platform_handle_id <> NEW.platform_handle_id
       )
  ) THEN
    RAISE EXCEPTION 'active target has a cross-identity redirect'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION track_handle_platform_label_footprint_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('pirate.platform_handle_rename', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM ensure_handle_persona_public_footprint_v1(NEW.owner_persona_id, NEW.updated_at);
  ELSIF ROW(NEW.label_normalized, NEW.status, NEW.redirect_target_handle_id)
      IS DISTINCT FROM ROW(OLD.label_normalized, OLD.status, OLD.redirect_target_handle_id) THEN
    PERFORM advance_handle_persona_public_linkage_v1(NEW.owner_persona_id, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;
