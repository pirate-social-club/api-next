import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import { type Hex, toBytes } from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import {
  decodeRewardSafeExecutedCall,
  rewardSafeCall,
  rewardSafeCommandFromExecution,
} from "./reward-safe-command.ts";
import {
  classifyRewardSafeExecution,
  type RewardSafeAdmission,
  type RewardSafeCommand,
  type RewardSafeOuterTransaction,
  rewardSafeChainAdmitted,
} from "./reward-safe-execution.ts";
import { makeControlPlaneRewardSafeExecutionStore } from "./reward-safe-execution-repository.ts";
import { findRewardSafeExecutions } from "./reward-safe-reconciliation.ts";
import { canonicalReceipt } from "./reward-token-send-coordinator.ts";

export class RewardSafeSettlementFailed extends Data.TaggedError("RewardSafeSettlementFailed")<{
  readonly reason:
    | "invalid_config"
    | "not_safe_chain"
    | "production_disabled"
    | "rpc_unavailable"
    | "execution_unavailable";
}> {}

export const rewardSafeFailed = (reason: RewardSafeSettlementFailed["reason"]) =>
  new RewardSafeSettlementFailed({ reason });

export type RewardSafeRuntimeOptions = RewardSafeAdmission &
  Readonly<{
    layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
    rpc: MegapotV2RpcClient;
    requiredConfirmations: number;
    maximumScanBlocks: number;
    maximumScanLogs: number;
    now?: () => number;
  }>;

export function assertRewardSafeRuntimeOptions(input: RewardSafeRuntimeOptions): void {
  if (
    !Number.isSafeInteger(input.requiredConfirmations) ||
    input.requiredConfirmations < 1 ||
    !Number.isSafeInteger(input.maximumScanBlocks) ||
    input.maximumScanBlocks < 1 ||
    !Number.isSafeInteger(input.maximumScanLogs) ||
    input.maximumScanLogs < 1
  ) {
    throw rewardSafeFailed("invalid_config");
  }
}

