import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import {
  type HnsRetainedAuthorityReferenceV1,
  hnsObservationReferencesAuthorityV1,
} from "./hns-teardown-retention.ts";

/**
 * One retention review — spec 012, "Authority retention, quota, and
 * retirement" and `retention_review_v1`.
 *
 * A review is a durable record of one fresh current-and-safe inspection of one
 * authority generation. It never expresses a wall-clock permission: the review
 * time schedules the next review and bounds evidence age, and never substitutes
 * for the inspection.
 *
 * This decides what the inspection shows, and it deliberately cannot decide
 * that absence authorizes deletion. The spec's positive-evidence clause reads
 * "fresh inspection showing no reference in either view after the
 * exposure-horizon analysis", and no exposure-horizon analysis is defined
 * anywhere in the specification or the code. Absence with no such analysis is
 * exactly the reading the spec forbids two sentences earlier — "the owner may
 * broadcast the issued plan later" — so a clean inspection records `retain`
 * with a reason naming the missing analysis, rather than inventing a horizon
 * that would authorize deleting live infrastructure. Retirement stays reachable
 * only through an explicit operator supersession, which is an authorization
 * recorded outside any inspection and never derived from the chain.
 */

export type HnsRetentionReviewDecisionV1 = "retain" | "retire_authorized" | "superseded";

export type HnsRetentionReviewReasonV1 =
  | "chain_reference_retained"
  | "unavailable_chain_state_retained"
  | "unknown_provenance_retained"
  | "exposure_horizon_undetermined_retained";

export type HnsRetentionReviewV1 = Readonly<{
  readonly decision: Extract<HnsRetentionReviewDecisionV1, "retain">;
  readonly reason: HnsRetentionReviewReasonV1;
  readonly inspected_views: readonly ("current" | "safe")[];
  readonly current_observed_at_epoch_ms: number | null;
  readonly safe_observed_at_epoch_ms: number | null;
  readonly current_resource_sha256: string | null;
  readonly safe_resource_sha256: string | null;
  /** Stable per inspection, so a redelivered review is recognised as a replay. */
  readonly evidence_ref: string;
}>;

export type HnsRetentionReviewInputV1 = Readonly<{
  /**
   * What the operation's retained plan asserts on the name. Null when the
   * plan's provenance could not be established — an unreadable or absent plan
   * document. Unknown provenance retains: with no idea what the authority
   * published, no inspection can show it is unreferenced.
   */
  readonly authority: HnsRetainedAuthorityReferenceV1 | null;
  readonly current: HnsChainObservationResultV1 | null;
  readonly safe: HnsChainObservationResultV1 | null;
}>;

function observedAt(result: HnsChainObservationResultV1 | null): number | null {
  return result !== null && result.kind === "observed"
    ? result.observation.observed_at_epoch_ms
    : null;
}

function resourceDigest(result: HnsChainObservationResultV1 | null): string | null {
  return result !== null && result.kind === "observed" ? result.observation.resource_sha256 : null;
}

/** A reference to the inspection, stable for the same pair of reads. */
function inspectionRef(input: HnsRetentionReviewInputV1): string {
  const part = (view: string, result: HnsChainObservationResultV1 | null): string => {
    if (result === null) return `${view}:absent`;
    if (result.kind === "observed") {
      return `${view}:${result.observation.anchor.height}:${result.observation.resource_sha256.slice(0, 16)}`;
    }
    return `${view}:${result.kind}:${result.classification}`;
  };
  return `review:${part("current", input.current)}:${part("safe", input.safe)}`;
}

export function decideHnsRetentionReviewV1(input: HnsRetentionReviewInputV1): HnsRetentionReviewV1 {
  const base = {
    decision: "retain",
    current_observed_at_epoch_ms: observedAt(input.current),
    safe_observed_at_epoch_ms: observedAt(input.safe),
    current_resource_sha256: resourceDigest(input.current),
    safe_resource_sha256: resourceDigest(input.safe),
    evidence_ref: inspectionRef(input),
  } as const;

  if (input.authority === null) {
    return { ...base, reason: "unknown_provenance_retained", inspected_views: [] };
  }

  const inspectedViews: ("current" | "safe")[] = [];
  for (const [view, result] of [
    ["current", input.current],
    ["safe", input.safe],
  ] as const) {
    if (result === null || result.kind === "unavailable" || result.kind === "finding") {
      // No result is inferred from unavailable evidence, and a finding about
      // the name is not an inspection of the authority's references.
      return {
        ...base,
        reason: "unavailable_chain_state_retained",
        inspected_views: inspectedViews,
      };
    }
    if (hnsObservationReferencesAuthorityV1(result.observation.records, input.authority)) {
      return {
        ...base,
        reason: "chain_reference_retained",
        inspected_views: [...inspectedViews, view],
      };
    }
    inspectedViews.push(view);
  }

  // Both views inspected, neither references the authority. This is where the
  // spec's positive-evidence clause would apply, and its exposure-horizon
  // analysis does not exist. Recorded as a retaining review carrying that
  // reason, so the gap stays visible in the evidence rather than resolved by
  // guessing.
  return {
    ...base,
    reason: "exposure_horizon_undetermined_retained",
    inspected_views: inspectedViews,
  };
}

/**
 * When a retention review is due. The initial review of an operation's
 * authority follows its terminal decision by `first_seconds`; every review
 * thereafter recurs at `recurring_seconds`. Both come from the frozen policy,
 * and neither is ever read as permission to delete anything.
 */
export function hnsRetentionReviewDueAtV1(
  nowEpochMs: number,
  policy: Readonly<{
    readonly retention_review: Readonly<{
      readonly first_seconds: number;
      readonly recurring_seconds: number;
    }>;
  }>,
  cadence: "initial" | "recurring",
): number {
  const seconds =
    cadence === "initial"
      ? policy.retention_review.first_seconds
      : policy.retention_review.recurring_seconds;
  return nowEpochMs + seconds * 1_000;
}
