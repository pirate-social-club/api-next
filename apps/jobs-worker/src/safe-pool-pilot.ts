import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import {
  type AlertSink,
  type MegapotCommitmentBucket,
  makeControlPlaneRewardFundingStore,
  makeRewardFundingCoordinator,
} from "@pirate/platform-cf";
import { makeCustodySolvencyCoordinator } from "@pirate/platform-cf/custody-solvency-coordinator";
import { makeControlPlaneCustodySolvencyStore } from "@pirate/platform-cf/custody-solvency-repository";
import { makeMegapotAllocationCoordinator } from "@pirate/platform-cf/megapot-allocation-coordinator";
import { makeControlPlaneMegapotAllocationStore } from "@pirate/platform-cf/megapot-allocation-repository";
import {
  makeMegapotCommitmentCoordinator,
  megapotUnsignedOwnerSafeSigner,
} from "@pirate/platform-cf/megapot-commitment-coordinator";
import { makeR2MegapotCommitmentPublisher } from "@pirate/platform-cf/megapot-commitment-r2";
import { makeControlPlaneMegapotCommitmentStore } from "@pirate/platform-cf/megapot-commitment-repository";
import { makeControlPlaneMegapotDrawingObservationStore } from "@pirate/platform-cf/megapot-drawing-observation-repository";
import { makeMegapotDrawingObserver } from "@pirate/platform-cf/megapot-drawing-observer";
import { makeMegapotSweepCoordinator } from "@pirate/platform-cf/megapot-sweep-coordinator";
import { makeControlPlaneMegapotSweepStore } from "@pirate/platform-cf/megapot-sweep-repository";
import { makeMegapotTicketFirstCutoff } from "@pirate/platform-cf/megapot-ticket-first-cutoff";
import { makeControlPlaneMegapotWorkStore } from "@pirate/platform-cf/megapot-work-repository";
import { makeControlPlaneRewardRunAuthority } from "@pirate/platform-cf/reward-operations-control";
import { makeRewardSafeClaimCoordinator } from "@pirate/platform-cf/reward-safe-claim-coordinator";
import { makeRewardSafePayoutCoordinator } from "@pirate/platform-cf/reward-safe-payout-coordinator";
import { makeRewardSafePurchaseCoordinator } from "@pirate/platform-cf/reward-safe-purchase-coordinator";
import { makeRewardSafeExecutionScanner } from "@pirate/platform-cf/reward-safe-settlement";
import { makeControlPlaneRewardSafeWorkStore } from "@pirate/platform-cf/reward-safe-work-repository";
import { Effect, Layer } from "effect";
import { observeMegapotDrawingForCycle } from "./megapot-rewards-cycle.ts";
import { makeMegapotAttestedRpc } from "./megapot-rewards-runtime.ts";
import {
  defaultRetrySchedule,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";
import {
  runSafePoolPilotCycle,
  SAFE_POOL_PILOT_CYCLE_JOB,
  SAFE_POOL_PILOT_CYCLE_LANE,
  SAFE_POOL_PILOT_CYCLE_SCHEDULE,
  SAFE_POOL_PILOT_CYCLE_TIMEOUT,
  SAFE_POOL_PILOT_RPC_TIMEOUT_MS,
  SAFE_POOL_PILOT_SCAN_WINDOW_BLOCKS,
  scanSafeWindows,
} from "./safe-pool-pilot-cycle.ts";

export type SafePoolPilotJobOptions = Readonly<{
  environment: string;
  attestationId: string;
  rpcUrl: string;
  requiredConfirmations: number;
  /** The pilot's own production switch; staging runs without it. */
  productionEnabled: boolean;
  minimumEntrySeconds: number;
  observationTtlMs: number;
  commitmentBucket: MegapotCommitmentBucket;
  commitmentPublicOrigin: string;
}>;

const SAFE_POOL_PILOT_READS = [
  "postgres:megapot_deployment_attestations",
  "postgres:megapot_drawing_observations",
  "postgres:song_reward_offers",
  "postgres:song_reward_offer_legs",
  "postgres:song_reward_leg_funding_effects",
  "postgres:megapot_pool_drawings",
  "postgres:megapot_pool_drawing_transitions",
  "postgres:megapot_pool_shares",
  "postgres:megapot_pool_beneficiary_snapshots",
  "postgres:megapot_pool_snapshot_private_leaves",
  "postgres:megapot_pool_commitment_effects",
  "postgres:reward_signer_nonces",
  "postgres:reward_chain_effects",
  "postgres:reward_chain_effect_transitions",
  "postgres:reward_safe_execution_cursors",
  "postgres:reward_safe_unbound_executions",
  "postgres:megapot_ticket_purchase_effects",
  "postgres:megapot_ticket_inventory",
  "postgres:megapot_purchase_receipt_evidence",
  "postgres:megapot_drawing_sweeps",
  "postgres:megapot_sweep_ticket_evidence",
  "postgres:megapot_claim_effects",
  "postgres:megapot_claim_receipt_evidence",
  "postgres:platform_referral_revenue_ledger",
  "postgres:megapot_allocation_batches",
  "postgres:megapot_allocations",
  "postgres:reward_ledger_credits",
  "postgres:reward_payout_effects",
  "postgres:reward_erc20_transfer_receipt_evidence",
  "postgres:custody_solvency_observations",
] as const satisfies readonly TableKey[];

const SAFE_POOL_PILOT_WRITES = SAFE_POOL_PILOT_READS.filter(
  (table) =>
    table !== "postgres:megapot_deployment_attestations" &&
    table !== "postgres:megapot_pool_shares" &&
    table !== "postgres:reward_signer_nonces",
) satisfies readonly TableKey[];

const SAFE_POOL_PILOT_EXPECTED_FAILURES = [
  "MegapotDrawingObservationRejected",
  "MegapotDrawingObservationStorageFailed",
] as const;

const SAFE_POOL_PILOT_SEVERITY: SeverityMapping = {
  expectedFailure: Object.fromEntries(
    SAFE_POOL_PILOT_EXPECTED_FAILURES.map((failure) => [failure, "high" as const]),
  ),
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

/**
 * The owner-executed Safe pool pilot. It shares tables with the EOA rewards job, so
 * configuration never enables both, and with Study and funding recovery, so it runs
 * as the financial step of their serial job; see makeJobsWorkerDeclarations.
 */
export function makeSafePoolPilotJob(
  sink: AlertSink,
  options: SafePoolPilotJobOptions,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const layer = Layer.succeed(ControlPlaneDb, db);
    const observations = makeControlPlaneMegapotDrawingObservationStore(layer);
    const deployment = yield* observations.loadCandidate(options.attestationId);
    const rpc = makeMegapotAttestedRpc(
      deployment,
      options.rpcUrl,
      undefined,
      SAFE_POOL_PILOT_RPC_TIMEOUT_MS,
    );
    const safe = { chainId: deployment.chainId, safeAddress: deployment.custodyAddress };
    const custody = { ...safe, attestationId: deployment.attestationId };
    const safePilot = { productionEnabled: options.productionEnabled };
    const safeOptions = {
      layer,
      rpc,
      requiredConfirmations: options.requiredConfirmations,
      productionEnabled: options.productionEnabled,
      maximumScanBlocks: SAFE_POOL_PILOT_SCAN_WINDOW_BLOCKS,
      maximumScanLogs: 200,
    };
    const purchases = makeRewardSafePurchaseCoordinator({
      ...safeOptions,
      minimumEntrySeconds: options.minimumEntrySeconds,
    });
    const claims = makeRewardSafeClaimCoordinator(safeOptions);
    const payouts = makeRewardSafePayoutCoordinator(safeOptions);
    const scan = makeRewardSafeExecutionScanner(safeOptions);
    const work = makeControlPlaneMegapotWorkStore(layer);
    const safeWork = makeControlPlaneRewardSafeWorkStore(layer);
    const observer = makeMegapotDrawingObserver({
      store: observations,
      rpc,
      observationTtlMs: options.observationTtlMs,
      safePilot,
    });
    const solvency = makeCustodySolvencyCoordinator({
      store: makeControlPlaneCustodySolvencyStore(layer),
      rpc,
      requiredConfirmations: options.requiredConfirmations,
      safePilot,
    });
    const sweep = makeMegapotSweepCoordinator({
      store: makeControlPlaneMegapotSweepStore(layer),
      rpc,
      requiredConfirmations: options.requiredConfirmations,
      safeProductionEnabled: options.productionEnabled,
    });
    const commitment = makeMegapotCommitmentCoordinator({
      store: makeControlPlaneMegapotCommitmentStore(layer),
      signer: megapotUnsignedOwnerSafeSigner,
      publisher: makeR2MegapotCommitmentPublisher({
        bucket: options.commitmentBucket,
        publicOrigin: options.commitmentPublicOrigin,
      }),
      authority: makeControlPlaneRewardRunAuthority(layer),
    });
    const cutoff = makeMegapotTicketFirstCutoff({ layer });
    const fundingStore = makeControlPlaneRewardFundingStore(layer);
    const funding = makeRewardFundingCoordinator({ store: fundingStore, rpc, safePilot });
    const allocation = makeMegapotAllocationCoordinator({
      store: makeControlPlaneMegapotAllocationStore(layer),
    });
    const drawing = (value: { readonly poolLegId: string; readonly drawingId: bigint }) => ({
      poolLegId: value.poolLegId,
      drawingId: value.drawingId,
    });
    const summary = yield* runSafePoolPilotCycle({
      observeDrawing: () =>
        observeMegapotDrawingForCycle(observer.observe(deployment.attestationId)),
      scan: () => scanSafeWindows(() => scan(safe)),
      loadBoundEffects: (limit) => safeWork.loadBoundEffects(custody, limit),
      settlePurchase: purchases.settle,
      settlePayout: payouts.settle,
      loadPendingFunding: (limit) =>
        work.loadPendingFunding({ limit, cursor: Math.floor(Date.now() / 60_000) }),
      // The listing covers every deployment; only the pilot's own funding is confirmed here.
      reconcileFunding: (fundingEffectId) =>
        Effect.gen(function* () {
          const intent = yield* fundingStore.find(fundingEffectId);
          if (intent?.attestationId !== deployment.attestationId) return null;
          return yield* funding.reconcile(fundingEffectId);
        }),
      closeUnexecutedPurchases: purchases.closeUnexecuted,
      loadLegs: (limit) => safeWork.loadLegs(custody, limit),
      preparePurchase: purchases.prepare,
      freezeDue: cutoff.freezeDue,
      loadDrawings: (statuses, limit) =>
        work.loadDrawings({ statuses, purchaseOrder: "ticket_first_v1", limit }),
      publishCommitment: (value) => commitment.commit(drawing(value)),
      sweep: (value) => sweep.sweep(drawing(value)),
      settleClaim: (value) => claims.settle(drawing(value)),
      prepareClaim: (value) => claims.prepare(drawing(value)),
      allocate: (value) => allocation.allocate(drawing(value)),
      observeSolvency: () => solvency.observe(deployment.attestationId),
      loadCredits: (limit) => work.loadCredits(limit, "ticket_first_v1"),
      preparePayout: payouts.prepare,
    });
    console.info(
      JSON.stringify({
        event: "safe_pool_pilot.cycle",
        environment: options.environment,
        completed: summary.completed,
        failed: summary.failed,
      }),
    );
    const failedSteps = Object.keys(summary.failed).sort();
    if (failedSteps.length > 0) {
      yield* collector.emit({
        key: "safe-pool-pilot:step-failures",
        severity: "high",
        body: "Safe pool pilot steps failed; they are retried on the next cycle.",
        entity: `steps:${failedSteps.join(",")}`,
      });
    }
  });

  return {
    name: SAFE_POOL_PILOT_CYCLE_JOB,
    lane: SAFE_POOL_PILOT_CYCLE_LANE,
    schedule: SAFE_POOL_PILOT_CYCLE_SCHEDULE,
    timeout: SAFE_POOL_PILOT_CYCLE_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: SAFE_POOL_PILOT_EXPECTED_FAILURES,
    severity: SAFE_POOL_PILOT_SEVERITY,
    reads: SAFE_POOL_PILOT_READS,
    writes: SAFE_POOL_PILOT_WRITES,
    alertSink: sink,
    run,
  };
}
