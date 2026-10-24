import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { hexToBytes } from "viem";
import { encodeMegapotUsdcTransfer, validateMegapotUsdcTransferReceipt } from "./megapot-v2.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import { rewardSafeCall, rewardSafeTransactionBuilderFile } from "./reward-safe-command.ts";
import { makeControlPlaneRewardSafePayoutStore } from "./reward-safe-payout-repository.ts";
import {
  admitRewardSafeDeployment,
  assertRewardSafeRuntimeOptions,
  makeRewardSafeExecutionScanner,
  type RewardSafeRuntimeOptions,
  readRewardSafeExecution,
  rewardSafeFailed,
  sha256Hex,
} from "./reward-safe-settlement.ts";

/**
 * Owner-executed Safe payouts for accepted participant credits. Pirate prepares one
 * USDC transfer per credit and hands the owner a Transaction Builder file; it never
 * signs or broadcasts. Scans bind the owner's executions to prepared calls, and
 * settlement validates the bound execution's receipt before marking the credit sent.
 */
export function makeRewardSafePayoutCoordinator(options: RewardSafeRuntimeOptions) {
  assertRewardSafeRuntimeOptions(options);
  const now = options.now ?? Date.now;
  const payouts = makeControlPlaneRewardPayoutStore(options.layer);
  const safePayouts = makeControlPlaneRewardSafePayoutStore();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(options.layer)(effect);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });

  const prepare = Effect.fn("RewardSafePayoutCoordinator.prepare")(function* (creditId: string) {
    const candidate = yield* payouts.loadCandidate(creditId);
    yield* admitRewardSafeDeployment(options, candidate);
    const call = rewardSafeCall({
      effectId: `safe-payout-${crypto.randomUUID()}`,
      to: candidate.tokenAddress,
      data: encodeMegapotUsdcTransfer(candidate.destinationAddress, candidate.amountAtomic),
    });
    const calldataHash = yield* rpc(() => sha256Hex(hexToBytes(call.data)));
    const head = yield* rpc(() => options.rpc.readHead());
    const preparedBlockNumber = yield* provide(
      safePayouts.prepare({
        effectId: call.effectId,
        candidate,
        calldata: call.data,
        calldataHash,
        headBlockNumber: head.blockNumber,
      }),
    );
    return {
      effectId: call.effectId,
      preparedBlockNumber,
      transactionBuilderFile: rewardSafeTransactionBuilderFile({
        chainId: candidate.chainId,
        safeAddress: candidate.custodyAddress,
        call,
        name: `Pirate payout ${call.effectId}`,
        description: `USDC payout of ${candidate.amountAtomic} atomic units for credit ${creditId}`,
        createdAtMs: now(),
      }),
    };
  });

  /** Validate a bound execution's receipt and settle the credit, or release it on failure. */
  const settle = Effect.fn("RewardSafePayoutCoordinator.settle")(function* (effectId: string) {
    const settlement = yield* provide(safePayouts.loadSettlement(effectId));
    if (settlement === null) return { kind: "not_bound" as const };
    yield* admitRewardSafeDeployment(options, settlement.deployment);
    const reconcile = (reason: string) =>
      payouts.requireReconciliation({
        effectId,
        transactionHash: settlement.transactionHash,
        reason,
      });
    const execution = yield* readRewardSafeExecution(options, {
      effectId,
      chainId: settlement.deployment.chainId,
      safeAddress: settlement.deployment.custodyAddress,
      to: settlement.tokenAddress,
      calldata: settlement.calldata,
      safeNonce: settlement.safeNonce,
      transactionHash: settlement.transactionHash,
      recordedOutcome: settlement.outcome,
      observedAt: settlement.observedAt,
    });
    if (execution.kind === "pending") return { kind: "pending" as const };
    if (execution.kind === "invalid") {
      yield* reconcile(execution.reason);
      return { kind: "reconciliation_required" as const };
    }
    if (execution.outcome === "failure") {
      yield* provide(
        safePayouts.releaseFailedExecution({
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
    let evidence: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      evidence = validateMegapotUsdcTransferReceipt({
        deployment: settlement.deployment,
        receipt: execution.receipt,
        recipient: settlement.destinationAddress,
        amountAtomic: settlement.amountAtomic,
        safeExecution: { command: execution.command, transaction: execution.transaction },
      });
    } catch {
      yield* reconcile("safe_payout_receipt_invalid");
      return { kind: "reconciliation_required" as const };
    }
    const custodyBalanceAfterAtomic = yield* rpc(() =>
      options.rpc.readUsdcBalance(
        settlement.deployment.custodyAddress,
        execution.receipt.blockNumber,
      ),
    );
    yield* payouts.confirm({
      effectId,
      transactionHash: settlement.transactionHash,
      transferLogIndex: evidence.transferLogIndex,
      amountAtomic: evidence.amountAtomic,
      custodyBalanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash: execution.receiptHash,
      confirmations: execution.confirmations,
      confirmedAt: execution.confirmedAt,
    });
    return { kind: "confirmed" as const, transactionHash: settlement.transactionHash };
  });

  return { prepare, scan: makeRewardSafeExecutionScanner(options), settle };
}
