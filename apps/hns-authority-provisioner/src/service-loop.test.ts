import { describe, expect, test } from "bun:test";
import {
  HNS_EXECUTOR_CLASSES_V1,
  type HnsExecutorClassV1,
  type HnsExecutorRunnersV1,
  hnsExecutorRoundOrderV1,
  runHnsExecutorRoundV1,
} from "./service-loop.ts";

function countingRunners(
  log: HnsExecutorClassV1[],
  claimed: Readonly<Record<HnsExecutorClassV1, boolean>>,
): HnsExecutorRunnersV1 {
  const runner = (executorClass: HnsExecutorClassV1) => async () => {
    log.push(executorClass);
    return {
      claimed: claimed[executorClass],
      outcome: claimed[executorClass] ? "completed" : "idle",
    };
  };
  return {
    lifecycle: runner("lifecycle"),
    provisioning: runner("provisioning"),
    observation: runner("observation"),
  };
}

describe("fair turns across the provisioner's job classes", () => {
  test("every class takes a turn in a round, and the starting class rotates", () => {
    expect(hnsExecutorRoundOrderV1(0)).toEqual(["lifecycle", "provisioning", "observation"]);
    expect(hnsExecutorRoundOrderV1(1)).toEqual(["provisioning", "observation", "lifecycle"]);
    expect(hnsExecutorRoundOrderV1(2)).toEqual(["observation", "lifecycle", "provisioning"]);
    expect(hnsExecutorRoundOrderV1(3)).toEqual(hnsExecutorRoundOrderV1(0));
    for (const cursor of [0, 1, 2, 3, 17, 100]) {
      expect([...hnsExecutorRoundOrderV1(cursor)].sort()).toEqual(
        [...HNS_EXECUTOR_CLASSES_V1].sort(),
      );
    }
  });

  test("a saturated class cannot starve the others: each is offered one turn per round", async () => {
    const log: HnsExecutorClassV1[] = [];
    const runners = countingRunners(log, {
      lifecycle: true,
      provisioning: true,
      observation: true,
    });
    let cursor = 0;
    for (let round = 0; round < 9; round += 1) {
      cursor = (await runHnsExecutorRoundV1(cursor, runners)).next_cursor;
    }
    const turns = (executorClass: HnsExecutorClassV1) =>
      log.filter((entry) => entry === executorClass).length;
    expect(turns("lifecycle")).toBe(9);
    expect(turns("provisioning")).toBe(9);
    expect(turns("observation")).toBe(9);
    // Each class led three of the nine rounds.
    const leaders = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((index) => log[index]);
    expect(leaders.filter((entry) => entry === "lifecycle")).toHaveLength(3);
    expect(leaders.filter((entry) => entry === "provisioning")).toHaveLength(3);
    expect(leaders.filter((entry) => entry === "observation")).toHaveLength(3);
  });

  test("a round is idle only when no class claimed anything", async () => {
    const log: HnsExecutorClassV1[] = [];
    const idle = await runHnsExecutorRoundV1(
      0,
      countingRunners(log, { lifecycle: false, provisioning: false, observation: false }),
    );
    expect(idle.idle).toBe(true);
    const busy = await runHnsExecutorRoundV1(
      0,
      countingRunners(log, { lifecycle: true, provisioning: false, observation: false }),
    );
    expect(busy.idle).toBe(false);
  });

  test("one class throwing does not cancel the round or lose the other classes' turns", async () => {
    const log: HnsExecutorClassV1[] = [];
    const runners: HnsExecutorRunnersV1 = {
      ...countingRunners(log, { lifecycle: true, provisioning: true, observation: true }),
      provisioning: () => Promise.reject(new Error("provider unreachable")),
    };
    const round = await runHnsExecutorRoundV1(0, runners);
    expect(log).toEqual(["lifecycle", "observation"]);
    const provisioning = round.turns.find((turn) => turn.executor_class === "provisioning");
    expect(provisioning?.result).toEqual({
      claimed: false,
      outcome: "error",
      detail: "provider unreachable",
    });
    // A class that failed did not claim, but the round is not idle: the other
    // classes did real work and the loop must not sleep on their behalf.
    expect(round.idle).toBe(false);
  });
});
