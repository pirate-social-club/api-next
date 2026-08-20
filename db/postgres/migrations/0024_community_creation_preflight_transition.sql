-- A synchronous draft save and its capability/evidence preflight are one
-- externally replayable revision. Keep that reducer event legal at storage.

CREATE OR REPLACE FUNCTION guard_community_creation_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.intent_id,
    NEW.actor_id,
    NEW.create_idempotency_key,
    NEW.create_request_hash,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.intent_id,
    OLD.actor_id,
    OLD.create_idempotency_key,
    OLD.create_request_hash,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community creation intent identity is immutable';
  END IF;

  IF OLD.status IN (
    'committed',
    'quota_exceeded',
    'gate_unsupported',
    'expired',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'terminal community creation intent is immutable';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'community creation intent revision must advance exactly once';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'verification_required' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'commit_ready' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
  ) THEN
    RAISE EXCEPTION 'community creation intent transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

