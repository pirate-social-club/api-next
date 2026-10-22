import { describe, expect, test } from "bun:test";
import {
  classifyRewardPrincipal,
  conservesRewardPrincipal,
  latePrincipalReturnAmount,
  mayReleaseExpiredCapacity,
  type PrincipalInstruction,
  poolRefundShares,
  type VerifiedNonceEvidence,
} from "./reward-principal-disposition.ts";

const instruction: PrincipalInstruction = {
  chainId: 84532,
  sender: "wallet_a",
  nonce: 7n,
  anchorBlock: 10n,
  expectedAmount: 2n,
  validFrom: 100,
  deadline: 200,
  fixedEnd: 300,
  invalidatedAt: [],
};
const payment = {
  kind: "transfer",
  chainId: 84532,
  sender: "wallet_a",
  nonce: 7n,
  block: 11n,
  includedAt: 199,
  finalized: true,
  exactInstruction: true,
  amount: 2n,
} as const;

describe("receipt-time principal classification", () => {
  test("late observation does not change a valid canonical inclusion", () => {
    expect(classifyRewardPrincipal(instruction, payment, false)).toEqual({
      kind: "pool_principal",
      amount: 2n,
    });
    expect(classifyRewardPrincipal(instruction, { ...payment, includedAt: 200 }, false)).toEqual({
      kind: "late_principal",
      amount: 2n,
    });
    expect(classifyRewardPrincipal(instruction, { ...payment, finalized: false }, false)).toEqual({
      kind: "unresolved",
      retainLiability: true,
    });
    expect(
      classifyRewardPrincipal(instruction, { ...payment, includedAt: 99 }, false),
    ).toMatchObject({ kind: "late_principal" });
    expect(
      classifyRewardPrincipal(instruction, { ...payment, includedAt: Number.NaN }, false),
    ).toMatchObject({ kind: "incident_hold" });
  });
  test("equal sender/amount effects at different nonces cannot exchange evidence", () => {
    expect(classifyRewardPrincipal({ ...instruction, nonce: 8n }, payment, false)).toMatchObject({
      kind: "unattributed_asset",
    });
    expect(
      classifyRewardPrincipal(instruction, { ...payment, chainId: 8453 }, false),
    ).toMatchObject({ kind: "unattributed_asset" });
    expect(classifyRewardPrincipal(instruction, { ...payment, block: 10n }, false)).toMatchObject({
      kind: "late_principal",
    });
  });
  test("pause/ban invalidation is permanent, while later exclusion is not retroactive", () => {
    expect(
      classifyRewardPrincipal({ ...instruction, invalidatedAt: [198, 250] }, payment, false),
    ).toMatchObject({ kind: "late_principal" });
    expect(
      classifyRewardPrincipal({ ...instruction, invalidatedAt: [201] }, payment, false),
    ).toMatchObject({ kind: "pool_principal" });
    expect(classifyRewardPrincipal(instruction, payment, true)).toMatchObject({
      kind: "incident_hold",
    });
  });
  test("wrong amount is actual late principal, never pool credit", () => {
    expect(classifyRewardPrincipal(instruction, { ...payment, amount: 3n }, false)).toEqual({
      kind: "late_principal",
      amount: 3n,
    });
  });
  test("unknown and no-hash outcomes remain liabilities; cancellation needs custody proof", () => {
    expect(classifyRewardPrincipal(instruction, { kind: "unknown" }, false)).toMatchObject({
      kind: "unresolved",
    });
    const cancel: VerifiedNonceEvidence = {
      kind: "no_principal",
      chainId: 84532,
      sender: "wallet_a",
      nonce: 7n,
      finalized: true,
      custodyScanComplete: false,
    };
    expect(classifyRewardPrincipal(instruction, cancel, false)).toMatchObject({
      kind: "unresolved",
    });
    expect(
      classifyRewardPrincipal(instruction, { ...cancel, custodyScanComplete: true }, false),
    ).toEqual({ kind: "no_principal" });
  });
  test("time alone cannot release capacity, checkpoint equality cannot close interval", () => {
    const closure = {
      effectiveDeadline: 200,
      finalizedCheckpointTime: 201,
      gapFreeCustodyScan: true,
      allPredeadlineReceiptsClassified: true,
    };
    expect(mayReleaseExpiredCapacity(closure)).toBe(true);
    expect(mayReleaseExpiredCapacity({ ...closure, finalizedCheckpointTime: 200 })).toBe(false);
    expect(mayReleaseExpiredCapacity({ ...closure, gapFreeCustodyScan: false })).toBe(false);
  });
});
describe("separate conserved principal buckets", () => {
  test("uint256 maximum aggregate and remaining preserve exact refund conservation", () => {
    const max = (1n << 256n) - 1n;
    const effects = [
      { effectId: "a", sender: "a", confirmedAmount: 1n << 255n },
      { effectId: "b", sender: "b", confirmedAmount: (1n << 255n) - 1n },
    ];
    for (const remaining of [0n, max - 1n, max]) {
      const shares = poolRefundShares(effects, remaining);
      expect(shares.reduce((sum, s) => sum + s.amount, 0n)).toBe(remaining);
      expect(shares.every((s) => s.amount >= 0n && s.amount <= max)).toBe(true);
      expect(
        conservesRewardPrincipal({
          poolReceived: max,
          ticketSpent: max - remaining,
          ticketReserved: 0n,
          poolRefundPaid: 0n,
          poolRefundOwed: remaining,
          poolFree: 0n,
          lateReceived: 0n,
          lateRefundPaid: 0n,
          lateRefundOwed: 0n,
        }),
      ).toBe(true);
    }
    expect(poolRefundShares([{ effectId: "a", sender: "a", confirmedAmount: max }], max)).toEqual([
      { effectId: "a", sender: "a", amount: max },
    ]);
  });
  test("aggregate overflow refuses even when every effect and remaining individually fit uint256", () => {
    const overflow = 1n << 256n;
    const effects = ["a", "b"].map((effectId) => ({
      effectId,
      sender: effectId,
      confirmedAmount: 1n << 255n,
    }));
    for (const remaining of [0n, 1n, overflow - 1n, overflow]) {
      expect(() => poolRefundShares(effects, remaining)).toThrow(RangeError);
    }
  });
  test("remaining overflow refuses for otherwise valid maximum principal", () => {
    const overflow = 1n << 256n;
    expect(() =>
      poolRefundShares([{ effectId: "a", sender: "a", confirmedAmount: overflow - 1n }], overflow),
    ).toThrow(RangeError);
    expect(
      conservesRewardPrincipal({
        poolReceived: overflow,
        ticketSpent: 0n,
        ticketReserved: 0n,
        poolRefundPaid: 0n,
        poolRefundOwed: overflow,
        poolFree: 0n,
        lateReceived: 0n,
        lateRefundPaid: 0n,
        lateRefundOwed: 0n,
      }),
    ).toBe(false);
  });
  test("A4, spend3, B2 refunds A2/B1 under existing shared cost rule", () => {
    expect(
      poolRefundShares(
        [
          { effectId: "a", sender: "a", confirmedAmount: 4n },
          { effectId: "b", sender: "b", confirmedAmount: 2n },
        ],
        3n,
      ),
    ).toEqual([
      { effectId: "a", sender: "a", amount: 2n },
      { effectId: "b", sender: "b", amount: 1n },
    ]);
  });
  test("largest remainder stable effect identity, repeated sender aggregated later", () => {
    const effects = ["c", "b", "a"].map((effectId) => ({
      effectId,
      sender: effectId === "b" ? "b" : "a",
      confirmedAmount: 1n,
    }));
    expect(poolRefundShares(effects, 2n)).toEqual([
      { effectId: "c", sender: "a", amount: 0n },
      { effectId: "b", sender: "b", amount: 1n },
      { effectId: "a", sender: "a", amount: 1n },
    ]);
    const first = effects[0];
    if (first === undefined) throw new Error("Missing effect fixture");
    expect(() => poolRefundShares([...effects, first], 1n)).toThrow();
  });
  test("conservation holds over all small sealed balances and duplicate receipts refuse", () => {
    for (let a = 1n; a < 8n; a++)
      for (let b = 1n; b < 8n; b++)
        for (let left = 0n; left <= a + b; left++) {
          const shares = poolRefundShares(
            [
              { effectId: "a", sender: "a", confirmedAmount: a },
              { effectId: "b", sender: "b", confirmedAmount: b },
            ],
            left,
          );
          expect(shares.reduce((n, s) => n + s.amount, 0n)).toBe(left);
          expect(shares.every((s) => s.amount >= 0n)).toBe(true);
        }
  });
  test("unknown outgoing remains owed; late money never enters pool denominator", () => {
    const b = {
      poolReceived: 6n,
      ticketSpent: 3n,
      ticketReserved: 0n,
      poolRefundPaid: 0n,
      poolRefundOwed: 3n,
      poolFree: 0n,
      lateReceived: 2n,
      lateRefundPaid: 0n,
      lateRefundOwed: 2n,
    };
    expect(conservesRewardPrincipal(b)).toBe(true);
    expect(conservesRewardPrincipal({ ...b, lateRefundOwed: 0n })).toBe(false);
    expect(latePrincipalReturnAmount(2n, null)).toBeNull();
    expect(latePrincipalReturnAmount(2n, "full_principal")).toBe(2n);
  });
});
