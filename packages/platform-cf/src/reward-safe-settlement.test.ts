import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  parseAbi,
} from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";
import { readRewardSafeExecution } from "./reward-safe-settlement.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = `0x${"5".repeat(40)}`;
const USDC = `0x${"3".repeat(40)}`;
const OWNER = `0x${"9".repeat(40)}`;
const TX = `0x${"aa".repeat(32)}`;
const RECEIPT_BLOCK = `0x${"bb".repeat(32)}`;
const OTHER_BLOCK = `0x${"cc".repeat(32)}`;
const BLOCK_NUMBER = 5_000n;
const DATA =
  "0xa9059cbb000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00000000000000000000000000000000000000000000000000000000000f4240" as Hex;
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);

/**
 * One owner execution at BLOCK_NUMBER, three blocks deep. `canonical` is what the chain
 * answers for that height: the receipt's own block, another block, or no answer.
 */
function chain(outcome: "success" | "failure", canonical: string | Error) {
  const safeTxGas = 90_000n;
  const safeTransactionHash = rewardSafeTransactionHash({
    chainId: 8453,
    safeAddress: SAFE as Hex,
    nonce: 7n,
    to: USDC as Hex,
    data: DATA,
    operation: 0,
    safeTxGas,
  });
  const receipt: MegapotTransactionReceipt = {
    chainId: 8453,
    status: "success",
    transactionHash: TX,
    from: OWNER,
    to: SAFE,
    blockHash: RECEIPT_BLOCK,
    blockNumber: BLOCK_NUMBER,
    logs: [
      {
        address: SAFE,
        topics: encodeEventTopics({
          abi,
          eventName: outcome === "success" ? "ExecutionSuccess" : "ExecutionFailure",
          args: { txHash: safeTransactionHash },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }], [0n]),
        logIndex: 0,
        transactionHash: TX,
        blockHash: RECEIPT_BLOCK,
        blockNumber: BLOCK_NUMBER,
      },
    ],
  };
  const blockReads: bigint[] = [];
  const rpc = {
    readTransaction: async () => ({
      transactionHash: TX,
      chainId: 8453,
      from: OWNER,
      to: SAFE,
      nonce: 1n,
      valueWei: 0n,
      input: encodeFunctionData({
        abi,
        functionName: "execTransaction",
        args: [USDC as Hex, 0n, DATA, 0, safeTxGas, 0n, 0n, ZERO, ZERO, "0x"],
      }),
      blockNumber: BLOCK_NUMBER,
    }),
    readReceipt: async () => receipt,
    readHead: async () => ({ blockNumber: BLOCK_NUMBER + 2n, blockHash: `0x${"dd".repeat(32)}` }),
    readBlock: async (blockNumber: bigint) => {
      blockReads.push(blockNumber);
      if (canonical instanceof Error) throw canonical;
      return { blockNumber, blockHash: canonical };
    },
  } as unknown as MegapotV2RpcClient;
  const read = (recordedOutcome: "success" | "failure" = outcome) =>
    Effect.runPromise(
      readRewardSafeExecution(
        {
          layer: Layer.empty as never,
          rpc,
          requiredConfirmations: 3,
          runtimeEnvironment: "production",
          productionEnabled: true,
          maximumScanBlocks: 200,
          maximumScanLogs: 50,
          now: () => Date.parse("2026-10-24T00:00:00Z"),
        },
        {
          effectId: "effect-1",
          chainId: 8453,
          safeAddress: SAFE,
          to: USDC,
          calldata: DATA,
          safeNonce: 7n,
          transactionHash: TX,
          recordedOutcome,
          observedAt: "2026-10-23T00:00:00.000Z",
        },
      ),
    );
  return { read, blockReads };
}

for (const outcome of ["success", "failure"] as const) {
  test(`a canonical ${outcome} execution is bound with its receipt`, async () => {
    const { read, blockReads } = chain(outcome, RECEIPT_BLOCK);
    expect(await read()).toMatchObject({
      kind: "bound",
      outcome,
      confirmations: 3,
      receipt: { blockHash: RECEIPT_BLOCK, blockNumber: BLOCK_NUMBER },
    });
    expect(blockReads).toEqual([BLOCK_NUMBER]);
  });

  test(`a ${outcome} receipt from a block that is no longer canonical is held`, async () => {
    const { read } = chain(outcome, OTHER_BLOCK);
    expect(await read()).toEqual({
      kind: "invalid",
      reason: "safe_execution_receipt_not_canonical",
    });
  });

  test(`an unreadable canonical block for a ${outcome} settles nothing`, async () => {
    const { read } = chain(outcome, new Error("timeout"));
    await expect(read()).rejects.toMatchObject({
      _tag: "RewardSafeSettlementFailed",
      reason: "rpc_unavailable",
    });
  });
}

test("the canonical check comes before the recorded outcome is compared", async () => {
  // An orphaned failure recorded as success is refused as orphaned, not as changed.
  const { read } = chain("failure", OTHER_BLOCK);
  expect(await read("success")).toEqual({
    kind: "invalid",
    reason: "safe_execution_receipt_not_canonical",
  });
});
