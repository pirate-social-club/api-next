import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import {
  type AlertSink,
  deriveBaseSepoliaMegapotAddress,
  type MegapotCommitmentBucket,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
  makeControlPlaneMegapotAllocationStore,
  makeControlPlaneMegapotCutoffStore,
  makeControlPlaneMegapotDrawingObservationStore,
  makeControlPlaneMegapotWorkStore,
  makeControlPlaneRewardEffectAttestationStore,
  makeControlPlaneRewardGasTopupSendStore,
  makeControlPlaneRewardOfferTerminalStore,
  makeControlPlaneRewardPayoutStore,
  makeControlPlaneRewardRefundStore,
  makeMegapotAllocationCoordinator,
  makeMegapotCutoffCoordinator,
  makeRewardGasTopupCoordinator,
} from "@pirate/platform-cf";
import {
  makeControlPlaneRewardLeaseExpiryPause,
  makeControlPlaneRewardRunAuthority,
} from "@pirate/platform-cf/reward-operations-control";
import { Effect, Layer } from "effect";
import {
  MEGAPOT_REWARDS_CYCLE_JOB,
  MEGAPOT_REWARDS_CYCLE_LANE,
  MEGAPOT_REWARDS_CYCLE_SCHEDULE,
  MEGAPOT_REWARDS_CYCLE_TIMEOUT,
  type MegapotRewardsRuntime,
  megapotRewardsDrawingObservationAlert,
  megapotRewardsLivenessAlerts,
  pauseOnRunLeaseExpiry,
  resolveGasTopupRuntime,
  runMegapotRewardsCycle,
  writeMegapotRewardsCycleSnapshot,
} from "./megapot-rewards-cycle.ts";
import {
  MegapotRewardRoutingRejected,
  makeMegapotCustodyKeyResolver,
  makeMegapotRewardsRouting,
} from "./megapot-rewards-routing.ts";
import {
  makeMegapotAttestationRuntime,
  makeMegapotAttestedRpc,
  makeMegapotReceiptReadLogger,
} from "./megapot-rewards-runtime.ts";
import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";

export {
  MEGAPOT_REWARDS_CYCLE_JOB,
  type MegapotRewardsCycleSummary,
  type MegapotRewardsRuntime,
  runMegapotRewardsCycle,
} from "./megapot-rewards-cycle.ts";

const MEGAPOT_REWARDS_READS = [
  "postgres:megapot_deployment_attestations",
  "postgres:megapot_drawing_observations",
  "postgres:song_reward_offers",
  "postgres:song_reward_offer_legs",
  "postgres:song_reward_leg_funding_effects",
  "postgres:reward_activity_availability_observations",
  "postgres:sponsor_daily_ticket_totals",
  "postgres:megapot_pool_drawings",
  "postgres:megapot_fallback_cutoff_evidence",
  "postgres:megapot_fallback_cutoff_activity_evidence",
  "postgres:megapot_pool_shares",
  "postgres:megapot_pool_beneficiary_snapshots",
  "postgres:megapot_pool_snapshot_private_leaves",
  "postgres:megapot_pool_commitment_effects",
  "postgres:reward_signer_nonces",
  "postgres:reward_chain_effects",
  "postgres:reward_chain_effect_transitions",
  "postgres:megapot_usdc_approval_effects",
  "postgres:megapot_usdc_approval_receipt_evidence",
  "postgres:megapot_ticket_purchase_effects",
  "postgres:megapot_ticket_inventory",
  "postgres:megapot_purchase_receipt_evidence",
  "postgres:megapot_drawing_sweeps",
  "postgres:megapot_sweep_ticket_evidence",
  "postgres:megapot_claim_effects",
  "postgres:megapot_claim_receipt_evidence",
  "postgres:megapot_allocation_batches",
  "postgres:reward_ledger_credits",
  "postgres:megapot_allocations",
  "postgres:reward_payout_effects",
  "postgres:reward_refund_effects",
  "postgres:reward_erc20_transfer_receipt_evidence",
  "postgres:custody_solvency_observations",
  "postgres:platform_referral_revenue_ledger",
  "postgres:platform_sponsorship_budgets",
  "postgres:platform_sponsorship_budget_entries",
  "postgres:megapot_pool_drawing_transitions",
  "postgres:reward_gas_topup_wallets",
  "postgres:reward_gas_topup_daily_budgets",
  "postgres:reward_gas_topups",
  "postgres:reward_native_transfer_receipt_evidence",
] as const satisfies readonly TableKey[];

const MEGAPOT_REWARDS_WRITES = MEGAPOT_REWARDS_READS.filter(
  (table) =>
    table !== "postgres:megapot_deployment_attestations" &&
    table !== "postgres:reward_activity_availability_observations" &&
    table !== "postgres:megapot_pool_shares" &&
    table !== "postgres:reward_gas_topup_wallets",
) satisfies readonly TableKey[];

