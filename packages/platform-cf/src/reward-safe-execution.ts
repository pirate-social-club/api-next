import {
  type Address,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  parseAbi,
  toEventSelector,
} from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const executionAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
const successTopic = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const failureTopic = toEventSelector("ExecutionFailure(bytes32,uint256)");
const safeTypes = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The pilot pays execution gas outside the pool; native value and refunds are zero. */
export type RewardSafeCommand = Readonly<{
  chainId: 8453;
  safeAddress: Address;
  nonce: bigint;
  to: Address;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
}>;

export type RewardSafeOuterTransaction = Readonly<{
  chainId: number;
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  input: Hex;
  blockHash: string;
  blockNumber: bigint;
}>;

function refuse(): never {
  throw new Error("reward_safe_execution_invalid");
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function address(value: string): Address {
  try {
    return getAddress(value);
  } catch {
    return refuse();
  }
}

function hash(value: string): Hex {
  if (!/^0x[0-9a-f]{64}$/iu.test(value)) refuse();
  return value.toLowerCase() as Hex;
}

/** Safe 1.4.1 EIP-712 identity, distinct from the outer execution transaction hash. */
export function rewardSafeTransactionHash(command: RewardSafeCommand): Hex {
  if (
    command.chainId !== 8453 ||
    command.nonce < 0n ||
    command.safeTxGas < 0n ||
    (command.operation !== 0 && command.operation !== 1) ||
    !/^0x(?:[0-9a-f]{2})*$/iu.test(command.data) ||
    same(command.safeAddress, ZERO) ||
    same(command.to, ZERO)
  ) {
    refuse();
  }
  return hashTypedData({
    domain: { chainId: command.chainId, verifyingContract: address(command.safeAddress) },
    types: safeTypes,
    primaryType: "SafeTx",
    message: {
      to: address(command.to),
      value: 0n,
      data: command.data,
      operation: command.operation,
      safeTxGas: command.safeTxGas,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: command.nonce,
    },
  });
}

/**
 * Validate one direct execTransaction envelope, without rewriting receipt parties.
 * The caller must pin Safe code/config, establish finality and separately validate
 * the business events. ExecutionSuccess alone is not evidence of a USDC payment.
 */
export function validateRewardSafeExecution(input: {
  readonly command: RewardSafeCommand;
  readonly transaction: RewardSafeOuterTransaction;
  readonly receipt: MegapotTransactionReceipt;
}): Readonly<{ safeTransactionHash: Hex; transactionHash: Hex; executionLogIndex: number }> {
  const { command, transaction, receipt } = input;
  const safeTransactionHash = rewardSafeTransactionHash(command);
  const transactionHash = hash(transaction.hash);
  if (
    receipt.chainId !== command.chainId ||
    transaction.chainId !== command.chainId ||
    receipt.status !== "success" ||
    transaction.value !== 0n ||
    transaction.to === null ||
    receipt.to === null ||
    !same(address(transaction.to), command.safeAddress) ||
    !same(address(receipt.to), command.safeAddress) ||
    !same(address(transaction.from), address(receipt.from)) ||
    hash(receipt.transactionHash) !== transactionHash ||
    hash(receipt.blockHash) !== hash(transaction.blockHash) ||
    receipt.blockNumber < 0n ||
    receipt.blockNumber !== transaction.blockNumber
  ) {
    refuse();
  }
  const decoded = decodeFunctionData({ abi: executionAbi, data: transaction.input });
  if (decoded.functionName !== "execTransaction") refuse();
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, receiver] =
    decoded.args;
  if (
    !same(to, command.to) ||
    value !== 0n ||
    !same(data, command.data) ||
    operation !== command.operation ||
    safeTxGas !== command.safeTxGas ||
    baseGas !== 0n ||
    gasPrice !== 0n ||
    !same(gasToken, ZERO) ||
    !same(receiver, ZERO)
  ) {
    refuse();
  }
  const seen = new Set<number>();
  let executionLogIndex: number | undefined;
  for (const log of receipt.logs) {
    address(log.address);
    if (
      log.removed === true ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      seen.has(log.logIndex) ||
      hash(log.transactionHash) !== transactionHash ||
      hash(log.blockHash) !== hash(receipt.blockHash) ||
      log.blockNumber !== receipt.blockNumber
    ) {
      refuse();
    }
    seen.add(log.logIndex);
    if (!same(log.address, command.safeAddress)) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic !== successTopic && topic !== failureTopic) continue;
    const event = decodeEventLog({
      abi: executionAbi,
      topics: log.topics,
      data: log.data,
      strict: true,
    });
    if (
      event.eventName !== "ExecutionSuccess" ||
      hash(event.args.txHash) !== safeTransactionHash ||
      event.args.payment !== 0n ||
      executionLogIndex !== undefined
    ) {
      refuse();
    }
    executionLogIndex = log.logIndex;
  }
  if (executionLogIndex === undefined) refuse();
  return { safeTransactionHash, transactionHash, executionLogIndex };
}
