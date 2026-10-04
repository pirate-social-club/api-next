import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveSpending } from "./spending-ledger.mjs";

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
