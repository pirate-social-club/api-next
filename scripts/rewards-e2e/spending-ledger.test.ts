import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPairBudget,
  feeCeilings,
  pairBudget,
  readSpendingTotals,
  recoveryHeadroom,
  reserveSpending,
  spendingLimits,
} from "./spending-ledger.mjs";

const reservation = {
  authoritySha256: "a".repeat(64),
  chainId: 84532,
  runId: "win-1",
  actionId: "offer-funding",
  kind: "principal",
  usdcAtomic: "1000000",
  ethWei: "1000",
};

async function withLedger(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "rewards-spending-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a failed or uncertain send remains consumed after reopening the ledger", () =>
  withLedger(async (directory) => {
    await reserveSpending(directory, reservation);
    await expect(reserveSpending(directory, reservation)).rejects.toThrow("do not replay");
    expect(await readdir(directory)).toEqual(["win-1--offer-funding.json"]);
  }));

test("splitting funding across actions cannot exceed a run's principal cap", () =>
  withLedger(async (directory) => {
    await reserveSpending(directory, reservation);
    await expect(
      reserveSpending(directory, { ...reservation, actionId: "second-funding", usdcAtomic: "1" }),
    ).rejects.toThrow("Per-run principal");
    expect((await readdir(directory)).length).toBe(1);
  }));

test("new runs cannot reset the aggregate budget", () =>
  withLedger(async (directory) => {
    for (let index = 0; index < 10; index++) {
      await reserveSpending(directory, { ...reservation, runId: `run-${index}` });
    }
    await expect(reserveSpending(directory, { ...reservation, runId: "run-10" })).rejects.toThrow(
      "Aggregate",
    );
  }));

test("ETH top-ups and fee reservations share the same aggregate ceiling", () =>
  withLedger(async (directory) => {
    await reserveSpending(directory, {
      ...reservation,
      kind: "gas",
      usdcAtomic: "0",
      ethWei: "50000000000000000",
    });
    await expect(
      reserveSpending(directory, { ...reservation, runId: "loss-1", ethWei: "1" }),
    ).rejects.toThrow("Aggregate");
  }));

test("changing the authority hash cannot replenish spending", () =>
  withLedger(async (directory) => {
    await reserveSpending(directory, reservation);
    await expect(
      reserveSpending(directory, {
        ...reservation,
        runId: "loss-1",
        authoritySha256: "b".repeat(64),
      }),
    ).rejects.toThrow("authority changed");
  }));

