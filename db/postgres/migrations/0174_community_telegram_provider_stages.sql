-- Inbox replay previously re-ran transcription and completion after any
-- interruption, repeating billable provider work and sometimes replacing an
-- answer that was already produced. A usage reservation is keyed to the inbox
-- item, but it records only that the item was admitted, not whether a provider
-- call succeeded or what it returned.
--
-- This table stores one durable stage per inbox item. An attempt inserts the
-- row as `issued` before calling the provider, then records the result as
-- `completed` or a definite failure as `failed`. Confirmed results are reused
-- on replay. A stage still `issued` by a previous attempt cannot be resolved
-- from the database: the provider may or may not have processed the request,
-- so recovery never silently repeats the paid call. Definitive failures may
-- be re-issued within the inbox attempt budget.

CREATE TABLE community_telegram_provider_stages (
  community_id TEXT NOT NULL REFERENCES community_telegram_integrations(community_id),
  bot_epoch TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES community_telegram_inbox(inbox_id),
  stage TEXT NOT NULL CHECK (stage IN ('transcription','completion')),
  request_hash TEXT NOT NULL,
  attempt TEXT,
  state TEXT NOT NULL CHECK (state IN ('issued','completed','failed')),
  result TEXT,
  error TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, bot_epoch, inbox_id, stage),
  CHECK ((state = 'completed') = (result IS NOT NULL))
);
CREATE INDEX community_telegram_provider_stage_cleanup
  ON community_telegram_provider_stages(issued_at);
