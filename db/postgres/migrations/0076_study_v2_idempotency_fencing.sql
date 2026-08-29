-- Persist request hashes beside both Study v2 idempotency scopes so a reused
-- key with different input is a conflict, never a replay.

ALTER TABLE study_sessions_v2
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_hash TEXT;

UPDATE study_sessions_v2
   SET idempotency_key = session_id,
       request_hash = encode(sha256(convert_to(session_id, 'UTF8')), 'hex');

ALTER TABLE study_sessions_v2
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT study_session_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT study_session_idempotency_unique UNIQUE (account_id, post_id, idempotency_key);

ALTER TABLE study_attempts_v2
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_hash TEXT;

UPDATE study_attempts_v2
   SET idempotency_key = attempt_id,
       request_hash = encode(sha256(convert_to(attempt_id, 'UTF8')), 'hex');

ALTER TABLE study_attempts_v2
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT study_attempt_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT study_attempt_idempotency_unique UNIQUE (session_item_id, idempotency_key);
