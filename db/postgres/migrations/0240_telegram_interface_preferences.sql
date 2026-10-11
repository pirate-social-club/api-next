-- Interface choices are private to one sender and stable community bot identity.
-- They survive ingress/token rotation and never write Study helper preferences.
CREATE TABLE telegram_interface_preferences (
  community_id text NOT NULL REFERENCES communities(community_id),
  bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  locale text NOT NULL CHECK (locale IN ('en','ru','ka')),
  explicit boolean NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (community_id,bot_id,telegram_user_id)
);
