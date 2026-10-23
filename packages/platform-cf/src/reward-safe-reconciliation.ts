import type { MegapotV2SafeExecutionLog, MegapotV2Transaction } from "./megapot-v2-rpc.ts";
import {
  decodeRewardSafeExecutedCall,
  matchRewardSafeCall,
  type RewardSafeCall,
  type RewardSafeExecutedCall,
  rewardSafeCommandFromExecution,
} from "./reward-safe-command.ts";
import { type RewardSafeCommand, rewardSafeTransactionHash } from "./reward-safe-execution.ts";

/**
 * What one Safe execution event means for Pirate's prepared calls. `matched` is a
 * conforming execution whose recomputed Safe hash equals the event, so its business
 * receipt may be validated next. Every other kind is evidence for reconciliation and
 * never settles an effect on its own.
 */
export type RewardSafeExecutionFinding =
  | Readonly<{
      kind: "matched";
      call: RewardSafeCall;
      log: MegapotV2SafeExecutionLog;
      executor: string;
      safeNonce: bigint;
      command: RewardSafeCommand;
    }>
  | Readonly<{
      kind: "nonconforming" | "hash_mismatch";
      call: RewardSafeCall;
      log: MegapotV2SafeExecutionLog;
      executor: string;
      safeNonce: bigint;
    }>
  | Readonly<{ kind: "undecodable"; log: MegapotV2SafeExecutionLog }>;

function refuse(): never {
  throw new Error("reward_safe_reconciliation_invalid");
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Bind the Safe's execution events in a scanned block range to prepared calls.
 *
 * The scan must hold every execution event of each block it covers: the nonce an
 * execution consumed is the Safe nonce at the parent block plus the number of earlier
 * executions in the same block. Executions of unrelated calls are dropped. An event
 * whose outer transaction did not call the Safe directly cannot be matched by content
 * and is returned as `undecodable`, because it might still have run Pirate's call.
 * A call is only considered from its `notBeforeBlock`, the head when it was prepared:
 * an earlier execution with identical content cannot have been this call.
 */
export async function findRewardSafeExecutions(input: {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly calls: readonly (RewardSafeCall & Readonly<{ notBeforeBlock?: bigint }>)[];
  readonly logs: readonly MegapotV2SafeExecutionLog[];
  readonly readTransaction: (transactionHash: string) => Promise<MegapotV2Transaction | null>;
  readonly readSafeNonce: (safe: string, blockNumber: bigint) => Promise<bigint>;
}): Promise<readonly RewardSafeExecutionFinding[]> {
  const logs = [...input.logs].sort((left, right) =>
    left.blockNumber === right.blockNumber
      ? left.logIndex - right.logIndex
      : left.blockNumber < right.blockNumber
        ? -1
        : 1,
  );
  const blockHashes = new Map<bigint, string>();
  const positions = new Map<string, number>();
  for (const log of logs) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    if (positions.has(key) || log.blockNumber < 1n) refuse();
    const known = blockHashes.get(log.blockNumber);
    if (known !== undefined && !same(known, log.blockHash)) refuse();
    blockHashes.set(log.blockNumber, log.blockHash);
    positions.set(
      key,
      logs.filter((other) => other.blockNumber === log.blockNumber && other.logIndex < log.logIndex)
        .length,
    );
  }
  const parentNonces = new Map<bigint, bigint>();
  const findings: RewardSafeExecutionFinding[] = [];
  for (const log of logs) {
    const transaction = await input.readTransaction(log.transactionHash);
    if (
      transaction === null ||
      transaction.blockNumber !== log.blockNumber ||
      !same(transaction.transactionHash, log.transactionHash)
    ) {
      refuse();
    }
    if (transaction.to === null || !same(transaction.to, input.safeAddress)) {
      findings.push({ kind: "undecodable", log });
      continue;
    }
    let executed: RewardSafeExecutedCall;
    try {
      executed = decodeRewardSafeExecutedCall(transaction.input);
    } catch {
      findings.push({ kind: "undecodable", log });
      continue;
    }
    const match = matchRewardSafeCall(
      input.calls.filter((call) => (call.notBeforeBlock ?? 0n) <= log.blockNumber),
      executed,
    );
    if (match === null) continue;
    let parentNonce = parentNonces.get(log.blockNumber);
    if (parentNonce === undefined) {
      parentNonce = await input.readSafeNonce(input.safeAddress, log.blockNumber - 1n);
      parentNonces.set(log.blockNumber, parentNonce);
    }
    const safeNonce =
      parentNonce + BigInt(positions.get(`${log.blockNumber}:${log.logIndex}`) ?? 0);
    const base = { call: match.call, log, executor: transaction.from.toLowerCase(), safeNonce };
    if (!match.conforming) {
      findings.push({ kind: "nonconforming", ...base });
      continue;
    }
    const command = rewardSafeCommandFromExecution({
      chainId: input.chainId,
      safeAddress: input.safeAddress,
      nonce: safeNonce,
      call: match.call,
      executed,
    });
    findings.push(
      same(rewardSafeTransactionHash(command), log.safeTransactionHash)
        ? { kind: "matched", ...base, command }
        : { kind: "hash_mismatch", ...base },
    );
  }
  return findings;
}
