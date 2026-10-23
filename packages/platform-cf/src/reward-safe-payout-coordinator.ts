import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import { hexToBytes, toBytes } from "viem";
import { encodeMegapotUsdcTransfer, validateMegapotUsdcTransferReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import {
  decodeRewardSafeExecutedCall,
  rewardSafeCall,
  rewardSafeCommandFromExecution,
  rewardSafeTransactionBuilderFile,
} from "./reward-safe-command.ts";
import { classifyRewardSafeExecution } from "./reward-safe-execution.ts";
import { makeControlPlaneRewardSafeExecutionStore } from "./reward-safe-execution-repository.ts";
import { makeControlPlaneRewardSafePayoutStore } from "./reward-safe-payout-repository.ts";
import { findRewardSafeExecutions } from "./reward-safe-reconciliation.ts";
import { canonicalReceipt } from "./reward-token-send-coordinator.ts";

export class RewardSafePayoutFailed extends Data.TaggedError("RewardSafePayoutFailed")<{
  readonly reason:
    | "invalid_config"
    | "not_safe_chain"
    | "production_disabled"
    | "rpc_unavailable"
    | "execution_unavailable";
}> {}

const failed = (reason: RewardSafePayoutFailed["reason"]) => new RewardSafePayoutFailed({ reason });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Owner-executed Safe payouts for accepted participant credits. Pirate prepares one
 * USDC transfer per credit and hands the owner a Transaction Builder file; it never
 * signs or broadcasts. Scans bind the owner's executions to prepared calls, and
 * settlement validates the bound execution's receipt before marking the credit sent.
 */
export function makeRewardSafePayoutCoordinator(input: {
  readonly layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  readonly rpc: MegapotV2RpcClient;
  readonly requiredConfirmations: number;
  /** Production custody is refused unless the separate Safe pilot switch is on. */
  readonly productionEnabled: boolean;
  readonly maximumScanBlocks: number;
  readonly maximumScanLogs: number;
  readonly now?: () => number;
}) {
  if (
    !Number.isSafeInteger(input.requiredConfirmations) ||
    input.requiredConfirmations < 1 ||
    !Number.isSafeInteger(input.maximumScanBlocks) ||
    input.maximumScanBlocks < 1 ||
    !Number.isSafeInteger(input.maximumScanLogs) ||
    input.maximumScanLogs < 1
  ) {
    throw failed("invalid_config");
  }
  const now = input.now ?? Date.now;
  const payouts = makeControlPlaneRewardPayoutStore(input.layer);
  const safePayouts = makeControlPlaneRewardSafePayoutStore();
  const executions = makeControlPlaneRewardSafeExecutionStore();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(input.layer)(effect);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => failed("rpc_unavailable") });
  const admit = (deployment: { readonly environment: string; readonly chainId: number }) =>
    deployment.chainId !== 8453
      ? Effect.fail(failed("not_safe_chain"))
      : deployment.environment === "production" && !input.productionEnabled
        ? Effect.fail(failed("production_disabled"))
        : Effect.void;

  const prepare = Effect.fn("RewardSafePayoutCoordinator.prepare")(function* (creditId: string) {
    const candidate = yield* payouts.loadCandidate(creditId);
    yield* admit(candidate);
    const call = rewardSafeCall({
      effectId: `safe-payout-${crypto.randomUUID()}`,
      to: candidate.tokenAddress,
      data: encodeMegapotUsdcTransfer(candidate.destinationAddress, candidate.amountAtomic),
    });
    const calldataHash = yield* rpc(() => sha256Hex(hexToBytes(call.data)));
    const head = yield* rpc(() => input.rpc.readHead());
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
        safeAddress: candidate.custodyAddress,
        call,
        name: `Pirate payout ${call.effectId}`,
        description: `USDC payout of ${candidate.amountAtomic} atomic units for credit ${creditId}`,
        createdAtMs: now(),
      }),
    };
  });

  /** Read one bounded window of the Safe's executions at the confirmation depth. */
  const scan = Effect.fn("RewardSafePayoutCoordinator.scan")(function* (safe: {
    readonly chainId: number;
    readonly safeAddress: string;
  }) {
    const state = yield* provide(executions.loadScanState(safe));
    if (state === null) return { scanned: false as const };
    const head = yield* rpc(() => input.rpc.readHead());
    const settledHead = head.blockNumber - BigInt(input.requiredConfirmations - 1);
    if (settledHead < state.nextBlockNumber) return { scanned: false as const };
    const lastBlock = state.nextBlockNumber + BigInt(input.maximumScanBlocks - 1);
    const throughBlock = lastBlock < settledHead ? lastBlock : settledHead;
    const readLogs = input.rpc.readSafeExecutionLogs;
    const readNonce = input.rpc.readSafeNonce;
    const readTransaction = input.rpc.readTransaction;
    if (readLogs === undefined || readNonce === undefined || readTransaction === undefined) {
      return yield* failed("invalid_config");
    }
    const logs = yield* rpc(() =>
      readLogs({
        safe: safe.safeAddress,
        fromBlock: state.nextBlockNumber,
        toBlock: throughBlock,
        maximumBlocks: input.maximumScanBlocks,
        maximumLogs: input.maximumScanLogs,
      }),
    );
    const findings = yield* Effect.tryPromise({
      try: () =>
        findRewardSafeExecutions({
          safeAddress: safe.safeAddress,
          calls: state.calls,
          logs,
          readTransaction,
          readSafeNonce: readNonce,
        }),
      catch: () => failed("execution_unavailable"),
    });
    yield* provide(
      executions.recordScan({
        ...safe,
        fromBlock: state.nextBlockNumber,
        throughBlock,
        scannedEffectIds: state.calls.map((call) => call.effectId),
        findings,
      }),
    );
    return { scanned: true as const, throughBlock, findings };
  });

  /** Validate a bound execution's receipt and settle the credit, or release it on failure. */
  const settle = Effect.fn("RewardSafePayoutCoordinator.settle")(function* (effectId: string) {
    const settlement = yield* provide(safePayouts.loadSettlement(effectId));
    if (settlement === null) return { kind: "not_bound" as const };
    yield* admit(settlement.deployment);
    const readTransaction = input.rpc.readTransaction;
    if (readTransaction === undefined) return yield* failed("invalid_config");
    const [transaction, receipt, head] = yield* rpc(() =>
      Promise.all([
        readTransaction(settlement.transactionHash),
        input.rpc.readReceipt(settlement.transactionHash),
        input.rpc.readHead(),
      ]),
    );
    if (transaction === null || receipt === null || transaction.blockNumber === null) {
      return { kind: "pending" as const };
    }
    const depth = head.blockNumber - receipt.blockNumber + 1n;
    if (depth < BigInt(input.requiredConfirmations)) return { kind: "pending" as const };
    const confirmations = Number(depth > 1_000_000n ? 1_000_000n : depth);
    const receiptHash = yield* rpc(() => sha256Hex(toBytes(canonicalReceipt(receipt))));
    // The database recorded the observation; never confirm before it, whatever this clock says.
    const confirmedAt = new Date(Math.max(now(), Date.parse(settlement.observedAt))).toISOString();
    const reconcile = (reason: string) =>
      payouts.requireReconciliation({
        effectId,
        transactionHash: settlement.transactionHash,
        reason,
      });
    let classified: ReturnType<typeof classifyRewardSafeExecution>;
    let command: ReturnType<typeof rewardSafeCommandFromExecution>;
    try {
      command = rewardSafeCommandFromExecution({
        safeAddress: settlement.deployment.custodyAddress,
        nonce: settlement.safeNonce,
        call: rewardSafeCall({
          effectId,
          to: settlement.tokenAddress,
          data: settlement.calldata,
        }),
        executed: decodeRewardSafeExecutedCall(transaction.input),
      });
      classified = classifyRewardSafeExecution({
        command,
        transaction: {
          chainId: transaction.chainId ?? receipt.chainId,
          hash: transaction.transactionHash,
          from: transaction.from,
          to: transaction.to,
          value: transaction.valueWei,
          input: transaction.input,
          blockHash: receipt.blockHash,
          blockNumber: transaction.blockNumber,
        },
        receipt,
      });
    } catch {
      yield* reconcile("safe_execution_envelope_invalid");
      return { kind: "reconciliation_required" as const };
    }
    if (classified.outcome !== settlement.outcome) {
      yield* reconcile("safe_execution_outcome_changed");
      return { kind: "reconciliation_required" as const };
    }
    if (classified.outcome === "failure") {
      yield* provide(
        safePayouts.releaseFailedExecution({
          effectId,
          transactionHash: settlement.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          receiptHash,
          confirmations,
          confirmedAt,
        }),
      );
      return { kind: "released" as const };
    }
    let evidence: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      evidence = validateMegapotUsdcTransferReceipt({
        deployment: settlement.deployment,
        receipt,
        recipient: settlement.destinationAddress,
        amountAtomic: settlement.amountAtomic,
        safeExecution: {
          command,
          transaction: {
            chainId: transaction.chainId ?? receipt.chainId,
            hash: transaction.transactionHash,
            from: transaction.from,
            to: transaction.to,
            value: transaction.valueWei,
            input: transaction.input,
            blockHash: receipt.blockHash,
            blockNumber: transaction.blockNumber,
          },
        },
      });
    } catch {
      yield* reconcile("safe_payout_receipt_invalid");
      return { kind: "reconciliation_required" as const };
    }
    const custodyBalanceAfterAtomic = yield* rpc(() =>
      input.rpc.readUsdcBalance(settlement.deployment.custodyAddress, receipt.blockNumber),
    );
    yield* payouts.confirm({
      effectId,
      transactionHash: settlement.transactionHash,
      transferLogIndex: evidence.transferLogIndex,
      amountAtomic: evidence.amountAtomic,
      custodyBalanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash,
      confirmations,
      confirmedAt,
    });
    return { kind: "confirmed" as const, transactionHash: settlement.transactionHash };
  });

  return { prepare, scan, settle };
}
