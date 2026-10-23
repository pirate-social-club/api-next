import { expect, test } from "bun:test";
import { encodeFunctionData, type Hex, parseAbi } from "viem";
import {
  assertRewardSafeCallUnique,
  decodeRewardSafeExecutedCall,
  matchRewardSafeCall,
  type RewardSafeCall,
  rewardSafeCall,
  rewardSafeCommandFromExecution,
  rewardSafeTransactionBuilderFile,
} from "./reward-safe-command.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = "0x1111111111111111111111111111111111111111";
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const transfer = (recipient: string, amount: bigint): Hex =>
  encodeFunctionData({ abi, functionName: "transfer", args: [recipient as Hex, amount] });
const payout = rewardSafeCall({
  effectId: "payout-1",
  to: USDC,
  data: transfer(WALLET, 1_110_000n),
});

function executed(
  call: RewardSafeCall,
  overrides: Partial<{
    value: bigint;
    operation: number;
    safeTxGas: bigint;
    gasPrice: bigint;
    refundReceiver: Hex;
  }> = {},
): Hex {
  return encodeFunctionData({
    abi,
    functionName: "execTransaction",
    args: [
      call.to,
      overrides.value ?? 0n,
      call.data,
      overrides.operation ?? 0,
      overrides.safeTxGas ?? 90_000n,
      0n,
      overrides.gasPrice ?? 0n,
      ZERO,
      overrides.refundReceiver ?? ZERO,
      "0x",
    ],
  });
}

test("normalizes a prepared call and refuses unusable ones", () => {
  expect(payout.to).toBe(USDC);
  expect(payout.data).toBe(transfer(WALLET, 1_110_000n).toLowerCase() as Hex);
  const invalid = [
    { effectId: "", to: USDC, data: payout.data },
    { effectId: " payout-1", to: USDC, data: payout.data },
    { effectId: "x".repeat(129), to: USDC, data: payout.data },
    { effectId: "payout-1", to: ZERO, data: payout.data },
    { effectId: "payout-1", to: "0x1234", data: payout.data },
    { effectId: "payout-1", to: USDC, data: "0x1234" },
    { effectId: "payout-1", to: USDC, data: `${payout.data}0` },
  ];
  for (const input of invalid) expect(() => rewardSafeCall(input)).toThrow();
});

test("refuses a second unresolved call with identical content", () => {
  const repeat = rewardSafeCall({ effectId: "payout-2", to: USDC, data: payout.data });
  expect(() => assertRewardSafeCallUnique([payout], repeat)).toThrow("duplicate-call");
  const changed = rewardSafeCall({ effectId: "payout-1", to: USDC, data: transfer(WALLET, 1n) });
  expect(() => assertRewardSafeCallUnique([payout], changed)).toThrow("duplicate-call");
  assertRewardSafeCallUnique([payout], payout);
  assertRewardSafeCallUnique(
    [payout],
    rewardSafeCall({ effectId: "payout-3", to: USDC, data: transfer(WALLET, 2n) }),
  );
});

test("matches an execution by content even when Safe chose its own gas limit", () => {
  const match = matchRewardSafeCall(
    [payout],
    decodeRewardSafeExecutedCall(executed(payout, { safeTxGas: 123_456n })),
  );
  expect(match).toEqual({ call: payout, conforming: true });
});

test("an execution of Pirate's call with changed Safe parameters is found, not accepted", () => {
  for (const overrides of [
    { value: 1n },
    { operation: 1 },
    { gasPrice: 1n },
    { refundReceiver: WALLET as Hex },
  ]) {
    const match = matchRewardSafeCall(
      [payout],
      decodeRewardSafeExecutedCall(executed(payout, overrides)),
    );
    expect(match).toEqual({ call: payout, conforming: false });
  }
});

test("unrelated executions match nothing and duplicate prepared calls are ambiguous", () => {
  const other = rewardSafeCall({ effectId: "other", to: USDC, data: transfer(WALLET, 5n) });
  expect(matchRewardSafeCall([payout], decodeRewardSafeExecutedCall(executed(other)))).toBe(null);
  const twin = { ...payout, effectId: "payout-2" };
  expect(() =>
    matchRewardSafeCall([payout, twin], decodeRewardSafeExecutedCall(executed(payout))),
  ).toThrow("ambiguous-match");
  expect(() => decodeRewardSafeExecutedCall("0x1234")).toThrow("invalid-execution");
});

test("rebuilds the signed Safe command from the nonce the execution consumed", () => {
  const command = rewardSafeCommandFromExecution({
    safeAddress: SAFE,
    nonce: 7n,
    call: payout,
    executed: decodeRewardSafeExecutedCall(executed(payout, { safeTxGas: 150_000n })),
  });
  expect(command).toEqual({
    chainId: 8453,
    safeAddress: SAFE,
    nonce: 7n,
    to: USDC,
    data: payout.data,
    operation: 0,
    safeTxGas: 150_000n,
  });
  expect(rewardSafeTransactionHash(command)).toMatch(/^0x[0-9a-f]{64}$/u);
  expect(() =>
    rewardSafeCommandFromExecution({
      safeAddress: SAFE,
      nonce: 7n,
      call: payout,
      executed: decodeRewardSafeExecutedCall(executed(payout, { gasPrice: 1n })),
    }),
  ).toThrow("invalid-execution");
});

test("writes a one-call Transaction Builder file with zero value", () => {
  expect(
    rewardSafeTransactionBuilderFile({
      safeAddress: SAFE.toLowerCase(),
      call: payout,
      name: "Pirate payout payout-1",
      description: "USDC payout for one accepted credit",
      createdAtMs: 1_792_723_368_000,
    }),
  ).toEqual({
    version: "1.0",
    chainId: "8453",
    createdAt: 1_792_723_368_000,
    meta: {
      name: "Pirate payout payout-1",
      description: "USDC payout for one accepted credit",
      createdFromSafeAddress: SAFE,
    },
    transactions: [
      {
        to: USDC,
        value: "0",
        data: payout.data,
        contractMethod: null,
        contractInputsValues: null,
      },
    ],
  });
});