const MEGAPOT_REWARDS_EXPECTED_FAILURES = [
  "MegapotRewardRoutingRejected",
  "CustodySolvencyCoordinatorFailed",
  "CustodySolvencyRejected",
  "CustodySolvencyStorageFailed",
  "MegapotAllocationCoordinatorFailed",
  "MegapotAllocationRejected",
  "MegapotAllocationStorageFailed",
  "MegapotApprovalCoordinatorFailed",
  "MegapotApprovalRejected",
  "MegapotApprovalStorageFailed",
  "MegapotClaimCoordinatorFailed",
  "MegapotClaimRejected",
  "MegapotClaimStorageFailed",
  "MegapotCommitmentRejected",
  "MegapotCommitmentStorageFailed",
  "MegapotCutoffRejected",
  "MegapotCutoffStorageFailed",
  "MegapotDrawingObservationRejected",
  "MegapotDrawingObservationStorageFailed",
  "MegapotPurchaseCoordinatorFailed",
  "MegapotPurchaseRejected",
  "MegapotPurchaseStorageFailed",
  "MegapotSweepCoordinatorFailed",
  "MegapotSweepRejected",
  "MegapotSweepStorageFailed",
  "MegapotWorkStorageFailed",
  "RewardGasTopupCoordinatorFailed",
  "RewardGasTopupRejected",
  "RewardGasTopupStorageFailed",
  "RewardPayoutCoordinatorFailed",
  "RewardOperationsPaused",
  "RewardRunAuthorityUnavailable",
  "RewardPayoutRejected",
  "RewardPayoutStorageFailed",
  "RewardOfferTerminalStorageFailed",
  "RewardRefundCoordinatorFailed",
  "RewardRefundRejected",
  "RewardRefundStorageFailed",
] as const;

