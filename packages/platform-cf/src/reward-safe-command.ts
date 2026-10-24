import { type Address, decodeFunctionData, getAddress, type Hex, parseAbi } from "viem";
import type { RewardSafeCommand } from "./reward-safe-execution.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const executionAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);

type RewardSafeCallFailure =
  | "invalid-call"
  | "duplicate-call"
  | "ambiguous-match"
  | "invalid-execution";

function refuse(reason: RewardSafeCallFailure): never {
  throw new Error(`reward_safe_call_${reason}`);
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function address(value: string, reason: RewardSafeCallFailure): Address {
  try {
    return getAddress(value);
  } catch {
    return refuse(reason);
  }
}

/**
 * One call Pirate prepares for the owner's Safe. Pirate fixes only the target and
 * calldata; Safe{Wallet} chooses the nonce and gas limit when the owner executes it,
 * so reconciliation binds an execution to this call by content.
 */
export type RewardSafeCall = Readonly<{ effectId: string; to: Address; data: Hex }>;

export function rewardSafeCall(input: {
  readonly effectId: string;
  readonly to: string;
  readonly data: string;
}): RewardSafeCall {
  const effectId = input.effectId;
  if (
    effectId.length === 0 ||
    effectId !== effectId.trim() ||
    new TextEncoder().encode(effectId).length > 128 ||
    !/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/iu.test(input.data) ||
    same(input.to, ZERO)
  ) {
    refuse("invalid-call");
  }
  return {
    effectId,
    to: address(input.to, "invalid-call"),
    data: input.data.toLowerCase() as Hex,
  };
}

/**
 * Content binding needs every unresolved call to be distinguishable. A USDC payout of
 * the same amount to the same wallet repeats calldata exactly, so a second one must wait
 * until the first is resolved rather than risk crediting one execution to two effects.
 */
export function assertRewardSafeCallUnique(
  unresolved: readonly RewardSafeCall[],
  candidate: RewardSafeCall,
): void {
  for (const call of unresolved) {
    const sameContent = same(call.to, candidate.to) && same(call.data, candidate.data);
    if (call.effectId === candidate.effectId ? !sameContent : sameContent) {
      refuse("duplicate-call");
    }
  }
}

/** The outer execTransaction arguments exactly as the chain recorded them. */
export type RewardSafeExecutedCall = Readonly<{
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
}>;

function decodeExecution(input: Hex) {
  try {
    return decodeFunctionData({ abi: executionAbi, data: input }).args;
  } catch {
    return refuse("invalid-execution");
  }
}

export function decodeRewardSafeExecutedCall(input: Hex): RewardSafeExecutedCall {
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] =
    decodeExecution(input);
  return {
    to: address(to, "invalid-execution"),
    value,
    data: data.toLowerCase() as Hex,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken: address(gasToken, "invalid-execution"),
    refundReceiver: address(refundReceiver, "invalid-execution"),
  };
}

/**
 * Find the prepared call an execution ran. Matching is by target and calldata only, so
 * an execution of Pirate's call is never ignored because the owner changed a Safe
 * parameter. `conforming` is false when it carried native value, a delegate call or a
 * gas refund; such an execution happened but needs reconciliation, not acceptance.
 */
export function matchRewardSafeCall(
  calls: readonly RewardSafeCall[],
  executed: RewardSafeExecutedCall,
): Readonly<{ call: RewardSafeCall; conforming: boolean }> | null {
  const matches = calls.filter(
    (call) => same(call.to, executed.to) && same(call.data, executed.data),
  );
  if (matches.length > 1) refuse("ambiguous-match");
  const call = matches[0];
  if (call === undefined) return null;
  const conforming =
    executed.value === 0n &&
    executed.operation === 0 &&
    executed.baseGas === 0n &&
    executed.gasPrice === 0n &&
    same(executed.gasToken, ZERO) &&
    same(executed.refundReceiver, ZERO);
  return { call, conforming };
}

/** The Safe command that a conforming execution signed, using the nonce it consumed. */
export function rewardSafeCommandFromExecution(input: {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly nonce: bigint;
  readonly call: RewardSafeCall;
  readonly executed: RewardSafeExecutedCall;
}): RewardSafeCommand {
  const match = matchRewardSafeCall([input.call], input.executed);
  if (match === null || !match.conforming || input.nonce < 0n) refuse("invalid-execution");
  if (input.chainId !== 8453 && input.chainId !== 84_532) refuse("invalid-execution");
  return {
    chainId: input.chainId,
    safeAddress: address(input.safeAddress, "invalid-execution"),
    nonce: input.nonce,
    to: input.call.to,
    data: input.call.data,
    operation: 0,
    safeTxGas: input.executed.safeTxGas,
  };
}

/**
 * A Safe Transaction Builder import file for one call. The file is a convenience for the
 * owner, not evidence: reconciliation trusts only the executed calldata. The builder may
 * warn that the file has no checksum; Pirate does not compute one.
 */
export function rewardSafeTransactionBuilderFile(input: {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly call: RewardSafeCall;
  readonly name: string;
  readonly description: string;
  readonly createdAtMs: number;
}): Readonly<{
  version: "1.0";
  chainId: "8453" | "84532";
  createdAt: number;
  meta: Readonly<{ name: string; description: string; createdFromSafeAddress: Address }>;
  transactions: readonly Readonly<{
    to: Address;
    value: "0";
    data: Hex;
    contractMethod: null;
    contractInputsValues: null;
  }>[];
}> {
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) refuse("invalid-call");
  if (input.chainId !== 8453 && input.chainId !== 84_532) refuse("invalid-call");
  return {
    version: "1.0",
    chainId: input.chainId === 8453 ? "8453" : "84532",
    createdAt: input.createdAtMs,
    meta: {
      name: input.name,
      description: input.description,
      createdFromSafeAddress: address(input.safeAddress, "invalid-call"),
    },
    transactions: [
      {
        to: input.call.to,
        value: "0",
        data: input.call.data,
        contractMethod: null,
        contractInputsValues: null,
      },
    ],
  };
}