/** Safe custody runs only where this runtime's own environment admits the deployment. */
export function admitRewardSafeDeployment(
  options: RewardSafeRuntimeOptions,
  deployment: { readonly environment: string; readonly chainId: number },
): Effect.Effect<void, RewardSafeSettlementFailed> {
  if (deployment.chainId !== 8453 && deployment.chainId !== 84_532) {
    return Effect.fail(rewardSafeFailed("not_safe_chain"));
  }
  return rewardSafeChainAdmitted({
    runtimeEnvironment: options.runtimeEnvironment,
    productionEnabled: options.productionEnabled,
    environment: deployment.environment,
    chainId: deployment.chainId,
  })
    ? Effect.void
    : Effect.fail(rewardSafeFailed("production_disabled"));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read one bounded window of a Safe's executions at the confirmation depth and record
 * it. Every prepared Safe call is scanned together, whatever its effect kind.
 */
export function makeRewardSafeExecutionScanner(options: RewardSafeRuntimeOptions) {
  assertRewardSafeRuntimeOptions(options);
  const executions = makeControlPlaneRewardSafeExecutionStore();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(options.layer)(effect);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });
  return Effect.fn("RewardSafeExecutionScanner.scan")(function* (safe: {
    readonly chainId: number;
    readonly safeAddress: string;
  }) {
    const state = yield* provide(executions.loadScanState(safe));
    if (state === null) return { scanned: false as const };
    const head = yield* rpc(() => options.rpc.readHead());
    const settledHead = head.blockNumber - BigInt(options.requiredConfirmations - 1);
    if (settledHead < state.nextBlockNumber) return { scanned: false as const };
    const lastBlock = state.nextBlockNumber + BigInt(options.maximumScanBlocks - 1);
    const throughBlock = lastBlock < settledHead ? lastBlock : settledHead;
    const readLogs = options.rpc.readSafeExecutionLogs;
    const readNonce = options.rpc.readSafeNonce;
    const readTransaction = options.rpc.readTransaction;
    if (readLogs === undefined || readNonce === undefined || readTransaction === undefined) {
      return yield* rewardSafeFailed("invalid_config");
    }
    const logs = yield* rpc(() =>
      readLogs({
        safe: safe.safeAddress,
        fromBlock: state.nextBlockNumber,
        toBlock: throughBlock,
        maximumBlocks: options.maximumScanBlocks,
        maximumLogs: options.maximumScanLogs,
      }),
    );
    const findings = yield* Effect.tryPromise({
      try: () =>
        findRewardSafeExecutions({
          chainId: safe.chainId,
          safeAddress: safe.safeAddress,
          calls: state.calls,
          logs,
          readTransaction,
          readSafeNonce: readNonce,
        }),
      catch: () => rewardSafeFailed("execution_unavailable"),
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
}

type RewardSafeBoundExecution = Readonly<{
  kind: "bound";
  outcome: "success" | "failure";
  command: RewardSafeCommand;
  transaction: RewardSafeOuterTransaction;
  receipt: MegapotTransactionReceipt;
  confirmations: number;
  receiptHash: string;
  confirmedAt: string;
}>;

/**
 * The receipt-side evidence for one bound Safe execution, once it is deep enough.
 * `invalid` means the outer envelope or outcome no longer matches what the scan
 * recorded, or the receipt is not on the canonical chain; the caller must hold the
 * effect for reconciliation. An unreadable chain is an error and changes nothing.
 */
export function readRewardSafeExecution(
  options: RewardSafeRuntimeOptions,
  input: {
    readonly effectId: string;
    readonly chainId: number;
    readonly safeAddress: string;
    readonly to: string;
    readonly calldata: Hex;
    readonly safeNonce: bigint;
    readonly transactionHash: string;
    readonly recordedOutcome: "success" | "failure";
    readonly observedAt: string;
  },
) {
  const now = options.now ?? Date.now;
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });
  return Effect.gen(function* () {
    const readTransaction = options.rpc.readTransaction;
    if (readTransaction === undefined) return yield* rewardSafeFailed("invalid_config");
    const [transaction, receipt, head] = yield* rpc(() =>
      Promise.all([
        readTransaction(input.transactionHash),
        options.rpc.readReceipt(input.transactionHash),
        options.rpc.readHead(),
      ]),
    );
    if (transaction === null || receipt === null || transaction.blockNumber === null) {
      return { kind: "pending" as const };
    }
    const depth = head.blockNumber - receipt.blockNumber + 1n;
    if (depth < BigInt(options.requiredConfirmations)) return { kind: "pending" as const };
    // A provider can still serve the receipt of an orphaned block. Before either outcome
    // settles anything, its block must be the canonical block at that height.
    const block = yield* rpc(() => options.rpc.readBlock(receipt.blockNumber));
    if (block.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return { kind: "invalid" as const, reason: "safe_execution_receipt_not_canonical" };
    }
    const receiptHash = yield* rpc(() => sha256Hex(toBytes(canonicalReceipt(receipt))));
    const outer: RewardSafeOuterTransaction = {
      chainId: transaction.chainId ?? receipt.chainId,
      hash: transaction.transactionHash,
      from: transaction.from,
      to: transaction.to,
      value: transaction.valueWei,
      input: transaction.input,
      blockHash: receipt.blockHash,
      blockNumber: transaction.blockNumber,
    };
    let command: RewardSafeCommand;
    let outcome: "success" | "failure";
    try {
      command = rewardSafeCommandFromExecution({
        chainId: input.chainId,
        safeAddress: input.safeAddress,
        nonce: input.safeNonce,
        call: rewardSafeCall({ effectId: input.effectId, to: input.to, data: input.calldata }),
        executed: decodeRewardSafeExecutedCall(transaction.input),
      });
      outcome = classifyRewardSafeExecution({ command, transaction: outer, receipt }).outcome;
    } catch {
      return { kind: "invalid" as const, reason: "safe_execution_envelope_invalid" };
    }
    if (outcome !== input.recordedOutcome) {
      return { kind: "invalid" as const, reason: "safe_execution_outcome_changed" };
    }
    // The database recorded the observation; never confirm before it, whatever this clock says.
    const confirmedAt = new Date(Math.max(now(), Date.parse(input.observedAt))).toISOString();
    return {
      kind: "bound",
      outcome,
      command,
      transaction: outer,
      receipt,
      confirmations: Number(depth > 1_000_000n ? 1_000_000n : depth),
      receiptHash,
      confirmedAt,
    } satisfies RewardSafeBoundExecution;
  });
}
