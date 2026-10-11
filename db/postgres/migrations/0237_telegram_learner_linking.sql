-- Private Telegram identity and explicit per-community bot consent. No provider tokens.
CREATE TABLE telegram_link_navigation (
  reference_hash TEXT PRIMARY KEY CHECK (reference_hash ~ '^[A-Za-z0-9_-]{43}$'),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  bot_id TEXT NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  bot_epoch TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  post_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '15 minutes',
  cancelled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX telegram_link_navigation_expiry ON telegram_link_navigation(expires_at);
CREATE TABLE telegram_account_associations (
  telegram_user_id TEXT PRIMARY KEY CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX telegram_account_associations_account ON telegram_account_associations(account_id);
CREATE TABLE telegram_bot_grants (
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  bot_id TEXT NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  persona_id TEXT NOT NULL REFERENCES personas(persona_id),
  revision BIGINT NOT NULL CHECK (revision > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(community_id, bot_id, telegram_user_id)
);
CREATE INDEX telegram_bot_grants_account ON telegram_bot_grants(account_id, community_id);
CREATE TABLE telegram_link_transactions (
  transaction_id TEXT PRIMARY KEY CHECK (transaction_id ~ '^[A-Za-z0-9_-]{43}$'),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  session_hash TEXT NOT NULL CHECK (session_hash ~ '^[A-Za-z0-9_-]{43}$'),
  browser_hash TEXT NOT NULL CHECK (browser_hash ~ '^[A-Za-z0-9_-]{43}$'),
  state_hash TEXT CHECK (state_hash ~ '^[A-Za-z0-9_-]{43}$'),
  secret_ciphertext TEXT CHECK (length(secret_ciphertext) <= 4096),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  bot_id TEXT NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  bot_epoch TEXT NOT NULL,
  expected_telegram_user_id TEXT NOT NULL CHECK (expected_telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  telegram_user_id TEXT CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  post_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','exchanging','verified','completed','failed','cancelled')),
  grant_revision BIGINT CHECK (grant_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '10 minutes',
  CHECK ((state IN ('pending','exchanging') AND state_hash IS NOT NULL AND secret_ciphertext IS NOT NULL)
    OR (state NOT IN ('pending','exchanging') AND state_hash IS NULL AND secret_ciphertext IS NULL)),
  CHECK (state NOT IN ('verified','completed') OR (telegram_user_id IS NOT NULL AND telegram_user_id=expected_telegram_user_id)),
  CHECK (state <> 'completed' OR grant_revision IS NOT NULL)
);
CREATE INDEX telegram_link_transactions_account ON telegram_link_transactions(account_id, expires_at);
CREATE INDEX telegram_link_transactions_expiry ON telegram_link_transactions(expires_at);

-- Reconnect changes the ingress epoch even for the same stable bot. It fences
-- pending actions without deleting independently proven identity or same-bot consent.
CREATE FUNCTION fence_telegram_learner_linking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.record->>'botEpoch') IS DISTINCT FROM (OLD.record->>'botEpoch')
    OR (NEW.record->>'status') IS DISTINCT FROM (OLD.record->>'status')
    OR (NEW.record->>'botId') IS DISTINCT FROM (OLD.record->>'botId') THEN
    UPDATE telegram_link_navigation SET cancelled=TRUE WHERE community_id=NEW.community_id;
    UPDATE telegram_link_transactions SET state='cancelled', state_hash=NULL, secret_ciphertext=NULL
      WHERE community_id=NEW.community_id AND state IN ('pending','exchanging','verified');
    IF NEW.record->>'botId' IS NOT NULL THEN
      UPDATE telegram_bot_grants SET active=FALSE, revision=revision+1
        WHERE community_id=NEW.community_id AND bot_id<>NEW.record->>'botId' AND active;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telegram_learner_generation_fence AFTER UPDATE ON community_telegram_integrations
  FOR EACH ROW EXECUTE FUNCTION fence_telegram_learner_linking();

CREATE FUNCTION revoke_deleted_account_telegram_linking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE telegram_bot_grants SET active=FALSE,revision=revision+1 WHERE account_id=NEW.user_id AND active;
    UPDATE telegram_link_transactions SET state='cancelled',state_hash=NULL,secret_ciphertext=NULL
      WHERE account_id=NEW.user_id AND state IN ('pending','exchanging','verified');
    DELETE FROM telegram_account_associations WHERE account_id=NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deleted_account_telegram_linking_fence AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION revoke_deleted_account_telegram_linking();
