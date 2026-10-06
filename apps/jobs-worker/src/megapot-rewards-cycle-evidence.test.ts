import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { writeMegapotRewardsCycleSnapshot } from "./megapot-rewards-cycle.ts";

// The runner's scripts are plain modules outside this project's type check, so
// they are loaded by location and described here.
const runner = (name: string) =>
  import(new URL(`../../../scripts/rewards-e2e/${name}`, import.meta.url).href);
const { cycleEvents } = (await runner("cycle-evidence.mjs")) as {
  cycleEvents: (envelope: unknown) => readonly unknown[];
};
const { isolatedEnvironment } = (await runner("worker-plan.mjs")) as {
  isolatedEnvironment: string;
};

// The isolated runner reads the jobs Worker's cycle summary out of its log tail.
// This holds the producer and that reader together: the real writer, under the
// environment the tracked isolated configuration deploys, must be read back.
test("the cycle summary the isolated jobs Worker writes is the one the runner reads", () => {
  const configuration = readFileSync(
    new URL("../../../tests/rewards-e2e/jobs.wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const environments = [...configuration.matchAll(/"API_NEXT_ENV":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(environments.length).toBeGreaterThan(0);
  expect(new Set(environments)).toEqual(new Set([isolatedEnvironment]));

  const envelopes: unknown[] = [];
  const written = writeMegapotRewardsCycleSnapshot(
    {
      reconciled: 2,
      fundingObserved: 3,
      fundingConfirmed: 1,
      fundingDeferred: 2,
      observed: 1,
      drawingObservationFailed: false,
      frozen: 0,
      committed: 0,
      purchased: 0,
      swept: 0,
      claimed: 0,
      allocated: 0,
      terminalOffers: 0,
      refunded: 0,
      paid: 0,
      gasTopups: 0,
      failures: ["RewardFundingCoordinatorFailed"],
      failureDiagnostics: [],
      agedPending: [],
    },
    {
      environment: environments[0] ?? "",
      emittedAt: "2026-10-06T12:01:03.000Z",
      durationMs: 2_500,
      workerVersion: { id: "jobs-version", tag: "", timestamp: "2026-10-06T11:00:00.000Z" },
    },
    // The Worker logs the event name and the fields object; the log tail delivers
    // them as one message array with the object serialized.
    (event, fields) =>
      envelopes.push({ logs: [{ message: [event, JSON.parse(JSON.stringify(fields))] }] }),
  );
  expect(written).toBe(true);
  expect(envelopes).toHaveLength(1);
  expect(cycleEvents(envelopes[0])).toEqual([
    {
      event: "megapot.rewards.cycle",
      versionId: "jobs-version",
      emittedAt: "2026-10-06T12:01:03.000Z",
      durationMs: 2_500,
      fundingObserved: 3,
      fundingConfirmed: 1,
      fundingDeferred: 2,
      fundingStep: "ran",
      failureTags: ["RewardFundingCoordinatorFailed"],
    },
  ]);
});

test("a summary written under any other environment is refused by the runner", () => {
  const envelopes: unknown[] = [];
  writeMegapotRewardsCycleSnapshot(
    {
      reconciled: 0,
      observed: 0,
      drawingObservationFailed: false,
      frozen: 0,
      committed: 0,
      purchased: 0,
      swept: 0,
      claimed: 0,
      allocated: 0,
      terminalOffers: 0,
      refunded: 0,
      paid: 0,
      gasTopups: 0,
      failures: [],
      failureDiagnostics: [],
      agedPending: [],
    },
    {
      environment: "staging",
      emittedAt: "2026-10-06T12:01:03.000Z",
      durationMs: 1,
      workerVersion: { id: "jobs-version", tag: "", timestamp: "" },
    },
    (event, fields) =>
      envelopes.push({ logs: [{ message: [event, JSON.parse(JSON.stringify(fields))] }] }),
  );
  expect(() => cycleEvents(envelopes[0])).toThrow("Invalid isolated cycle summary");
});
