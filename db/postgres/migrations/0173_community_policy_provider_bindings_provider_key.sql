-- Spec 006 section 2.2 and the 2026-09-12 slice order: a community policy
-- version may carry one provider binding row per accepted provider, so a
-- nationality policy version can hold both the Self and ZKPassport
-- alternatives. The old primary key allowed exactly one row per policy
-- version, which forced the join-time query to pin a single provider across
-- every binding column. Widening the key to include provider_id preserves
-- every existing Palm row unchanged (one row, one provider) and keeps the
-- v1 sixteen-column pin correct, while admitting the two-alternative
-- nationality rows. Provider pair validity is enforced by the writing
-- transaction, not by this constraint, so a drifted binding row remains
-- seedable and the read path still fails closed on it.
ALTER TABLE community_policy_provider_bindings
  DROP CONSTRAINT community_policy_provider_bindings_pkey;

ALTER TABLE community_policy_provider_bindings
  ADD CONSTRAINT community_policy_provider_bindings_pkey
  PRIMARY KEY (community_id, policy_key, policy_version_id, provider_id);
