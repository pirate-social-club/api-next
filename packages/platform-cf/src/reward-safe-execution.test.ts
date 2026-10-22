import { expect, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  parseAbi,
} from "viem";
import type { MegapotReceiptLog, MegapotTransactionReceipt } from "./megapot-v2.ts";
import {
  type RewardSafeCommand,
  type RewardSafeOuterTransaction,
  rewardSafeTransactionHash,
  validateRewardSafeExecution,
} from "./reward-safe-execution.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const EXECUTOR = "0x1111111111111111111111111111111111111111";
const TX = `0x${"aa".repeat(32)}` as Hex;
const BLOCK = `0x${"bb".repeat(32)}` as Hex;
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
const command: RewardSafeCommand = {
  chainId: 8453,
  safeAddress: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  nonce: 7n,
  to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000010000100000000000000000000000000000000000000000000000000000000000f4240",
  operation: 0,
  safeTxGas: 150_000n,
};

function envelope(value = command, gasPrice = 0n): Hex {
  return encodeFunctionData({
    abi,
    functionName: "execTransaction",
    args: [
      value.to,
      0n,
      value.data,
      value.operation,
      value.safeTxGas,
      0n,
      gasPrice,
      ZERO,
      ZERO,
      "0x",
    ],
  });
}

function fixture() {
  const transaction: RewardSafeOuterTransaction = {
    chainId: 8453,
    hash: TX,
    from: EXECUTOR,
    to: command.safeAddress,
    value: 0n,
    input: envelope(),
    blockHash: BLOCK,
    blockNumber: 52944896n,
  };
  const event: MegapotReceiptLog = {
    address: command.safeAddress,
    topics: encodeEventTopics({
      abi,
      eventName: "ExecutionSuccess",
      args: { txHash: rewardSafeTransactionHash(command) },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [0n]),
    logIndex: 3,
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: transaction.blockNumber,
  };
  const receipt: MegapotTransactionReceipt = {
    chainId: 8453,
    status: "success",
    transactionHash: TX,
    from: EXECUTOR,
    to: command.safeAddress,
    blockHash: BLOCK,
    blockNumber: transaction.blockNumber,
    logs: [event],
  };
  return { command, transaction, receipt, event };
}

test("hash matches read-only getTransactionHash on released Safe at pinned Base block", () => {
  // eth_call to the singleton at block52944896; this tests hashing, not proxy setup.
  expect(rewardSafeTransactionHash(command)).toBe(
    "0xc73b1a2cb4efa923e4d00aea8e24a09d1f87fe1aaf805100f12dbe42e84ed003",
  );
});

test("accepts exact direct execution and preserves distinct Safe and outer hashes", () => {
  expect(validateRewardSafeExecution(fixture())).toEqual({
    safeTransactionHash: rewardSafeTransactionHash(command),
    transactionHash: TX,
    executionLogIndex: 3,
  });
});

test("refuses successful outer receipt carrying Safe inner failure", () => {
  const input = fixture();
  const event = {
    ...input.event,
    topics: encodeEventTopics({
      abi,
      eventName: "ExecutionFailure",
      args: { txHash: rewardSafeTransactionHash(command) },
    }) as [Hex, ...Hex[]],
  };
  expect(() =>
    validateRewardSafeExecution({ ...input, receipt: { ...input.receipt, logs: [event] } }),
  ).toThrow();
});

test("a matching transfer or nonce change cannot replace the Safe success event", () => {
  const input = fixture();
  expect(() =>
    validateRewardSafeExecution({ ...input, receipt: { ...input.receipt, logs: [] } }),
  ).toThrow();
});

test("nonce is bound by the Safe event hash even though execTransaction omits it", () => {
  expect(() =>
    validateRewardSafeExecution({ ...fixture(), command: { ...command, nonce: 8n } }),
  ).toThrow();
});

test("refuses substituted target, data, operation, gas limit and pool-funded refunds", () => {
  const input = fixture();
  const replacements = [
    envelope({ ...command, to: EXECUTOR }),
    envelope({ ...command, data: "0x1234" }),
    envelope({ ...command, operation: 1 }),
    envelope({ ...command, safeTxGas: 151_000n }),
    envelope(command, 1n),
  ];
  for (const replacement of replacements) {
    expect(() =>
      validateRewardSafeExecution({
        ...input,
        transaction: { ...input.transaction, input: replacement },
      }),
    ).toThrow();
  }
});

test("refuses mismatched chain, Safe, executor, transaction, block and native value", () => {
  const input = fixture();
  const replacements: Partial<RewardSafeOuterTransaction>[] = [
    { chainId: 84532 },
    { to: EXECUTOR },
    { to: null },
    { from: ZERO },
    { hash: BLOCK },
    { blockHash: TX },
    { blockNumber: 1n },
    { value: 1n },
  ];
  for (const replacement of replacements) {
    expect(() =>
      validateRewardSafeExecution({
        ...input,
        transaction: { ...input.transaction, ...replacement },
      }),
    ).toThrow();
  }
  expect(() =>
    validateRewardSafeExecution({ ...input, receipt: { ...input.receipt, status: "reverted" } }),
  ).toThrow();
});

test("refuses forged, removed, wrong-block and duplicate receipt logs", () => {
  const input = fixture();
  const replacements: Partial<MegapotReceiptLog>[] = [
    { address: EXECUTOR },
    { removed: true },
    { blockHash: TX },
    { blockNumber: 1n },
    { transactionHash: BLOCK },
    { logIndex: -1 },
    { data: encodeAbiParameters([{ type: "uint256" }], [1n]) },
  ];
  for (const replacement of replacements) {
    expect(() =>
      validateRewardSafeExecution({
        ...input,
        receipt: { ...input.receipt, logs: [{ ...input.event, ...replacement }] },
      }),
    ).toThrow();
  }
  for (const index of [3, 4]) {
    expect(() =>
      validateRewardSafeExecution({
        ...input,
        receipt: { ...input.receipt, logs: [input.event, { ...input.event, logIndex: index }] },
      }),
    ).toThrow();
  }
});

test("refuses malformed execution calldata and malformed Safe events", () => {
  const input = fixture();
  expect(() =>
    validateRewardSafeExecution({
      ...input,
      transaction: { ...input.transaction, input: "0x1234" },
    }),
  ).toThrow();
  expect(() =>
    validateRewardSafeExecution({
      ...input,
      receipt: { ...input.receipt, logs: [{ ...input.event, data: "0x" }] },
    }),
  ).toThrow();
});
