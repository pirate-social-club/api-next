import type { SpacesRootObservationInputV1, SpacesSaleNamespaceStore } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import type { SpacesRootAuthorityObserver } from "@pirate/platform-cf/spaces-owner-proof-repository";
import type {
  SpacesRootObservationTarget,
  SpacesRootObservationTargets,
} from "@pirate/platform-cf/spaces-root-observation-targets";
import { Effect, Result } from "effect";
import {
  defaultRetrySchedule,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";

const OBSERVATION_MAX_AGE_MS = 180_000;
const OBSERVER_REFERENCE = "spaces-independent-verifier-v1";
type Verified = Extract<
  Awaited<ReturnType<SpacesRootAuthorityObserver["observe"]>>,
  { kind: "verified" }
>;

const commitmentRoot = (evidence: Verified["evidence"]): string | null | undefined => {
  if (evidence.commitment_count === 0) return null;
  const latest = evidence.latest_commitment;
  if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return undefined;
  const root = (latest as Record<string, unknown>).state_root;
  return typeof root === "string" && /^[0-9a-f]{64}$/u.test(root) ? root : undefined;
};

/** No unverified commitment history is promoted into a ready observation. */
function makeSpacesRootObservationInput(
  target: SpacesRootObservationTarget,
  verified: Verified,
  observedAt: string,
): SpacesRootObservationInputV1 | null {
  const evidence = verified.evidence;
  const latestCommitmentRootHex = commitmentRoot(evidence);
  if (latestCommitmentRootHex === undefined || evidence.root !== `@${target.canonicalRoot}`) {
    return null;
  }
  // The timestamp is when this independent call established the anchored fact.
  // The verifier wire has no anchor timestamp; a block header time is not one.
  return {
    canonicalRoot: target.canonicalRoot,
    observerReference: OBSERVER_REFERENCE,
    observedAt,
    root: {
      kind: "resolved",
      outpoint: evidence.outpoint,
      key: evidence.owner_xonly_key_hex,
      anchoredAt: observedAt,
      anchorCoversRootOutpoint: evidence.anchor_bound_outpoint,
      publication: "verified",
      delegationAddress:
        evidence.operator_num_live &&
        evidence.reverse_delegation_matches &&
        evidence.operator_num_holder_script_pubkey_hex === target.delegationScript
          ? target.delegationAddress
          : null,
    },
    commitmentHistory: {
      kind: "verified",
      commitmentCount: evidence.commitment_count,
      latestCommitmentRootHex,
    },
    freshness: {
      observation_max_age_ms: OBSERVATION_MAX_AGE_MS,
      anchor_max_age_ms: OBSERVATION_MAX_AGE_MS,
    },
  };
}

const severity: SeverityMapping = {
  expectedFailure: { HandleSalesStorageFailed: "high" },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

const reads = [
  "postgres:spaces_operator_assignment_current",
] as const satisfies readonly TableKey[];
const writes = [
  "postgres:spaces_root_observations",
  "postgres:community_handle_sale_namespace_activation_current",
  "postgres:community_handle_sale_namespace_activation_revisions",
] as const satisfies readonly TableKey[];

/** Refreshes each configured root before its evidence expires. A pending or
 * unavailable verifier never creates a ready row. */
export function makeSpacesRootObservationJob(
  sink: AlertSink,
  targets: SpacesRootObservationTargets,
  observer: SpacesRootAuthorityObserver,
  saleNamespaces: Pick<SpacesSaleNamespaceStore, "recordRootObservation">,
): JobDeclaration<unknown> {
  const run = Effect.gen(function* () {
    for (const target of yield* targets.list()) {
      const result = yield* Effect.result(
        Effect.tryPromise(() => observer.observe({ canonicalRoot: target.canonicalRoot })),
      );
      if (Result.isFailure(result) || result.success.kind === "pending") continue;
      const observedAt = yield* targets.databaseNow();
      const input = makeSpacesRootObservationInput(target, result.success, observedAt);
      if (input === null) continue;
      yield* saleNamespaces.recordRootObservation(input);
    }
  });
  return {
    name: "spaces-native.root-observation",
    lane: "spaces-native-root-observation",
    schedule: "* * * * *",
    timeout: "90 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: ["HandleSalesStorageFailed"],
    severity,
    reads,
    writes,
    alertSink: sink,
    run,
  };
}
