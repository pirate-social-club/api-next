/**
 * Spaces sale-namespace readiness and authority drift (spec 012 §5.3.13.3 and
 * §5.3.13.4). Pure: callers load the current authority evidence, operator
 * assignment, observations, and driver revision, and apply the decision.
 * Readiness is derived from current facts every time, and anything not
 * observed fails closed (ruling Q6).
 */

/** The owner sees one reason at a time, in this ratified order. */
export const SPACES_SALE_READINESS_REASONS_V1 = [
  "namespace_authority_unavailable",
  "owner_challenge_required",
  "anchor_pending",
  "publication_unverified",
  "delegation_required",
  "operator_capability_unverified",
  "commitment_history_unverified",
  "driver_disabled",
] as const;

export type SpacesSaleReadinessReasonV1 = (typeof SPACES_SALE_READINESS_REASONS_V1)[number];

/** One fact per reason. `null` means not observed and is never treated as satisfied. */
export type SpacesSaleReadinessFactsV1 = Readonly<{
  /** Current evidence for `(network, root)`: the live root resolves within its anchor freshness bound. */
  namespace_authority_current: boolean | null;
  /** An owner-signed challenge under the current key, completed after the key last changed. */
  owner_challenge_current: boolean | null;
  /** An accepted anchor covers the live root outpoint. */
  anchor_covers_root_outpoint: boolean | null;
  /** Publication verified under the current key. */
  publication_verified: boolean | null;
  /** Delegation to the assigned wallet, observed through a node independent of the operator host. */
  delegation_observed: boolean | null;
  /** The operator host observed that the assigned wallet can operate the space. */
  operator_capability_observed: boolean | null;
  /**
   * Commitment count and latest root observed through a node that answers
   * delegation and commitment-history queries, and any history not produced
   * by retained operator state proven to correspond to the chain.
   */
  commitment_history_verified: boolean | null;
  /** An enabled Spaces issuance driver revision exists for this activation. */
  driver_enabled: boolean | null;
}>;

export type SpacesSaleReadinessV1 =
  | Readonly<{ kind: "ready_v1" }>
  | Readonly<{ kind: "not_ready_v1"; reason: SpacesSaleReadinessReasonV1 }>;

const FACT_FOR_REASON: Readonly<
  Record<SpacesSaleReadinessReasonV1, keyof SpacesSaleReadinessFactsV1>
> = {
  namespace_authority_unavailable: "namespace_authority_current",
  owner_challenge_required: "owner_challenge_current",
  anchor_pending: "anchor_covers_root_outpoint",
  publication_unverified: "publication_verified",
  delegation_required: "delegation_observed",
  operator_capability_unverified: "operator_capability_observed",
  commitment_history_unverified: "commitment_history_verified",
  driver_disabled: "driver_enabled",
};

export function deriveSpacesSaleReadinessV1(
  facts: SpacesSaleReadinessFactsV1,
): SpacesSaleReadinessV1 {
  for (const reason of SPACES_SALE_READINESS_REASONS_V1) {
    if (facts[FACT_FOR_REASON[reason]] !== true) return { kind: "not_ready_v1", reason };
  }
  return { kind: "ready_v1" };
}

/** A fresh observation of the root through a verifier independent of the operator host. */
export type SpacesRootObservationV1 = Readonly<{
  observed_at_epoch_ms: number;
  root:
    | Readonly<{ kind: "resolved"; outpoint: string; key: string }>
    | Readonly<{ kind: "unresolved" }>;
  anchor: Readonly<{ anchored_at_epoch_ms: number; covers_root_outpoint: boolean }>;
  delegation: "observed" | "absent";
  publication: "verified" | "failed";
}>;

/** Freshness bounds are measured configuration, not contract constants. */
export type SpacesAuthorityFreshnessV1 = Readonly<{
  observation_max_age_ms: number;
  anchor_max_age_ms: number;
}>;

export type SpacesAuthorityLossReasonV1 =
  | "authority_unresolved"
  | "anchor_stale"
  | "delegation_lost"
  | "publication_failed";

export type SpacesAuthorityDriftV1 =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "anchor_lag" }>
  | Readonly<{ kind: "indeterminate" }>
  | Readonly<{ kind: "key_changed"; observed_root_key: string }>
  | Readonly<{ kind: "authority_lost"; reason: SpacesAuthorityLossReasonV1 }>;

