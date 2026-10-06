import { expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { type MegapotRewardsRuntime, runMegapotRewardsCycle } from "./megapot-rewards-cycle.ts";

// The real database adapter over a driver whose statements can be slow. The
// adapter finishes a transaction's setup and its commit or rollback before it
// yields to an interrupt, so the funding deadline holds only because the funding
// session's statement limit bounds that tail. These tests measure it.
const statementTimeoutMs = 100;
const deadlines = {
  budgetMs: 40,
  latestStartMs: 40,
  hardStopMs: 80,
  // Four setup statements and one rollback, as in the production constants.
  reportByMs: 80 + 5 * statementTimeoutMs + 100,
};
const driverDelayMs = 2_000;

function slowDriver(slow: (text: string) => boolean) {
  const statements: string[] = [];
  const clientFactory: PostgresClientFactory = () => ({
    connection: { stream: { destroy: () => undefined } },
    connect: async () => undefined,
    end: async () => undefined,
    query: async ({ text }) => {
      statements.push(text);
      if (slow(text)) await new Promise((resolve) => setTimeout(resolve, driverDelayMs));
      return { rows: [], rowCount: 0 };
    },
  });
  return { statements, clientFactory };
}

const idle = () => Effect.succeed({ kind: "complete" });

async function runWith(driver: ReturnType<typeof slowDriver>) {
  const layer = makeDirectPostgresControlPlaneLayer("postgres://funding.invalid/fixture", {
    clientFactory: driver.clientFactory,
    statementTimeoutMs,
    connectTimeoutMs: statementTimeoutMs,
    logger: { info: () => undefined, error: () => undefined },
  });
  const calls: string[] = [];
  const runtime: MegapotRewardsRuntime = {
    reconcile: idle,
    reconcileFunding: () =>
      Effect.provide(layer)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            transaction.execute({
              label: "fixture.funding.confirm",
              text: "UPDATE fixture SET confirmed=true",
              values: [],
              readonly: false,
            }),
          );
          return { kind: "confirmed" };
        }),
      ),
    observeDrawing: () => Effect.succeed(false),
    observeSolvency: idle,
    freezeDue: () => Effect.succeed([]),
    publishCommitment: idle,
    approve: idle,
    closeUnavailablePurchase: idle,
    purchase: idle,
    sweep: idle,
    claim: idle,
    allocate: idle,
    closeExpiredOffers: () => Effect.sync(() => calls.push("close-expired")).pipe(Effect.as([])),
    refund: idle,
    payout: idle,
  };
  const startedAt = Date.now();
  const summary = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: {
        loadChainEffects: () => Effect.succeed([]),
        loadDrawings: () => Effect.succeed([]),
        loadRefunds: () => Effect.succeed([]),
        loadCredits: () => Effect.succeed([]),
        loadPendingFunding: () => Effect.succeed(["funding-1", "funding-2"]),
        loadAgedPending: () =>
          Effect.sync(() => calls.push("load-aged-pending")).pipe(Effect.as([])),
      },
      runtime,
      fundingDeadlines: deadlines,
    }),
  );
  return { summary, calls, elapsedMs: Date.now() - startedAt };
}

test("a fast transaction confirms and nothing is cut off", async () => {
  const driver = slowDriver(() => false);
  const { summary, calls } = await runWith(driver);
  expect(summary).toMatchObject({ fundingObserved: 2, fundingConfirmed: 2, failures: [] });
  expect(driver.statements.filter((text) => text === "COMMIT")).toHaveLength(2);
  expect(calls.at(-1)).toBe("load-aged-pending");
});

test("a transaction whose setup stalls ends within the counted tail and the cycle reports", async () => {
  const driver = slowDriver((text) => text === "BEGIN");
  const { summary, calls, elapsedMs } = await runWith(driver);
  // Far sooner than the driver's delay, and inside hard stop plus the counted tail.
  expect(elapsedMs).toBeLessThan(deadlines.reportByMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  expect(driver.statements).not.toContain("UPDATE fixture SET confirmed=true");
  expect(driver.statements).not.toContain("COMMIT");
  expect(summary.failures.length).toBeGreaterThan(0);
  expect(summary).not.toHaveProperty("fundingConfirmed");
  expect(calls).toEqual(["close-expired", "load-aged-pending"]);
  expect(summary.agedPending).toEqual([]);
});

test("a commit that stalls is reported as a failure within the counted tail, never as confirmed", async () => {
  const driver = slowDriver((text) => text === "COMMIT");
  const { summary, calls, elapsedMs } = await runWith(driver);
  expect(elapsedMs).toBeLessThan(deadlines.reportByMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  expect(driver.statements).toContain("COMMIT");
  // The outcome of that commit is unknown; it must not be counted as a confirmation.
  expect(summary.failures.length).toBeGreaterThan(0);
  expect(summary).not.toHaveProperty("fundingConfirmed");
  expect(calls.at(-1)).toBe("load-aged-pending");
  expect(summary.agedPending).toEqual([]);
});
