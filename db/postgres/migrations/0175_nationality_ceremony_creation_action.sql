-- Spec 006 sections 2.2 and 3: the creator of a nationality-gated community
-- must satisfy the same composed member policy as a joining member, through
-- the same provider-choice ceremony. The nationality ceremony tables already
-- model multi-provider states and generations; widening their action-kind
-- check to include `community_creation` lets the creator ceremony reuse that
-- lifecycle instead of building a second one. Join and claim rows are
-- unaffected.
ALTER TABLE nationality_ceremony_attempts
  DROP CONSTRAINT nationality_ceremony_attempts_action_kind_check;

ALTER TABLE nationality_ceremony_attempts
  ADD CONSTRAINT nationality_ceremony_attempts_action_kind_check
  CHECK ((action_kind = ANY (ARRAY['community_join'::text, 'handle_claim'::text, 'community_creation'::text])));

ALTER TABLE nationality_requirement_states
  DROP CONSTRAINT nationality_requirement_states_action_kind_check;

ALTER TABLE nationality_requirement_states
  ADD CONSTRAINT nationality_requirement_states_action_kind_check
  CHECK ((action_kind = ANY (ARRAY['community_join'::text, 'handle_claim'::text, 'community_creation'::text])));
