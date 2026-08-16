-- Enforce global single-use of a buyer funding tx per community: the same on-chain
-- payment (effect_key = tx hash) may back at most one buyer_funding_receipt effect,
-- regardless of quote. This is the race-safe backstop for the application-level check
-- in confirmBuyerFundingForSettlement, and closes the replay where one payment settles
-- multiple quotes (free paid content / operator royalty-fronting drain).
--
-- Partial index so other effect kinds are unaffected, and so the existing
-- (community_id, quote_id, effect_kind, effect_key) unique index (same-quote
-- idempotency) is preserved.
--
-- PREFLIGHT before applying to a populated shard — creation FAILS if duplicates exist,
-- which would themselves indicate prior replay; investigate any hits first:
--   SELECT community_id, effect_key, COUNT(*) AS c
--   FROM purchase_settlement_effects
--   WHERE effect_kind = 'buyer_funding_receipt'
--   GROUP BY community_id, effect_key HAVING c > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_settlement_effects_funding_tx_singleuse
  ON purchase_settlement_effects(community_id, effect_key)
  WHERE effect_kind = 'buyer_funding_receipt';
