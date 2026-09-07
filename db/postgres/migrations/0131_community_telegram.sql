-- Credentials contain only versioned authenticated ciphertext; views are projected in application code.
CREATE TABLE community_telegram_integrations (
  community_id TEXT PRIMARY KEY REFERENCES communities(community_id),
  revision BIGINT NOT NULL CHECK (revision > 0),
  bot_epoch TEXT NOT NULL,
  bot_id TEXT UNIQUE,
  webhook_id TEXT UNIQUE,
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE community_telegram_commands (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  command_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, command_key)
);
CREATE TABLE community_telegram_setups (
  setup_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE community_telegram_inbox (
  inbox_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  update_id BIGINT NOT NULL CHECK (update_id >= 0),
  payload JSONB,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','failed','cancelled')),
  attempt TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (community_id, bot_epoch, update_id)
);
CREATE INDEX community_telegram_inbox_due ON community_telegram_inbox(next_attempt_at) WHERE state IN ('pending','processing');
CREATE TABLE community_telegram_deliveries (
  delivery_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publication','reply','voice','setup')),
  post_id TEXT REFERENCES posts(post_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','delivered','failed','uncertain','withdrawn','cancelled')),
  desired JSONB,
  desired_hash TEXT,
  confirmed JSONB,
  confirmed_hash TEXT,
  message_id BIGINT CHECK (message_id > 0),
  attempt TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((desired IS NULL) = (desired_hash IS NULL)),
  CHECK ((confirmed IS NULL) = (confirmed_hash IS NULL))
);
CREATE INDEX community_telegram_delivery_due ON community_telegram_deliveries(next_attempt_at) WHERE state IN ('pending','failed','sending');
CREATE UNIQUE INDEX community_telegram_publication_destination ON community_telegram_deliveries(community_id,bot_epoch,chat_id,post_id) WHERE kind = 'publication';
CREATE TABLE community_telegram_usage (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  usage_day DATE NOT NULL,
  subject TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0 CHECK (messages >= 0),
  speech_characters INTEGER NOT NULL DEFAULT 0 CHECK (speech_characters >= 0),
  PRIMARY KEY (community_id,usage_day,subject)
);
CREATE TABLE community_telegram_usage_reservations (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  reservation_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,bot_epoch,reservation_key)
);
CREATE TABLE community_telegram_conversations (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  telegram_user_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  prompt TEXT NOT NULL CHECK (length(prompt) <= 4000),
  answer TEXT NOT NULL CHECK (length(answer) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,input_id)
);
CREATE INDEX community_telegram_conversation_recent ON community_telegram_conversations(community_id,telegram_user_id,created_at DESC);
CREATE TABLE community_telegram_private_chats (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,bot_epoch,telegram_user_id)
);
