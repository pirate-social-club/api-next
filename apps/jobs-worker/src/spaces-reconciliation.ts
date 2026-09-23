import {
  AlertCollector,
  type HandleSalesStorageFailed,
  type SpacesFinalIssuanceVerifier,
  type SpacesReconciliationStore,
} from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect, Result } from "effect";
import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";

const CAPACITY = 8;
const VERIFY_TIMEOUT = "8 seconds";

/** A verifier failure or missing certificate leaves the claim pending. A
 * crashed tick leaves a finite lease that the next tick can acquire. */
const runSpacesReconciliationCycle = Effect.fn("runSpacesReconciliationCycle")(function* (
  store: SpacesReconciliationStore,
  verifier: SpacesFinalIssuanceVerifier,
  overdueThresholdSeconds: number,
): Effect.fn.Return<void, HandleSalesStorageFailed, AlertCollector> {
  const collector = yield* AlertCollector;
  yield* store.markOverdue(overdueThresholdSeconds, CAPACITY);
  for (const claimId of yield* store.unalertedOverdue(CAPACITY)) {
    yield* collector.emit({
      key: "spaces-native:issuance-overdue",
      severity: "high",
      body: "A Spaces name request has passed the configured overdue alert threshold.",
      entity: `claim:${claimId}`,
    });
    yield* store.markOverdueAlerted(claimId);
  }
  for (const anomaly of yield* store.unalertedScopeAnomalies(CAPACITY)) {
    yield* collector.emit({
      key: "spaces-native:registry-scope-anomaly",
      severity: "high",
      body: `A Spaces registry request was refused for scope reason ${anomaly.reason}.`,
      entity: `anomaly:${anomaly.anomaly_id}`,
    });
    yield* store.markScopeAnomalyAlerted(anomaly.anomaly_id);
  }
  const due = yield* store.leaseDue(CAPACITY);
  for (const target of due) {
    const result = yield* Effect.result(
      verifier.verify(target).pipe(Effect.timeout(VERIFY_TIMEOUT)),
    );
    if (Result.isFailure(result) || result.success.kind === "pending") {
      yield* store.retryLater(target);
      continue;
    }
    if (result.success.kind === "occupied_other") {
      yield* store.recordConflict(
        target,
        result.success.observed_script_pubkey_hex,
        result.success.evidence,
      );
    } else {
      yield* store.finalize(target, result.success.evidence);
    }
  }
});

const severity: SeverityMapping = {
  expectedFailure: { HandleSalesStorageFailed: "high" },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

const reads = [
  "postgres:handle_claims",
  "postgres:spaces_registry_items",
  "postgres:personas",
  "postgres:community_handle_offering_revisions",
] as const satisfies readonly TableKey[];

const writes = [
  "postgres:spaces_issuance_verifications",
  "postgres:spaces_final_issuance_evidence",
  "postgres:spaces_final_conflict_evidence",
  "postgres:spaces_external_conflict_observations",
  "postgres:spaces_registry_scope_anomalies",
  "postgres:handle_claims",
  "postgres:spaces_registry_items",
  "postgres:handle_key_fences",
  "postgres:handle_account_offering_grant_counters",
  "postgres:handle_grants",
] as const satisfies readonly TableKey[];

/** Only an explicitly supplied independent verifier can register this job. */
export function makeSpacesReconciliationJob(
  sink: AlertSink,
  store: SpacesReconciliationStore,
  verifier: SpacesFinalIssuanceVerifier,
  options: Readonly<{ overdueThresholdSeconds: number; measurementReference: string }>,
): JobDeclaration<unknown, AlertCollector> {
  if (
    !Number.isSafeInteger(options.overdueThresholdSeconds) ||
    options.overdueThresholdSeconds < 1 ||
    options.overdueThresholdSeconds > 31_536_000 ||
    options.measurementReference.trim().length === 0
  )
    throw new TypeError("Spaces reconciliation requires a measured overdue threshold");
  const run = runSpacesReconciliationCycle(store, verifier, options.overdueThresholdSeconds).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );
  return {
    name: "spaces-native.final-issuance",
    lane: "spaces-native-reconciliation",
    schedule: "* * * * *",
    timeout: "90 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: ["HandleSalesStorageFailed"],
    severity,
    reads,
    writes,
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
