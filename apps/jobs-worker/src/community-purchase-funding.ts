import {
  AlertCollector,
  ControlPlaneDb,
  makeCommunityPurchaseFundingDormancySweeper,
  makeCommunityPurchaseFundingInterpreter,
  makeCommunityPurchaseFundingObservationUseCase,
  makeCommunityPurchaseFundingReconciler,
} from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import {
  makeCommunityPurchaseFundingChainReader,
  makeControlPlaneCommunityPurchaseFundingQueryStore,
  makeControlPlaneCommunityPurchaseFundingStore,
} from "@pirate/platform-cf";
import { Effect, Layer } from "effect";

import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_JOB = "community-purchase-funding.reconcile";
export const COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_LANE = "money-reconciliation";
export const COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_SCHEDULE = "*/5 * * * *";
export const COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_TIMEOUT = "45 seconds";
export const COMMUNITY_PURCHASE_FUNDING_SUBMISSION_WINDOW_MS = 30 * 60 * 1_000;
export const COMMUNITY_PURCHASE_FUNDING_BATCH_LIMIT = 100;
export const COMMUNITY_PURCHASE_FUNDING_LEASE_MS = 30_000;

export const COMMUNITY_PURCHASE_FUNDING_READS = [
  "postgres:community_purchase_funding_journal",
  "postgres:community_purchase_funding_requests",
  "postgres:community_purchase_funding_transaction_claims",
  "postgres:community_purchase_funding_transitions",
  "postgres:community_purchase_funding_receipts",
] as const satisfies readonly TableKey[];

export const COMMUNITY_PURCHASE_FUNDING_WRITES = [
  "postgres:community_purchase_funding_journal",
  "postgres:community_purchase_funding_requests",
  "postgres:community_purchase_funding_transaction_claims",
  "postgres:community_purchase_funding_transitions",
  "postgres:community_purchase_funding_receipts",
] as const satisfies readonly TableKey[];

export const COMMUNITY_PURCHASE_FUNDING_SEVERITY: SeverityMapping = {
  expectedFailure: {
    CommunityPurchaseFundingQueryRejected: "medium",
    CommunityPurchaseFundingStorageFailed: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export function makeCommunityPurchaseFundingReconciliationJob(
  sink: AlertSink,
  rpcUrl: string,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const context = yield* JobContext;
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const runtime = Layer.succeed(ControlPlaneDb, db);
    const journal = makeControlPlaneCommunityPurchaseFundingStore(runtime);
    const query = makeControlPlaneCommunityPurchaseFundingQueryStore(runtime);
    const interpreter = makeCommunityPurchaseFundingInterpreter(journal);
    const observation = makeCommunityPurchaseFundingObservationUseCase(
      interpreter,
      makeCommunityPurchaseFundingChainReader({ rpcUrl }),
    );

    const reconciled = yield* makeCommunityPurchaseFundingReconciler(
      query,
      observation,
    )({
      limit: COMMUNITY_PURCHASE_FUNDING_BATCH_LIMIT,
      ownerId: context.owner,
      leaseMs: COMMUNITY_PURCHASE_FUNDING_LEASE_MS,
    });
    const dormant = yield* makeCommunityPurchaseFundingDormancySweeper(
      query,
      interpreter,
    )({
      limit: COMMUNITY_PURCHASE_FUNDING_BATCH_LIMIT,
      ownerId: `${context.owner}:dormancy`,
      leaseMs: COMMUNITY_PURCHASE_FUNDING_LEASE_MS,
      submissionWindowMs: COMMUNITY_PURCHASE_FUNDING_SUBMISSION_WINDOW_MS,
    });

    if (reconciled.failures.length > 0 || dormant.failures.length > 0) {
      yield* collector.emit({
        key: "community-purchase-funding:candidate-failures",
        severity: "medium",
        body: "Community purchase funding candidates require a later reconciliation pass.",
        entity: `reconciliation:${reconciled.failures.length}:dormancy:${dormant.failures.length}`,
      });
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_JOB,
    lane: COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_LANE,
    schedule: COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_SCHEDULE,
    timeout: COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: [
      "CommunityPurchaseFundingQueryRejected",
      "CommunityPurchaseFundingStorageFailed",
    ],
    severity: COMMUNITY_PURCHASE_FUNDING_SEVERITY,
    reads: COMMUNITY_PURCHASE_FUNDING_READS,
    writes: COMMUNITY_PURCHASE_FUNDING_WRITES,
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
