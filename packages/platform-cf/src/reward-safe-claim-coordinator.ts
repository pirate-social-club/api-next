import type { ControlPlaneDb, MegapotClaimCandidate } from "@pirate/application";
import { Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import {
  encodeMegapotClaimWinnings,
  type MegapotV2DeploymentAttestation,
  validateMegapotClaimReceipt,
} from "./megapot-v2.ts";
import { makeControlPlaneRewardSafeClaimStore } from "./reward-safe-claim-repository.ts";
import { rewardSafeCall, rewardSafeTransactionBuilderFile } from "./reward-safe-command.ts";
import {
  admitRewardSafeDeployment,
  assertRewardSafeRuntimeOptions,
  type RewardSafeRuntimeOptions,
  readRewardSafeExecution,
  rewardSafeFailed,
  sha256Hex,
} from "./reward-safe-settlement.ts";

/** A failed claim execution is retried this many times before the drawing is held. */
const MAXIMUM_CLAIM_ATTEMPTS = 3;

function safeClaimEffectId(poolLegId: string, drawingId: bigint, attempt: number): Hex {
  return keccak256(
    toBytes(
      `pirate.megapot.safe-winnings-claim.v1\u0000${poolLegId}\u0000${drawingId}\u0000${attempt}`,
    ),
  );
}

function deployment(candidate: MegapotClaimCandidate): MegapotV2DeploymentAttestation {
  return {
    environment: candidate.environment,
    chainId: candidate.chainId,
    jackpotAddress: candidate.jackpotAddress,
    ticketNftAddress: candidate.ticketNftAddress,
    usdcAddress: candidate.usdcAddress,
    custodyAddress: candidate.custodyAddress,
    referrerAddress: candidate.referrerAddress,
    jackpotCodeHash: candidate.jackpotCodeHash,
    ticketNftCodeHash: candidate.ticketNftCodeHash,
    usdcCodeHash: candidate.usdcCodeHash,
    attestationId: candidate.attestationId,
  };
}

/**
 * Owner-executed Safe claims of a ticket-first drawing's winnings. Pirate prepares
 * the claimWinnings call and hands the owner a Transaction Builder file; once
 * reconciliation binds the owner's execution, settlement checks the receipt and the
 * Safe's balance change across that execution before the drawing becomes claimed.
 */
export function makeRewardSafeClaimCoordinator(options: RewardSafeRuntimeOptions) {
  assertRewardSafeRuntimeOptions(options);
  const now = options.now ?? Date.now;
  const claims = makeControlPlaneRewardSafeClaimStore();
  const claimLedger = makeControlPlaneMegapotClaimStore(options.layer);
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(options.layer)(effect);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });

  const loadCandidate = (command: { readonly poolLegId: string; readonly drawingId: bigint }) =>
    provide(claims.loadCandidate(command)).pipe(
      Effect.catchTag("MegapotClaimRejected", () => Effect.succeed(null)),
    );

  /** The first attempt that has not been reverted, and where it stands. */
  const currentAttempt = Effect.fn("RewardSafeClaimCoordinator.currentAttempt")(
    function* (command: { readonly poolLegId: string; readonly drawingId: bigint }) {
      for (let attempt = 0; attempt < MAXIMUM_CLAIM_ATTEMPTS; attempt += 1) {
        const effectId = safeClaimEffectId(command.poolLegId, command.drawingId, attempt);
        const state = yield* provide(claims.loadAttempt(effectId));
        if (state?.state !== "reverted") return { effectId, state };
      }
      return null;
    },
  );

  const prepare = Effect.fn("RewardSafeClaimCoordinator.prepare")(function* (command: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) {
    const candidate = yield* loadCandidate(command);
    if (candidate === null) return { kind: "not_claimable" as const };
    yield* admitRewardSafeDeployment(options, candidate);
    const attempt = yield* currentAttempt(command);
    if (attempt === null) {
      yield* provide(claims.holdDrawing({ ...command, reason: "safe_claim_attempts_exhausted" }));
      return { kind: "attempts_exhausted" as const };
    }
    if (attempt.state !== null && attempt.state.state !== "prepared") {
      return { kind: "executing" as const, effectId: attempt.effectId };
    }
    const call = rewardSafeCall({
      effectId: attempt.effectId,
      to: candidate.jackpotAddress,
      data: encodeMegapotClaimWinnings([candidate.ticketId]),
    });
    const calldataHash = yield* rpc(() => sha256Hex(hexToBytes(call.data)));
    let preparedBlockNumber: bigint;
    if (attempt.state === null) {
      const head = yield* rpc(() => options.rpc.readHead());
      preparedBlockNumber = yield* provide(
        claims.prepare({
          effectId: attempt.effectId,
          candidate,
          calldata: call.data,
          calldataHash,
          headBlockNumber: head.blockNumber,
        }),
      );
    } else {
      // The same attempt is handed out again until the owner executes it.
      if (attempt.state.calldataHash !== calldataHash) {
        return yield* rewardSafeFailed("execution_unavailable");
      }
      preparedBlockNumber = attempt.state.preparedBlockNumber;
    }
    return {
      kind: "prepared" as const,
      effectId: attempt.effectId,
      preparedBlockNumber,
      transactionBuilderFile: rewardSafeTransactionBuilderFile({
        safeAddress: candidate.custodyAddress,
        call,
        name: `Pirate claim ${candidate.poolLegId} drawing ${candidate.drawingId}`,
        description: `Claim ticket ${candidate.ticketId} winnings of ${candidate.expectedNetWinningsAtomic} atomic USDC net`,
        createdAtMs: now(),
      }),
    };
  });

  const settle = Effect.fn("RewardSafeClaimCoordinator.settle")(function* (command: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) {
    const attempt = yield* currentAttempt(command);
    if (attempt === null || attempt.state === null) return { kind: "not_prepared" as const };
    if (attempt.state.state === "confirmed") {
      return { kind: "claimed" as const, effectId: attempt.effectId };
    }
    const { effectId } = attempt;
    const settlement = yield* provide(claims.loadSettlement(effectId));
    if (settlement === null) return { kind: "not_bound" as const };
    const candidate = yield* loadCandidate(command);
    if (candidate === null) return { kind: "not_claimable" as const };
    yield* admitRewardSafeDeployment(options, candidate);
    const hold = Effect.fn("RewardSafeClaimCoordinator.hold")(function* (reason: string) {
      yield* claimLedger.requireReconciliation({
        effectId,
        transactionHash: settlement.transactionHash,
        reason,
      });
      yield* provide(claims.holdDrawing({ ...command, reason }));
      return { kind: "reconciliation_required" as const, reason };
    });
    const execution = yield* readRewardSafeExecution(options, {
      effectId,
      safeAddress: candidate.custodyAddress,
      to: candidate.jackpotAddress,
      calldata: settlement.calldata,
      safeNonce: settlement.safeNonce,
      transactionHash: settlement.transactionHash,
      recordedOutcome: settlement.outcome,
      observedAt: settlement.observedAt,
    });
    if (execution.kind === "pending") return { kind: "pending" as const };
    if (execution.kind === "invalid") return yield* hold(execution.reason);
    if (execution.outcome === "failure") {
      yield* provide(
        claims.releaseFailedExecution({
          effectId,
          transactionHash: settlement.transactionHash,
          blockNumber: execution.receipt.blockNumber,
          blockHash: execution.receipt.blockHash,
          receiptHash: execution.receiptHash,
          confirmations: execution.confirmations,
          confirmedAt: execution.confirmedAt,
        }),
      );
      return { kind: "released" as const };
    }
    let evidence: ReturnType<typeof validateMegapotClaimReceipt>;
    try {
      evidence = validateMegapotClaimReceipt({
        deployment: deployment(candidate),
        receipt: execution.receipt,
        drawingId: candidate.drawingId,
        ticketIds: [candidate.ticketId],
        expectedGrossWinningsAtomic: candidate.expectedGrossWinningsAtomic,
        expectedNetWinningsAtomic: candidate.expectedNetWinningsAtomic,
        expectedReferralAccrualAtomic: candidate.expectedReferralAccrualAtomic,
        safeExecution: { command: execution.command, transaction: execution.transaction },
      });
    } catch {
      return yield* hold("safe_claim_receipt_invalid");
    }
    const claimLogIndex = evidence.claimLogIndices[0];
    const burnLogIndex = evidence.burnLogIndices[0];
    const referralLogIndex = evidence.referralLogIndices[0];
    if (
      claimLogIndex === undefined ||
      burnLogIndex === undefined ||
      referralLogIndex === undefined
    ) {
      return yield* hold("safe_claim_receipt_incomplete");
    }
    // The owner's Safe may execute anything between preparation and this claim, so
    // the balance change is read across the execution itself.
    const block = execution.receipt.blockNumber;
    const parent = block - 1n;
    const [parentBlock, custodyBefore, custodyAfter, referralBefore, referralAfter] = yield* rpc(
      () =>
        Promise.all([
          options.rpc.readBlock(parent),
          options.rpc.readUsdcBalance(candidate.custodyAddress, parent),
          options.rpc.readUsdcBalance(candidate.custodyAddress, block),
          options.rpc.readReferralFees(candidate.referrerAddress, parent),
          options.rpc.readReferralFees(candidate.referrerAddress, block),
        ]),
    );
    if (
      custodyAfter !== custodyBefore + evidence.netWinningsAtomic ||
      referralAfter !== referralBefore + evidence.referralAccrualAtomic
    ) {
      return yield* hold("claim_balance_delta_mismatch");
    }
    yield* provide(
      claims.settle({
        effectId,
        candidate,
        custodyBalanceBeforeAtomic: custodyBefore,
        referralBalanceBeforeAtomic: referralBefore,
        preflightBlockNumber: parent,
        preflightBlockHash: parentBlock.blockHash,
        confirmation: {
          effectId,
          transactionHash: settlement.transactionHash,
          claimLogIndex,
          burnLogIndex,
          referralLogIndex,
          transferLogIndex: evidence.transferLogIndex,
          grossWinningsAtomic: evidence.grossWinningsAtomic,
          referralAccrualAtomic: evidence.referralAccrualAtomic,
          netWinningsAtomic: evidence.netWinningsAtomic,
          custodyBalanceAfterAtomic: custodyAfter,
          referralBalanceAfterAtomic: referralAfter,
          blockNumber: evidence.blockNumber,
          blockHash: evidence.blockHash,
          receiptHash: execution.receiptHash,
          confirmations: execution.confirmations,
          confirmedAt: execution.confirmedAt,
        },
      }),
    );
    return {
      kind: "claimed" as const,
      effectId,
      netWinningsAtomic: evidence.netWinningsAtomic,
    };
  });

  return { prepare, settle };
}
