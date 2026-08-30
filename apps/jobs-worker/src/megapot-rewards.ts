import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import {
  type AlertSink,
  type MegapotCommitmentBucket,
  makeBaseSepoliaMegapotCommitmentSigner,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
  makeControlPlaneCustodySolvencyStore,
  makeControlPlaneMegapotAllocationStore,
  makeControlPlaneMegapotApprovalStore,
  makeControlPlaneMegapotClaimStore,
  makeControlPlaneMegapotCommitmentStore,
  makeControlPlaneMegapotCutoffStore,
  makeControlPlaneMegapotDrawingObservationStore,
  makeControlPlaneMegapotPurchaseStore,
  makeControlPlaneMegapotSweepStore,
  makeControlPlaneMegapotWorkStore,
  makeControlPlaneRewardOfferTerminalStore,
  makeControlPlaneRewardPayoutStore,
  makeControlPlaneRewardRefundStore,
  makeCustodySolvencyCoordinator,
  makeMegapotAllocationCoordinator,
  makeMegapotApprovalCoordinator,
  makeMegapotClaimCoordinator,
  makeMegapotCommitmentCoordinator,
  makeMegapotCutoffCoordinator,
  makeMegapotDrawingObserver,
  makeMegapotPurchaseCoordinator,
  makeMegapotSweepCoordinator,
  makeMegapotV2RpcClient,
  makeR2MegapotCommitmentPublisher,
  makeRewardPayoutCoordinator,
  makeRewardRefundCoordinator,
} from "@pirate/platform-cf";
import { Effect, Layer } from "effect";
import {
  MEGAPOT_REWARDS_CYCLE_JOB,
  MEGAPOT_REWARDS_CYCLE_LANE,
  MEGAPOT_REWARDS_CYCLE_SCHEDULE,
  MEGAPOT_REWARDS_CYCLE_TIMEOUT,
  observeMegapotDrawingForCycle,
  runMegapotRewardsCycle,
  writeMegapotRewardsCycleSnapshot,
} from "./megapot-rewards-cycle.ts";
import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";

export {
  MEGAPOT_REWARDS_CYCLE_JOB,
  MEGAPOT_REWARDS_CYCLE_LANE,
  MEGAPOT_REWARDS_CYCLE_SCHEDULE,
  MEGAPOT_REWARDS_CYCLE_TIMEOUT,
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
] as const satisfies readonly TableKey[];

const MEGAPOT_REWARDS_WRITES = MEGAPOT_REWARDS_READS.filter(
  (table) =>
    table !== "postgres:megapot_deployment_attestations" &&
    table !== "postgres:reward_activity_availability_observations" &&
    table !== "postgres:megapot_pool_shares",
) satisfies readonly TableKey[];

