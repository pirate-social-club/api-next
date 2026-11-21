import { Schema } from "effect";
export const Code = Schema.Literals([
  "consent_required",
  "publication_pending",
  "maturity_pending",
  "submission_not_enabled",
  "consent_expired",
  "publication_deadline",
  "maturity_deadline",
  "cancelled",
  "ownership_changed",
  "delegation_revoked",
  "observer_timeout",
  "observer_stale",
  "observer_disagreement",
  "chain_freshness_unconfirmed",
  "transfer_pending",
  "invalid_request",
  "invalid_signature",
  "request_conflict",
  "revision_conflict",
  "binding_mismatch",
  "body_too_large",
  "operation_unknown",
  "resource_snapshot_changed",
  "resource_capacity_exceeded",
  "delegation_conflict",
  "delegation_target_inactive",
  "observation_pending",
  "internal_error",
  "ownership_history_unavailable",
  "namespace_not_owned",
  "not_allowlisted",
  "publication_not_enabled",
  "authorization_expired",
]);
export type Code = typeof Code.Type;
export const unavailableCodes: readonly Code[] = [
  "observer_timeout",
  "observer_stale",
  "observer_disagreement",
  "chain_freshness_unconfirmed",
  "internal_error",
  "ownership_history_unavailable",
];

export const actionCodes: readonly Code[] = [
  "delegation_conflict",
  "delegation_target_inactive",
  "resource_capacity_exceeded",
  "resource_snapshot_changed",
  "publication_not_enabled",
  "consent_expired",
];

export const ConflictDetail = Schema.Literals([
  "duplicate_chain",
  "malformed_record",
  "ambiguous_routing",
  "active_registry_mismatch",
  "challenge_present",
]);
export type ConflictDetail = typeof ConflictDetail.Type;
