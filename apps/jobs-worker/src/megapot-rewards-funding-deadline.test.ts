import { expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { MegapotWorkStorageFailed } from "@pirate/platform-cf/megapot-work-repository";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { type MegapotRewardsRuntime, runMegapotRewardsCycle } from "./megapot-rewards-cycle.ts";

// The real database adapter over a driver whose statements and close can be
// slow. The adapter finishes a transaction's setup, its commit or rollback and
// the connection's close before it yields to an interrupt, so the deadlines hold
// only because the bounded session limits each of those. These tests measure it.
const statementTimeoutMs = 100;
const closeTimeoutMs = 100;
// Four setup statements, one rollback and one close, as in the production constants.
const tailMs = 5 * statementTimeoutMs + closeTimeoutMs;
const deadlines = {
  budgetMs: 40,
  latestStartMs: 40,
  hardStopMs: 80,
  reportByMs: 80 + tailMs + 100,
};
const driverDelayMs = 2_000;
// Timer and scheduling slack on a loaded machine; far below the driver's delay.
const slackMs = 250;

function slowDriver(slow: (text: string) => boolean, slowEnd = false) {
  const statements: string[] = [];
  const clientFactory: PostgresClientFactory = () => ({
    connection: { stream: { destroy: () => undefined } },
    connect: async () => undefined,
    end: async () => {
      statements.push("<end>");
      if (slowEnd) await new Promise((resolve) => setTimeout(resolve, driverDelayMs));
    },
    query: async ({ text }) => {
      statements.push(text);
      if (slow(text)) await new Promise((resolve) => setTimeout(resolve, driverDelayMs));
      return { rows: [], rowCount: 0 };
    },
  });
  return { statements, clientFactory };
}

const idle = () => Effect.succeed({ kind: "complete" });

async function runWith(
  driver: ReturnType<typeof slowDriver>,
  options: { readonly livenessOnSession?: boolean; readonly pending?: readonly string[] } = {},
) {
  const layer = makeDirectPostgresControlPlaneLayer("postgres://funding.invalid/fixture", {
    clientFactory: driver.clientFactory,
    statementTimeoutMs,
    connectTimeoutMs: statementTimeoutMs,
    closeTimeoutMs,
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
        loadPendingFunding: () => Effect.succeed(options.pending ?? ["funding-1", "funding-2"]),
        loadAgedPending: () =>
          Effect.sync(() => calls.push("load-aged-pending")).pipe(
            Effect.andThen(
              options.livenessOnSession !== true
                ? Effect.succeed([])
                : // Under Hyperdrive every read is a transaction on the bounded session.
                  Effect.provide(layer)(
                    Effect.gen(function* () {
                      const db = yield* ControlPlaneDb;
                      yield* db.withTransaction((transaction) =>
                        transaction.execute({
                          label: "fixture.liveness.read",
                          text: "SELECT liveness",
                          values: [],
                          readonly: true,
                        }),
                      );
                      return [];
                    }),
                  ).pipe(
                    Effect.mapError(() => new MegapotWorkStorageFailed({ reason: "unavailable" })),
                  ),
            ),
          ),
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
  expect(elapsedMs).toBeLessThan(deadlines.hardStopMs + tailMs + slackMs);
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
  expect(elapsedMs).toBeLessThan(deadlines.hardStopMs + tailMs + slackMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  expect(driver.statements).toContain("COMMIT");
  // The outcome of that commit is unknown; it must not be counted as a confirmation.
  expect(summary.failures.length).toBeGreaterThan(0);
  expect(summary).not.toHaveProperty("fundingConfirmed");
  expect(calls.at(-1)).toBe("load-aged-pending");
  expect(summary.agedPending).toEqual([]);
});

test("a connection that does not answer its close is fenced within the counted tail", async () => {
  const driver = slowDriver(() => false, true);
  const { summary, calls, elapsedMs } = await runWith(driver, { pending: ["funding-1"] });
  // One observation, one unanswered close: the close bound, not the driver, ends it.
  expect(driver.statements.filter((text) => text === "<end>")).toHaveLength(1);
  expect(elapsedMs).toBeLessThan(deadlines.hardStopMs + tailMs + slackMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  // The transaction had already committed when the close stalled. The hard stop
  // falls inside the close bound here, so the cycle may report the observation as
  // cut off; either way it is one observation and never a second commit.
  expect(summary.fundingObserved).toBe(1);
  expect(driver.statements.filter((text) => text === "COMMIT")).toHaveLength(1);
  expect(summary.failures.every((tag) => tag === "MegapotRewardsFundingDeadlineExceeded")).toBe(
    true,
  );
  expect(calls.at(-1)).toBe("load-aged-pending");
});

test("a liveness read whose commit stalls ends within its own counted tail", async () => {
  const driver = slowDriver((text) => text === "COMMIT");
  const { summary, elapsedMs } = await runWith(driver, { livenessOnSession: true, pending: [] });
  expect(driver.statements).toContain("SELECT liveness");
  expect(elapsedMs).toBeLessThan(deadlines.reportByMs + tailMs + slackMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  expect(summary.agedPending).toBeNull();
});

test("a liveness read whose connection does not answer its close ends within its counted tail", async () => {
  const driver = slowDriver(() => false, true);
  const { summary, elapsedMs } = await runWith(driver, { livenessOnSession: true, pending: [] });
  expect(driver.statements).toContain("SELECT liveness");
  expect(elapsedMs).toBeLessThan(deadlines.reportByMs + tailMs + slackMs);
  expect(elapsedMs).toBeLessThan(driverDelayMs);
  // The read itself completed before the close stalled.
  expect(summary.agedPending).toEqual([]);
});