const MEGAPOT_REWARDS_EXPECTED_FAILURES = [
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
  "RewardPayoutCoordinatorFailed",
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
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const controlPlane = Layer.succeed(ControlPlaneDb, db);
    const observationStore = makeControlPlaneMegapotDrawingObservationStore(controlPlane);
    const deployment = yield* observationStore.loadCandidate(options.attestationId);
    const rpc = makeMegapotV2RpcClient({
      rpcUrl: options.rpcUrl,
      reuseSuccessfulAttestation: true,
      minimumRequestIntervalMs: 250,
      attestation: {
        attestationId: deployment.attestationId,
        environment: deployment.environment,
        chainId: deployment.chainId,
        jackpotAddress: deployment.jackpotAddress,
        ticketNftAddress: deployment.ticketNftAddress,
        usdcAddress: deployment.usdcAddress,
        custodyAddress: deployment.custodyAddress,
        referrerAddress: deployment.referrerAddress,
        jackpotCodeHash: deployment.jackpotCodeHash,
        ticketNftCodeHash: deployment.ticketNftCodeHash,
        usdcCodeHash: deployment.usdcCodeHash,
      },
    });
    const transactionSigner = makeBaseSepoliaMegapotV2PrivateKeySigner({
      privateKey: options.custodyPrivateKey,
      expectedAddress: deployment.custodyAddress,
    });
    const commitmentSigner = makeBaseSepoliaMegapotCommitmentSigner({
      privateKey: options.custodyPrivateKey,
      expectedAddress: deployment.custodyAddress,
    });
    const commitmentPublisher = makeR2MegapotCommitmentPublisher({
      bucket: options.commitmentBucket,
      publicOrigin: options.commitmentPublicOrigin,
    });
    const approval = makeMegapotApprovalCoordinator({
      store: makeControlPlaneMegapotApprovalStore(controlPlane),
      rpc,
      signer: transactionSigner,
      requiredConfirmations: options.requiredConfirmations,
      gasLimitMultiplierBps: options.gasLimitMultiplierBps,
      nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
    });
    const purchase = makeMegapotPurchaseCoordinator({
      store: makeControlPlaneMegapotPurchaseStore(controlPlane),
      rpc,
      signer: transactionSigner,
      options: {
        requiredConfirmations: options.requiredConfirmations,
        purchaseSafetyMarginSeconds: options.purchaseSafetyMarginSeconds,
        gasLimitMultiplierBps: options.gasLimitMultiplierBps,
        nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
      },
    });
    const claim = makeMegapotClaimCoordinator({
      store: makeControlPlaneMegapotClaimStore(controlPlane),
      rpc,
      signer: transactionSigner,
      requiredConfirmations: options.requiredConfirmations,
      gasLimitMultiplierBps: options.gasLimitMultiplierBps,
      nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
    });
    const payout = makeRewardPayoutCoordinator({
      store: makeControlPlaneRewardPayoutStore(controlPlane),
      rpc,
      signer: transactionSigner,
      requiredConfirmations: options.requiredConfirmations,
      gasLimitMultiplierBps: options.gasLimitMultiplierBps,
      nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
    });
    const refund = makeRewardRefundCoordinator({
      store: makeControlPlaneRewardRefundStore(controlPlane),
      rpc,
      signer: transactionSigner,
      requiredConfirmations: options.requiredConfirmations,
      gasLimitMultiplierBps: options.gasLimitMultiplierBps,
      nativeGasReserveFloorWei: options.nativeGasReserveFloorWei,
    });
    const terminalOffers = makeControlPlaneRewardOfferTerminalStore(controlPlane);
    const observer = makeMegapotDrawingObserver({
      store: observationStore,
      rpc,
      observationTtlMs: options.observationTtlMs,
    });
    const solvency = makeCustodySolvencyCoordinator({
      store: makeControlPlaneCustodySolvencyStore(controlPlane),
      rpc,
      requiredConfirmations: options.requiredConfirmations,
    });
    const cutoff = makeMegapotCutoffCoordinator({
      store: makeControlPlaneMegapotCutoffStore(controlPlane),
      externalSponsorDailyTicketCeiling: options.externalSponsorDailyTicketCeiling,
      externalSponsorDailySpendCeilingAtomic: options.externalSponsorDailySpendCeilingAtomic,
      sharedSponsorDailyTicketCeiling: options.sharedSponsorDailyTicketCeiling,
      sharedSponsorDailySpendCeilingAtomic: options.sharedSponsorDailySpendCeilingAtomic,
    });
    const commitment = makeMegapotCommitmentCoordinator({
      store: makeControlPlaneMegapotCommitmentStore(controlPlane),
      signer: commitmentSigner,
      publisher: commitmentPublisher,
    });
    const sweep = makeMegapotSweepCoordinator({
      store: makeControlPlaneMegapotSweepStore(controlPlane),
      rpc,
      requiredConfirmations: options.requiredConfirmations,
    });
    const allocation = makeMegapotAllocationCoordinator({
      store: makeControlPlaneMegapotAllocationStore(controlPlane),
    });

    const summary = yield* runMegapotRewardsCycle({
      work: makeControlPlaneMegapotWorkStore(controlPlane),
      runtime: {
        reconcile: (work) => {
          switch (work.effectKind) {
            case "usdc_approval":
              return approval.reconcile(work.effectId);
            case "ticket_purchase":
              return purchase.reconcile(work.effectId);
            case "winnings_claim":
              return claim.reconcile(work.effectId);
            case "reward_payout":
              return payout.reconcile(work.effectId);
            case "reward_refund":
              return refund.reconcile(work.effectId);
          }
        },
        observeDrawing: () =>
          observeMegapotDrawingForCycle(observer.observe(options.attestationId)),
        observeSolvency: () => solvency.observe(options.attestationId),
        freezeDue: (limit) => cutoff.freezeDue({ limit }),
        publishCommitment: (work) =>
          commitment.commit({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        approve: (work) =>
          approval.approve({
            attestationId: work.attestationId,
            minimumAllowanceAtomic: work.ticketPriceAtomic,
            approvedAmountAtomic: options.approvedAllowanceAtomic,
          }),
        purchase: (work) =>
          purchase.purchase({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        sweep: (work) => sweep.sweep({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        claim: (work) => claim.claim({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        allocate: (work) =>
          allocation.allocate({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        closeExpiredOffers: (limit) => terminalOffers.closeExpired(limit),
        refund: (fundingEffectId) => refund.refund(fundingEffectId),
        payout: (creditId) => payout.payout(creditId),
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
