-- Command replies were sent before any admission, so /start, /songs and setup
-- selection could burst without a durable bound, and the daily model budget
-- could not act as one. The usage row gains a separate command counter; the
-- reservation key keeps replay idempotent.
--
-- Queue batch size one does not serialize consumers, so two updates from one
-- chat could be processed concurrently and their replies delivered out of
-- order. This lease table serializes private-chat processing and spaces
-- consecutive replies by a minimum interval. A deferred item returns to
-- pending without spending an inbox attempt.

ALTER TABLE community_telegram_usage
  ADD COLUMN commands INTEGER NOT NULL DEFAULT 0 CHECK (commands >= 0);

CREATE TABLE community_telegram_chat_leases (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, bot_epoch, chat_id)
);
