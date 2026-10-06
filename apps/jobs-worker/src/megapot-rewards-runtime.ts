import type {
  ControlPlaneDb,
  ControlPlaneError,
  MegapotDrawingObserverCandidate,
} from "@pirate/application";
import { makeCustodySolvencyCoordinator } from "@pirate/platform-cf/custody-solvency-coordinator";
import { makeControlPlaneCustodySolvencyStore } from "@pirate/platform-cf/custody-solvency-repository";
import { makeMegapotApprovalCoordinator } from "@pirate/platform-cf/megapot-approval-coordinator";
import { makeControlPlaneMegapotApprovalStore } from "@pirate/platform-cf/megapot-approval-repository";
import { makeMegapotClaimCoordinator } from "@pirate/platform-cf/megapot-claim-coordinator";
import { makeControlPlaneMegapotClaimStore } from "@pirate/platform-cf/megapot-claim-repository";
import { makeMegapotCommitmentCoordinator } from "@pirate/platform-cf/megapot-commitment-coordinator";
import { makeR2MegapotCommitmentPublisher } from "@pirate/platform-cf/megapot-commitment-r2";
import { makeControlPlaneMegapotCommitmentStore } from "@pirate/platform-cf/megapot-commitment-repository";
import { makeControlPlaneMegapotDrawingObservationStore } from "@pirate/platform-cf/megapot-drawing-observation-repository";
import { makeMegapotDrawingObserver } from "@pirate/platform-cf/megapot-drawing-observer";
import { makeMegapotPurchaseCoordinator } from "@pirate/platform-cf/megapot-purchase-coordinator";
import { makeControlPlaneMegapotPurchaseStore } from "@pirate/platform-cf/megapot-purchase-repository";
import { makeMegapotSweepCoordinator } from "@pirate/platform-cf/megapot-sweep-coordinator";
import { makeControlPlaneMegapotSweepStore } from "@pirate/platform-cf/megapot-sweep-repository";
import {
  type MegapotReceiptReadObservation,
  makeMegapotV2RpcClient,
} from "@pirate/platform-cf/megapot-v2-rpc";
import {
  makeBaseSepoliaMegapotCommitmentSigner,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
} from "@pirate/platform-cf/megapot-v2-signer";
import { makeRewardPayoutCoordinator } from "@pirate/platform-cf/reward-payout-coordinator";
import { makeControlPlaneRewardPayoutStore } from "@pirate/platform-cf/reward-payout-repository";
import { makeRewardRefundCoordinator } from "@pirate/platform-cf/reward-refund-coordinator";
import { makeControlPlaneRewardRefundStore } from "@pirate/platform-cf/reward-refund-repository";
import { Effect, type Layer } from "effect";
import type { MegapotRewardsJobOptions } from "./megapot-rewards.ts";
import { observeMegapotDrawingForCycle } from "./megapot-rewards-cycle.ts";
import {
  type MegapotAttestationRuntime,
  MegapotRewardRoutingRejected,
} from "./megapot-rewards-routing.ts";

/** Public receipt identifiers only. RPC adapters isolate any sink failure. */
export function makeMegapotReceiptReadLogger(input: {
  readonly log: (message: string) => void;
  readonly attemptId: string;
  readonly cycleStartedAt: string;
  readonly environment: MegapotRewardsJobOptions["environment"];
  readonly workerVersion: MegapotRewardsJobOptions["workerVersion"];
}) {
  return (receipt: MegapotReceiptReadObservation) =>
    input.log(
      JSON.stringify({
        event: "megapot_receipt_read",
        job: "megapot-rewards.cycle",
        attemptId: input.attemptId,
        cycleStartedAt: input.cycleStartedAt,
        environment: input.environment,
        workerVersion: input.workerVersion,
        ...receipt,
      }),
    );
}