const MEGAPOT_REWARDS_SEVERITY: SeverityMapping = {
  expectedFailure: Object.fromEntries(
    MEGAPOT_REWARDS_EXPECTED_FAILURES.map((failure) => [failure, "high" as const]),
  ),
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export type MegapotRewardsJobOptions = Readonly<{
  environment: string;
  workerVersion: Readonly<{ id: string; tag: string; timestamp: string }>;
  attestationId: string;
  rpcUrl: string;
  custodyPrivateKey: string;
  retainedCustodyPrivateKeys?: string;
  /** Null when MEGAPOT_GAS_TOPUP_PRIVATE_KEY is unset; the top-up step is then skipped. */
  gasTopupPrivateKey: string | null;
  commitmentBucket: MegapotCommitmentBucket;
  commitmentPublicOrigin: string;
  requiredConfirmations: number;
  observationTtlMs: number;
  approvedAllowanceAtomic: bigint;
  purchaseSafetyMarginSeconds: number;
  gasLimitMultiplierBps: number;
  nativeGasReserveFloorWei: bigint;
  externalSponsorDailyTicketCeiling: number;
  externalSponsorDailySpendCeilingAtomic: bigint;
  sharedSponsorDailyTicketCeiling: number;
  sharedSponsorDailySpendCeilingAtomic: bigint;
}>;

export function makeMegapotRewardsJob(
  sink: AlertSink,
  options: MegapotRewardsJobOptions,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const startedAt = Date.now();
    const job = yield* JobContext;
    const onReceiptRead = makeMegapotReceiptReadLogger({
      log: sink.log ?? console.info,
      attemptId: job.attemptId,
      cycleStartedAt: new Date(startedAt).toISOString(),
      environment: options.environment,
      workerVersion: options.workerVersion,
    });
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const controlPlane = Layer.succeed(ControlPlaneDb, db);
    const observationStore = makeControlPlaneMegapotDrawingObservationStore(controlPlane);
    const resolveCustodyKey = yield* Effect.try({
      try: () =>
        makeMegapotCustodyKeyResolver(
          options.custodyPrivateKey,
          options.retainedCustodyPrivateKeys,
        ),
      catch: () => new MegapotRewardRoutingRejected({ reason: "invalid-config" }),
    });
    const payoutStore = makeControlPlaneRewardPayoutStore(controlPlane);
    const refundStore = makeControlPlaneRewardRefundStore(controlPlane);
    const effectAttestations = makeControlPlaneRewardEffectAttestationStore(controlPlane);
    const routing = makeMegapotRewardsRouting({
      activeAttestationId: options.attestationId,
      environment: options.environment,
      loadDeployment: observationStore.loadCandidate,
      loadEffectAttestation: effectAttestations.load,
      loadPayoutAuthority: payoutStore.loadAuthority,
      loadRefundAuthority: refundStore.loadAuthority,
      makeRuntime: (deployment) =>
        makeMegapotAttestationRuntime({
          deployment,
          controlPlane,
          options,
          resolveCustodyKey,
          onReceiptRead,
        }),
    });
    const gasTopupStore = makeControlPlaneRewardGasTopupSendStore(controlPlane);
    let gasTopups: MegapotRewardsRuntime["gasTopups"] = null;
    const gasTopupPrivateKey = options.gasTopupPrivateKey;
    if (gasTopupPrivateKey !== null) {
      const deployment = yield* observationStore.loadCandidate(options.attestationId);
      const rpc = makeMegapotAttestedRpc(deployment, options.rpcUrl, onReceiptRead);
      // The gas signer must be the registered active gas wallet, never custody.
      const resolved = yield* resolveGasTopupRuntime({
        loadActiveSigner: () => gasTopupStore.loadActiveSigner(deployment.chainId),
        configuredSigner: deriveBaseSepoliaMegapotAddress(gasTopupPrivateKey),
        makeRuntime: (activeSigner) => {
          const gasTopup = makeRewardGasTopupCoordinator({
            store: gasTopupStore,
            authority: makeControlPlaneRewardRunAuthority(controlPlane),
            rpc,
            signer: makeBaseSepoliaMegapotV2PrivateKeySigner({
              privateKey: gasTopupPrivateKey,
              expectedAddress: activeSigner,
            }),
            requiredConfirmations: options.requiredConfirmations,
            gasLimitMultiplierBps: options.gasLimitMultiplierBps,
            nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
          });
          return {
            listOpen: (limit) => gasTopupStore.listOpen(limit),
            send: (topupId) => gasTopup.send(topupId),
          };
        },
      });
      gasTopups = resolved.runtime;
      if (resolved.signerMismatch) {
        yield* collector.emit({
          key: "megapot-rewards:gas-topup-signer-mismatch",
          severity: "high",
          body: "The configured gas top-up signer is not the active gas wallet; top-ups are skipped.",
        });
      }
    }
    const terminalOffers = makeControlPlaneRewardOfferTerminalStore(controlPlane);
    const cutoff = makeMegapotCutoffCoordinator({
      store: makeControlPlaneMegapotCutoffStore(controlPlane),
      externalSponsorDailyTicketCeiling: options.externalSponsorDailyTicketCeiling,
      externalSponsorDailySpendCeilingAtomic: options.externalSponsorDailySpendCeilingAtomic,
      sharedSponsorDailyTicketCeiling: options.sharedSponsorDailyTicketCeiling,
      sharedSponsorDailySpendCeilingAtomic: options.sharedSponsorDailySpendCeilingAtomic,
    });
    const allocation = makeMegapotAllocationCoordinator({
      store: makeControlPlaneMegapotAllocationStore(controlPlane),
    });

    const leaseAlert = yield* pauseOnRunLeaseExpiry(
      makeControlPlaneRewardLeaseExpiryPause(controlPlane),
    );
    if (leaseAlert !== null) yield* collector.emit(leaseAlert);
    const summary = yield* runMegapotRewardsCycle({
      work: makeControlPlaneMegapotWorkStore(controlPlane),
      runtime: {
        reconcile: routing.reconcile,
        observeDrawing: () =>
          routing.active().pipe(Effect.flatMap((runtime) => runtime.observeDrawing())),
        observeSolvency: () =>
          routing.active().pipe(Effect.flatMap((runtime) => runtime.observeSolvency())),
        freezeDue: (limit) => cutoff.freezeDue({ limit }),
        publishCommitment: routing.publishCommitment,
        approve: routing.approve,
        purchase: routing.purchase,
        closeUnavailablePurchase: routing.closeUnavailablePurchase,
        sweep: routing.sweep,
        claim: routing.claim,
        allocate: (work) =>
          allocation.allocate({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        closeExpiredOffers: (limit) => terminalOffers.closeExpired(limit),
        refund: routing.refund,
        payout: routing.payout,
        gasTopups,
      },
    });
    writeMegapotRewardsCycleSnapshot(
      summary,
      {
        environment: options.environment,
        emittedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        workerVersion: options.workerVersion,
      },
      sink.log ?? ((event, fields) => console.info(event, fields)),
    );
    for (const alert of megapotRewardsLivenessAlerts(summary.agedPending)) {
      yield* collector.emit(alert);
    }
    const drawingObservationAlert = megapotRewardsDrawingObservationAlert(summary);
    if (drawingObservationAlert !== null) {
      yield* collector.emit(drawingObservationAlert);
    }
    if (summary.failures.length > 0) {
      yield* collector.emit({
        key: "megapot-rewards:candidate-failures",
        severity: "high",
        body: "Megapot reward candidates require a later reconciliation pass.",
        entity: `cycle-failures:${summary.failures.length}`,
      });
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: MEGAPOT_REWARDS_CYCLE_JOB,
    lane: MEGAPOT_REWARDS_CYCLE_LANE,
    schedule: MEGAPOT_REWARDS_CYCLE_SCHEDULE,
    timeout: MEGAPOT_REWARDS_CYCLE_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: MEGAPOT_REWARDS_EXPECTED_FAILURES,
    severity: MEGAPOT_REWARDS_SEVERITY,
    reads: MEGAPOT_REWARDS_READS,
    writes: MEGAPOT_REWARDS_WRITES,
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
