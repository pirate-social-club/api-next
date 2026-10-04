-- Pending observations do not consume a recovery attempt. Retain their
-- immutable history while allowing the next poll to use the unspent ordinal.
-- Other revalidation modes retain their original unconditional uniqueness.
ALTER TABLE community_route_revalidation_completion_attempts
  DROP CONSTRAINT community_route_revalidation_attempts_number_unique;

CREATE UNIQUE INDEX community_route_revalidation_attempts_number_unique
  ON community_route_revalidation_completion_attempts (
    route_revalidation_id, attempt_number
  )
  WHERE operation_mode <> 'same_root_recovery' OR state <> 'released';
