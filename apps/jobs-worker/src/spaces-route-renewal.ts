import type { AlertSink } from "@pirate/platform-cf";
import type { SpacesRouteRenewalOutcome } from "@pirate/platform-cf/spaces-community-route-attachment-repository";
import { Effect } from "effect";
import {
  defaultRetrySchedule,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";

const severity: SeverityMapping = {
  expectedFailure: {},
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

const reads = [
  "postgres:community_canonical_route_bindings",
  "postgres:community_route_ownership_evidence",
] as const satisfies readonly TableKey[];
const writes = [
  "postgres:spaces_community_route_renewals",
  "postgres:community_route_ownership_evidence",
  "postgres:community_canonical_route_bindings",
] as const satisfies readonly TableKey[];

/**
 * Extends the ownership lease of live Spaces community addresses and suspends
 * one whose owner changed. Correctness never depends on this job running: an
 * unrenewed lease simply stops resolving at its database deadline.
 */
export function makeSpacesRouteRenewalJob(
  sink: AlertSink,
  renew: () => Promise<readonly SpacesRouteRenewalOutcome[]>,
): JobDeclaration<unknown> {
  return {
    name: "spaces-native.route-renewal",
    lane: "spaces-native-route-renewal",
    schedule: "*/5 * * * *",
    timeout: "90 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: [],
    severity,
    reads,
    writes,
    alertSink: sink,
    run: Effect.promise(renew),
  };
}