/**
 * Classifies one observation against the key the current evidence was
 * established under. A missing or stale observation is indeterminate: it
 * fails closed but is never evidence of loss, so dependency degradation
 * cannot revoke. A changed key supersedes the evidence before any anchor,
 * delegation, or publication fact is judged against it. Ordinary anchor lag
 * with an unchanged key and delegation is retryable, never a loss.
 */
export function classifySpacesAuthorityObservationV1(input: {
  evidence_root_key: string;
  observation: SpacesRootObservationV1 | null;
  now_epoch_ms: number;
  freshness: SpacesAuthorityFreshnessV1;
}): SpacesAuthorityDriftV1 {
  const { observation, now_epoch_ms: now, freshness } = input;
  if (
    observation === null ||
    now - observation.observed_at_epoch_ms > freshness.observation_max_age_ms
  ) {
    return { kind: "indeterminate" };
  }
  if (observation.root.kind === "unresolved") {
    return { kind: "authority_lost", reason: "authority_unresolved" };
  }
  if (observation.root.key !== input.evidence_root_key) {
    return { kind: "key_changed", observed_root_key: observation.root.key };
  }
  if (now - observation.anchor.anchored_at_epoch_ms > freshness.anchor_max_age_ms) {
    return { kind: "authority_lost", reason: "anchor_stale" };
  }
  if (observation.delegation === "absent") {
    return { kind: "authority_lost", reason: "delegation_lost" };
  }
  if (observation.publication === "failed") {
    return { kind: "authority_lost", reason: "publication_failed" };
  }
  return observation.anchor.covers_root_outpoint ? { kind: "current" } : { kind: "anchor_lag" };
}

export type SpacesAuthorityResponseV1 = Readonly<{
  /** New quotes, reservations, and claims stop. */
  stop_commerce: boolean;
  /** Staging, commit, and broadcast stop. */
  stop_irreversible_operator_steps: boolean;
  /** The activation advances to `suspended` with a new generation. */
  suspend_activation: boolean;
  /** Fresh live-root evidence and a fresh owner challenge from the same controlling account. */
  require_reauthorization: boolean;
}>;

const response = (
  stop_commerce: boolean,
  stop_irreversible_operator_steps: boolean,
  suspend_activation: boolean,
  require_reauthorization: boolean,
): SpacesAuthorityResponseV1 => ({
  stop_commerce,
  stop_irreversible_operator_steps,
  suspend_activation,
  require_reauthorization,
});

/**
 * Observation and reconciliation of existing claims continue under every
 * drift; only new commerce and irreversible operator steps stop. Anchor lag
 * blocks new quotes but is not a listed irreversible-step stop, and the
 * driver's own chain check before each step still applies.
 */
export function spacesAuthorityResponseV1(
  drift: SpacesAuthorityDriftV1,
): SpacesAuthorityResponseV1 {
  switch (drift.kind) {
    case "current":
      return response(false, false, false, false);
    case "anchor_lag":
      return response(true, false, false, false);
    case "indeterminate":
      return response(true, true, false, false);
    case "key_changed":
      return response(true, true, false, true);
    case "authority_lost":
      return response(true, true, true, false);
  }
}

export type SpacesOwnerChallengeV1 = Readonly<{
  root_key: string;
  controlling_account_id: string;
  completed_at_epoch_ms: number;
}>;

export type SpacesReauthorizationV1 =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{
      kind: "refused";
      reason:
        | "challenge_required"
        | "challenge_key_mismatch"
        | "challenge_predates_key_change"
        | "controlling_account_changed";
    }>;

/**
 * After a key change, only a challenge signed under the observed key,
 * completed after the change, by the activation's own controlling account
 * reauthorizes. Chain ancestry alone never transfers an activation.
 */
export function assessSpacesReauthorizationV1(input: {
  activation_controlling_account_id: string;
  observed_root_key: string;
  key_last_changed_at_epoch_ms: number;
  challenge: SpacesOwnerChallengeV1 | null;
}): SpacesReauthorizationV1 {
  const { challenge } = input;
  if (challenge === null) return { kind: "refused", reason: "challenge_required" };
  if (challenge.root_key !== input.observed_root_key) {
    return { kind: "refused", reason: "challenge_key_mismatch" };
  }
  if (challenge.completed_at_epoch_ms <= input.key_last_changed_at_epoch_ms) {
    return { kind: "refused", reason: "challenge_predates_key_change" };
  }
  if (challenge.controlling_account_id !== input.activation_controlling_account_id) {
    return { kind: "refused", reason: "controlling_account_changed" };
  }
  return { kind: "accepted" };
}