test("concurrent commands cannot reserve the same action twice", () =>
  withLedger(async (directory) => {
    const results = await Promise.allSettled([
      reserveSpending(directory, reservation),
      reserveSpending(directory, reservation),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["win-1--offer-funding.json"]);
  }));

test.each([1, 8453])("chain %s refuses before any reservation is written", (chainId) =>
  withLedger(async (directory) => {
    await expect(reserveSpending(directory, { ...reservation, chainId })).rejects.toThrow(
      "Invalid",
    );
    expect(await readdir(directory)).toEqual([]);
  }),
);

test("corrupt ledger records refuse new spending", () =>
  withLedger(async (directory) => {
    await writeFile(join(directory, "uncertain.json"), "{partial");
    await expect(reserveSpending(directory, reservation)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["uncertain.json"]);
  }));

const authority = { authoritySha256: "a".repeat(64), managedFloatWei: 0n };
const usdc = (amount: number) => (BigInt(amount) * 1_000_000n).toString();
async function reserveMany(directory: string, usdcEach: readonly number[], ethWei = "1000") {
  for (const [index, amount] of usdcEach.entries())
    await reserveSpending(directory, {
      ...reservation,
      runId: `earlier-${index}`,
      actionId: "fund-fixture-prize",
      kind: "prize",
      usdcAtomic: usdc(amount),
      ethWei,
    });
}
const reserveFloat = (directory: string, ethWei: string) =>
  reserveSpending(directory, {
    ...reservation,
    runId: "managed-float",
    actionId: "worker-gas-float",
    kind: "gas",
    usdcAtomic: "0",
    ethWei,
  });

test("the pair's ETH figure is every permitted action at its enforced ceiling", () => {
  // 2 scenarios x 8 fixture transactions x 0.0001, 2 fundings x 0.0005, 2 sends x 0.0002.
  expect(pairBudget.ethWei).toBe(3_000_000_000_000_000n);
  expect(pairBudget.ethWei).toBe(
    16n * feeCeilings.fixtureTransactionWei +
      2n * feeCeilings.fundingWei +
      2n * feeCeilings.winnerSendWei,
  );
});

test("a pair admitted by the check can run every action at its ceiling and keep its headroom", () =>
  withLedger(async (directory) => {
    // The fullest ledger the check still admits: 5 USDC, and ETH up to the limit
    // less the pair and its headroom.
    const admittedEth = spendingLimits.ethWei - pairBudget.ethWei - recoveryHeadroom.ethWei - 2n;
    await reserveMany(directory, [3, 2], "1");
    await reserveFloat(directory, admittedEth.toString());
    await assertPairBudget(directory, { ...authority, fixturePrizeAtomic: 1_000_000n });
    for (const scenario of ["win", "loss"]) {
      for (const action of [
        "reschedule-stale-drawing",
        "settle-stale-drawing",
        "arm-placeholder",
        "settle-placeholder",
        "arm-drawing",
        "advance-purchased-drawing",
        "recover-advance-purchased-drawing",
      ])
        await reserveSpending(directory, {
          ...reservation,
          runId: `${scenario}-max`,
          actionId: action,
          kind: "gas",
          usdcAtomic: "0",
          ethWei: feeCeilings.fixtureTransactionWei.toString(),
        });
      // The loss refills the prize the win paid out; the win finds it funded.
      await reserveSpending(directory, {
        ...reservation,
        runId: `${scenario}-max`,
        actionId: "fund-fixture-prize",
        kind: "prize",
        usdcAtomic: scenario === "loss" ? "1000000" : "0",
        ethWei: feeCeilings.fixtureTransactionWei.toString(),
      });
      await reserveSpending(directory, {
        ...reservation,
        runId: `${scenario}-max`,
        actionId: "fund-offer",
        kind: "principal",
        usdcAtomic: "1000000",
        ethWei: feeCeilings.fundingWei.toString(),
      });
    }
    for (const role of ["study", "karaoke"])
      await reserveSpending(directory, {
        ...reservation,
        runId: "win-max",
        actionId: `send-${role}`,
        kind: "send",
        usdcAtomic: "500000",
        ethWei: feeCeilings.winnerSendWei.toString(),
      });
    const totals = await readSpendingTotals(directory, authority.authoritySha256);
    // Everything fitted, and exactly the recovery headroom is still free.
    expect(spendingLimits.usdcAtomic - totals.usdcAtomic).toBe(recoveryHeadroom.usdcAtomic);
    expect(spendingLimits.ethWei - totals.ethWei).toBe(recoveryHeadroom.ethWei);
    // One more recovery-sized funded step still fits; a further one does not.
    await reserveSpending(directory, {
      ...reservation,
      runId: "recovery",
      actionId: "fund-offer",
      kind: "principal",
      usdcAtomic: "1000000",
      ethWei: feeCeilings.fundingWei.toString(),
    });
    await expect(
      reserveSpending(directory, {
        ...reservation,
        runId: "recovery-two",
        actionId: "fund-offer",
        kind: "principal",
        usdcAtomic: "1000000",
        ethWei: "1",
      }),
    ).rejects.toThrow("Aggregate isolated spending limit exceeded");
  }));

test("a float that has not been reserved yet counts toward the pair", () =>
  withLedger(async (directory) => {
    const unreserved = spendingLimits.ethWei - pairBudget.ethWei - recoveryHeadroom.ethWei;
    // Exactly fits when nothing else is reserved, and is refused one wei over.
    const report = await assertPairBudget(directory, {
      ...authority,
      fixturePrizeAtomic: 1_000_000n,
      managedFloatWei: unreserved,
    });
    expect(report.unreservedManagedFloatWei).toBe(unreserved.toString());
    await expect(
      assertPairBudget(directory, {
        ...authority,
        fixturePrizeAtomic: 1_000_000n,
        managedFloatWei: unreserved + 1n,
      }),
    ).rejects.toThrow("ETH allowance");
    // Once reserved, the wallets' balance is not counted a second time.
    await reserveFloat(directory, unreserved.toString());
    const after = await assertPairBudget(directory, {
      ...authority,
      fixturePrizeAtomic: 1_000_000n,
      managedFloatWei: unreserved,
    });
    expect(after.unreservedManagedFloatWei).toBe("0");
  }));

test("the pair budget fits when a pair and its recovery headroom are free", () =>
  withLedger(async (directory) => {
    await reserveMany(directory, [3]);
    const report = await assertPairBudget(directory, {
      ...authority,
      fixturePrizeAtomic: 1_000_000n,
    });
    // Three reserved, four for the pair, one of headroom: eight of ten.
    expect(report).toMatchObject({
      reservedUsdcAtomic: "3000000",
      pairUsdcAtomic: "4000000",
      headroomUsdcAtomic: "1000000",
      limitUsdcAtomic: "10000000",
    });
    // The check itself reserves nothing.
    expect((await readSpendingTotals(directory, authority.authoritySha256)).entries).toBe(1);
  }));

test("a pair that fits only without recovery headroom is refused", () =>
  withLedger(async (directory) => {
    await reserveMany(directory, [3, 3]);
    await expect(
      assertPairBudget(directory, { ...authority, fixturePrizeAtomic: 1_000_000n }),
    ).rejects.toThrow("USDC allowance cannot cover a pair and recovery");
  }));

test("an unfunded fixture prize adds one refill to the pair", () =>
  withLedger(async (directory) => {
    await reserveMany(directory, [3, 2]);
    // Five reserved: a pair with a funded prize fits exactly, with an empty one it does not.
    const funded = await assertPairBudget(directory, {
      ...authority,
      fixturePrizeAtomic: 1_000_000n,
    });
    expect(funded.pairUsdcAtomic).toBe("4000000");
    await expect(
      assertPairBudget(directory, { ...authority, fixturePrizeAtomic: 999_999n }),
    ).rejects.toThrow("USDC allowance");
  }));

test("the ETH allowance is checked as well as the USDC allowance", () =>
  withLedger(async (directory) => {
    // 0.046 ETH reserved leaves less than the pair and its headroom need.
    await reserveMany(directory, [1], "46000000000000000");
    await expect(
      assertPairBudget(directory, { ...authority, fixturePrizeAtomic: 1_000_000n }),
    ).rejects.toThrow("ETH allowance cannot cover a pair and recovery");
  }));

test("an empty ledger, another authority and a leftover lock are each handled", () =>
  withLedger(async (directory) => {
    await expect(
      assertPairBudget(join(directory, "absent"), {
        ...authority,
        fixturePrizeAtomic: 1_000_000n,
      }),
    ).resolves.toMatchObject({ reservedUsdcAtomic: "0" });
    await reserveMany(directory, [1]);
    await expect(
      assertPairBudget(directory, {
        authoritySha256: "b".repeat(64),
        fixturePrizeAtomic: 1_000_000n,
        managedFloatWei: 0n,
      }),
    ).rejects.toThrow("authority changed");
    await mkdir(join(directory, ".reservation-lock"));
    await expect(
      assertPairBudget(directory, { ...authority, fixturePrizeAtomic: 1_000_000n }),
    ).rejects.toThrow("locked");
    await expect(
      assertPairBudget(directory, { ...authority, fixturePrizeAtomic: undefined as never }),
    ).rejects.toThrow("prize balance required");
    await expect(
      assertPairBudget(directory, {
        ...authority,
        fixturePrizeAtomic: 1_000_000n,
        managedFloatWei: undefined as never,
      }),
    ).rejects.toThrow("float balance required");
  }));
