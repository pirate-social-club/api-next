import { expect, test } from "bun:test";
import { encodeFunctionData, type Hex, parseAbi } from "viem";
import type { MegapotV2SafeExecutionLog, MegapotV2Transaction } from "./megapot-v2-rpc.ts";
import { type RewardSafeCall, rewardSafeCall } from "./reward-safe-command.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";
import { findRewardSafeExecutions } from "./reward-safe-reconciliation.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0x2222222222222222222222222222222222222222";
const BLOCK_HASH = `0x${"bb".repeat(32)}`;
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const transfer = (recipient: string, amount: bigint): Hex =>
  encodeFunctionData({ abi, functionName: "transfer", args: [recipient as Hex, amount] });
const payoutA = rewardSafeCall({
  effectId: "payout-a",
  to: USDC,
  data: transfer("0x1111111111111111111111111111111111111111", 1_110_000n),
});
const payoutB = rewardSafeCall({
  effectId: "payout-b",
  to: USDC,
  data: transfer("0x3333333333333333333333333333333333333333", 2_220_000n),
});
const unrelated = rewardSafeCall({
  effectId: "not-pirate",
  to: USDC,
  data: transfer(OWNER, 5n),
});

function envelope(call: RewardSafeCall, gasPrice = 0n): Hex {
  return encodeFunctionData({
    abi,
    functionName: "execTransaction",
    args: [call.to, 0n, call.data, 0, 80_000n, 0n, gasPrice, ZERO, ZERO, "0x"],
  });
}

function safeHash(call: RewardSafeCall, nonce: bigint): string {
  return rewardSafeTransactionHash({
    chainId: 8453,
    safeAddress: SAFE,
    nonce,
    to: call.to,
    data: call.data,
    operation: 0,
    safeTxGas: 80_000n,
  });
}

type Execution = Readonly<{
  hash: string;
  blockNumber: bigint;
  logIndex: number;
  input: Hex;
  safeTransactionHash: string;
  to?: string;
  outcome?: "success" | "failure";
}>;

function scenario(executions: readonly Execution[], parentNonce = 41n) {
  const nonceReads: bigint[] = [];
  const transactions = new Map<string, MegapotV2Transaction>(
    executions.map((execution) => [
      execution.hash,
      {
        transactionHash: execution.hash,
        chainId: 8453,
        from: OWNER,
        to: execution.to ?? SAFE,
        nonce: 1n,
        valueWei: 0n,
        input: execution.input,
        blockNumber: execution.blockNumber,
      },
    ]),
  );
  const logs: MegapotV2SafeExecutionLog[] = executions.map((execution) => ({
    transactionHash: execution.hash,
    blockNumber: execution.blockNumber,
    blockHash: BLOCK_HASH,
    logIndex: execution.logIndex,
    safeTransactionHash: execution.safeTransactionHash,
    outcome: execution.outcome ?? "success",
  }));
  return {
    nonceReads,
    run: (
      calls: readonly (RewardSafeCall & Readonly<{ notBeforeBlock?: bigint }>)[],
      overrides: Partial<{ logs: typeof logs }> = {},
    ) =>
      findRewardSafeExecutions({
        chainId: 8453,
        safeAddress: SAFE,
        calls,
        logs: overrides.logs ?? logs,
        readTransaction: async (hash) => transactions.get(hash) ?? null,
        readSafeNonce: async (_safe, blockNumber) => {
          nonceReads.push(blockNumber);
          return parentNonce;
        },
      }),
  };
}

const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("binds a later execution in a block to the nonce after earlier executions", async () => {
  const { run, nonceReads } = scenario([
    {
      hash: tx(2),
      blockNumber: 100n,
      logIndex: 9,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 42n),
    },
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 4,
      input: envelope(unrelated),
      safeTransactionHash: safeHash(unrelated, 41n),
    },
  ]);
  const findings = await run([payoutA, payoutB]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    kind: "matched",
    call: payoutA,
    executor: OWNER,
    safeNonce: 42n,
    command: { nonce: 42n, safeTxGas: 80_000n, to: USDC, data: payoutA.data },
  });
  expect(nonceReads).toEqual([99n]);
});

test("reads the parent nonce once per block and keeps blocks independent", async () => {
  const { run, nonceReads } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 41n),
    },
    {
      hash: tx(2),
      blockNumber: 101n,
      logIndex: 1,
      input: envelope(payoutB),
      safeTransactionHash: safeHash(payoutB, 41n),
    },
  ]);
  const findings = await run([payoutA, payoutB]);
  expect(findings.map((finding) => finding.kind)).toEqual(["matched", "matched"]);
  expect(nonceReads).toEqual([100n - 1n, 101n - 1n]);
});

test("reports a changed-parameter execution and a hash mismatch instead of accepting them", async () => {
  const { run } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA, 1n),
      safeTransactionHash: safeHash(payoutA, 41n),
    },
    {
      hash: tx(2),
      blockNumber: 100n,
      logIndex: 2,
      input: envelope(payoutB),
      safeTransactionHash: safeHash(payoutB, 41n),
    },
  ]);
  const findings = await run([payoutA, payoutB]);
  expect(
    findings.map((finding) => [finding.kind, "safeNonce" in finding ? finding.safeNonce : null]),
  ).toEqual([
    ["nonconforming", 41n],
    ["hash_mismatch", 42n],
  ]);
});

test("an execution through another contract might be Pirate's and is never dropped", async () => {
  const { run } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 41n),
      to: OWNER,
    },
    {
      hash: tx(2),
      blockNumber: 100n,
      logIndex: 2,
      input: "0x12345678",
      safeTransactionHash: safeHash(payoutB, 42n),
    },
  ]);
  const findings = await run([payoutA]);
  expect(findings.map((finding) => finding.kind)).toEqual(["undecodable", "undecodable"]);
});

test("records an inner failure as matched evidence for the reconciler to classify", async () => {
  const { run } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 41n),
      outcome: "failure",
    },
  ]);
  const [finding] = await run([payoutA]);
  expect(finding).toMatchObject({ kind: "matched", log: { outcome: "failure" } });
});

test("refuses missing transactions, duplicate log positions and conflicting block hashes", async () => {
  const { run } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 41n),
    },
  ]);
  const log: MegapotV2SafeExecutionLog = {
    transactionHash: tx(1),
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    logIndex: 1,
    safeTransactionHash: safeHash(payoutA, 41n),
    outcome: "success",
  };
  await expect(run([payoutA], { logs: [{ ...log, transactionHash: tx(9) }] })).rejects.toThrow();
  await expect(run([payoutA], { logs: [log, log] })).rejects.toThrow();
  await expect(
    run([payoutA], { logs: [log, { ...log, logIndex: 2, blockHash: `0x${"cc".repeat(32)}` }] }),
  ).rejects.toThrow();
  await expect(run([payoutA], { logs: [{ ...log, blockNumber: 101n }] })).rejects.toThrow();
});

test("an execution before a call was prepared is never bound to it", async () => {
  const { run } = scenario([
    {
      hash: tx(1),
      blockNumber: 100n,
      logIndex: 1,
      input: envelope(payoutA),
      safeTransactionHash: safeHash(payoutA, 41n),
    },
  ]);
  expect(await run([{ ...payoutA, notBeforeBlock: 101n }])).toEqual([]);
  expect((await run([{ ...payoutA, notBeforeBlock: 100n }]))[0]?.kind).toBe("matched");
});