export function makeMegapotAttestedRpc(
  deployment: MegapotDrawingObserverCandidate,
  rpcUrl: string,
  onReceiptRead?: (observation: MegapotReceiptReadObservation) => void,
  timeoutMs?: number,
) {
  return makeMegapotV2RpcClient({
    rpcUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onReceiptRead === undefined ? {} : { onReceiptRead }),
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
}

/** Read-only work survives missing retired keys; signing is resolved before a coordinator can reserve a nonce. */
export function makeMegapotAttestationRuntime(input: {
  readonly deployment: MegapotDrawingObserverCandidate;
  readonly controlPlane: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  readonly options: MegapotRewardsJobOptions;
  readonly onReceiptRead?: (observation: MegapotReceiptReadObservation) => void;
  readonly resolveCustodyKey: (address: string) => string;
}): MegapotAttestationRuntime {
  const { deployment, controlPlane, options } = input;
  const rpc = makeMegapotAttestedRpc(deployment, options.rpcUrl, input.onReceiptRead);
  const observationStore = makeControlPlaneMegapotDrawingObservationStore(controlPlane);
  const observer = makeMegapotDrawingObserver({
    store: observationStore,
    rpc,
    observationTtlMs: options.observationTtlMs,
  });
  const solvencyStore = makeControlPlaneCustodySolvencyStore(controlPlane);
  const solvency = makeCustodySolvencyCoordinator({
    store: solvencyStore,
    rpc,
    requiredConfirmations: options.requiredConfirmations,
  });
  const sweep = makeMegapotSweepCoordinator({
    store: makeControlPlaneMegapotSweepStore(controlPlane),
    rpc,
    requiredConfirmations: options.requiredConfirmations,
  });
  const makeSigned = () => {
    const privateKey = input.resolveCustodyKey(deployment.custodyAddress);
    const transactionSigner = makeBaseSepoliaMegapotV2PrivateKeySigner({
      privateKey,
      expectedAddress: deployment.custodyAddress,
    });
    const commitmentSigner = makeBaseSepoliaMegapotCommitmentSigner({
      privateKey,
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
    const commitment = makeMegapotCommitmentCoordinator({
      store: makeControlPlaneMegapotCommitmentStore(controlPlane),
      signer: commitmentSigner,
      publisher: commitmentPublisher,
    });
    return { approval, purchase, claim, payout, refund, commitment };
  };
  let signed: ReturnType<typeof makeSigned> | undefined;
  const signing = () =>
    Effect.try({
      try: () => (signed ??= makeSigned()),
      catch: (error) =>
        error instanceof MegapotRewardRoutingRejected
          ? error
          : new MegapotRewardRoutingRejected({ reason: "invalid-config" }),
    });
  return {
    observeDrawing: () => observeMegapotDrawingForCycle(observer.observe(deployment.attestationId)),
    observeSolvency: (tokenAddress) =>
      tokenAddress === undefined
        ? solvencyStore
            .listTokenAddresses(deployment.attestationId)
            .pipe(
              Effect.flatMap((tokenAddresses) =>
                Effect.forEach(
                  tokenAddresses,
                  (token) => solvency.observe(deployment.attestationId, token),
                  { concurrency: 1 },
                ),
              ),
            )
        : solvency.observe(deployment.attestationId, tokenAddress),
    reconcile: (kind, id) =>
      signing().pipe(
        Effect.flatMap((coordinators): Effect.Effect<unknown, unknown> => {
          const settlements = {
            usdc_approval: coordinators.approval,
            ticket_purchase: coordinators.purchase,
            winnings_claim: coordinators.claim,
            reward_payout: coordinators.payout,
            reward_refund: coordinators.refund,
          };
          return settlements[kind].reconcile(id);
        }),
      ),
    publishCommitment: (work) =>
      signing().pipe(
        Effect.flatMap(({ commitment }) =>
          commitment.commit({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        ),
      ),
    approve: (work) =>
      signing().pipe(
        Effect.flatMap(({ approval }) =>
          approval.approve({
            attestationId: work.attestationId,
            minimumAllowanceAtomic: work.ticketPriceAtomic,
            approvedAmountAtomic: options.approvedAllowanceAtomic,
          }),
        ),
      ),
    closeUnavailablePurchase: (work) =>
      signing().pipe(
        Effect.flatMap(({ purchase }) =>
          purchase.closeUnavailable({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        ),
      ),
    purchase: (work) =>
      signing().pipe(
        Effect.flatMap(({ purchase }) =>
          purchase.purchase({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        ),
      ),
    sweep: (work) => sweep.sweep({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
    claim: (work) =>
      signing().pipe(
        Effect.flatMap(({ claim }) =>
          claim.claim({ poolLegId: work.poolLegId, drawingId: work.drawingId }),
        ),
      ),
    refund: (id) => signing().pipe(Effect.flatMap(({ refund }) => refund.refund(id))),
    payout: (id) => signing().pipe(Effect.flatMap(({ payout }) => payout.payout(id))),
  };
}
