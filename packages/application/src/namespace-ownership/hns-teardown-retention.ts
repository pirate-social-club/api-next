import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";

/**
 * Authority retention decision before any retirement — spec 012
 * "Authority retention, quota, and retirement" (2026-09-09 amendment).
 * DNS authority is retained independently of import status; retirement
 * requires positive evidence, and a terminal decision never implies
 * teardown. This pure gate applies to teardown_provisional_root_v1,
 * teardown_root_v1, partial provisioning, exhausted retries, ambiguous
 * provider responses, older name-signature sessions, and successor
 * reservations.
 */

export type HnsTeardownKindV1 = "teardown_provisional_root_v1" | "teardown_root_v1";

export type HnsTeardownRetentionDecisionV1 = Readonly<{
  readonly decision: "retain" | "retire_eligible";
  readonly reason:
    | "chain_reference_retained"
    | "unavailable_chain_state_retained"
    | "chain_absence_after_exposure_retained"
    | "retirement_positive_evidence";
  readonly inspected_views: readonly ("current" | "safe")[];
}>;

export function decideHnsTeardownRetentionV1(
  input: Readonly<{
    readonly teardown_kind: HnsTeardownKindV1;
    /** The exposed plan's encoded-resource digest, when one exists. */
    readonly plan_encoded_resource_sha256: string | null;
    readonly current: HnsChainObservationResultV1 | null;
    readonly safe: HnsChainObservationResultV1 | null;
    /**
     * True only for positive evidence: a fresh current and safe inspection
     * showing no reference in either view after the exposure-horizon
     * analysis. An empty safe resource plus an empty node mempool does not
     * establish transaction absence.
     */
    readonly positive_absence_evidence: boolean;
  }>,
): HnsTeardownRetentionDecisionV1 {
  const inspectedViews: ("current" | "safe")[] = [];
  for (const [view, result] of [
    ["current", input.current],
    ["safe", input.safe],
  ] as const) {
    if (result === null) {
      // Unknown or unavailable chain state retains authority pending
      // another inspection; no result is inferred from missing evidence.
      return {
        decision: "retain",
        reason: "unavailable_chain_state_retained",
        inspected_views: inspectedViews,
      };
    }
    if (result.kind === "unavailable" || result.kind === "finding") {
      return {
        decision: "retain",
        reason: "unavailable_chain_state_retained",
        inspected_views: inspectedViews,
      };
    }
    if (
      input.plan_encoded_resource_sha256 !== null &&
      result.observation.resource_sha256 === input.plan_encoded_resource_sha256
    ) {
      // A reference to the retained zone or plan from either view retains
      // authority.
      return {
        decision: "retain",
        reason: "chain_reference_retained",
        inspected_views: [...inspectedViews, view],
      };
    }
    inspectedViews.push(view);
  }
  if (input.positive_absence_evidence) {
    return {
      decision: "retire_eligible",
      reason: "retirement_positive_evidence",
      inspected_views: inspectedViews,
    };
  }
  // Chain absence after exposure alone is insufficient to authorize
  // deletion: the owner may broadcast the issued plan later.
  return {
    decision: "retain",
    reason: "chain_absence_after_exposure_retained",
    inspected_views: inspectedViews,
  };
}
