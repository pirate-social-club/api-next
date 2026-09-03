-- Spec 015 §4.2: each reward leg freezes the exact song owner policy
-- revision and hash that authorized it. Legacy legs predate the policy system
-- entirely (migration 0107 is forward-only from here), so their policy
-- evidence is represented honestly as legacy_pre_policy with NULL revision
-- and hash. The offer creation snapshot is never substituted: it proves
-- offer-time policy, not the policy that authorized a later leg.
ALTER TABLE song_reward_offer_legs
  ADD COLUMN owner_policy_kind TEXT NOT NULL DEFAULT 'legacy_pre_policy'
    CHECK (owner_policy_kind IN ('frozen_policy', 'legacy_pre_policy')),
  ADD COLUMN owner_policy_revision BIGINT
    CHECK (
      owner_policy_revision IS NULL
      OR owner_policy_revision BETWEEN 1 AND 9007199254740991
    ),
  ADD COLUMN owner_policy_hash TEXT
    CHECK (owner_policy_hash IS NULL OR owner_policy_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT song_reward_offer_leg_policy_evidence CHECK (
    (
      owner_policy_kind = 'frozen_policy'
      AND owner_policy_revision IS NOT NULL
      AND owner_policy_hash IS NOT NULL
    )
    OR (
      owner_policy_kind = 'legacy_pre_policy'
      AND owner_policy_revision IS NULL
      AND owner_policy_hash IS NULL
    )
  );
