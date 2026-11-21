import { expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { runFairSafePoolRecovery } from "./fair-safe-pool-recovery.ts";

test("bounded Study progress precedes money, and long stages cannot starve either family", async () => {
  let next: "financial" | "funding" = "financial";
  const trace: string[] = [];
  // Recreate the scheduler each time; the durable turn is the only shared state.
  for (let tick = 0; tick < 6; tick++) {
    let now = tick * 60_000;
    const started = now;
    const work = (name: string) =>
      Effect.sync(() => {
        trace.push(name);
        now += 35_000;
      });
    const result = await Effect.runPromise(
      runFairSafePoolRecovery({
        study: Effect.sync(() => {
          trace.push("study");
          now += 500;
        }),
        financial: work("financial"),
        funding: work("funding"),
        takeTurn: Effect.sync(() => {
          const first = next;
          next = first === "financial" ? "funding" : "financial";
          return first;
        }),
        outerStartedAtMs: started,
        now: () => now,
      }),
    );
    expect(result.completed).toHaveLength(1);
  }
  expect(trace).toEqual([
    "study",
    "financial",
    "study",
    "funding",
    "study",
    "financial",
    "study",
    "funding",
    "study",
    "financial",
    "study",
    "funding",
  ]);
});

test.each(["study", "financial"] as const)(
  "%s uncertainty stops every later stage without a same-tick retry",
  async (at) => {
    const trace: string[] = [];
    const failure = new ControlPlaneTransactionOutcomeUnknown({
      phase: "commit",
      label: "local-uncertain",
      limitMs: 2000,
      elapsedMs: 2000,
    });
    const work = (name: string) =>
      Effect.sync(() => {
        trace.push(name);
      }).pipe(Effect.andThen(name === at ? Effect.fail(failure) : Effect.void));
    await expect(
      Effect.runPromise(
        runFairSafePoolRecovery({
          study: work("study"),
          financial: work("financial"),
          funding: work("funding"),
          takeTurn: Effect.succeed("financial"),
          outerStartedAtMs: 0,
          now: () => 0,
        }),
      ),
    ).rejects.toBe(failure);
    expect(trace).toEqual(at === "study" ? ["study"] : ["study", "financial"]);
  },
);

test("a hung provider cannot extend the original attempt or start the other family after timeout", async () => {
  const trace: string[] = [];
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.exit(
        runFairSafePoolRecovery({
          study: Effect.void,
          financial: Effect.sync(() => {
            trace.push("financial");
          }).pipe(Effect.andThen(Effect.never)),
          funding: Effect.sync(() => {
            trace.push("funding");
          }),
          takeTurn: Effect.succeed("financial"),
          outerStartedAtMs: 0,
          now: () => 0,
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(39_001);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(exit._tag).toBe("Failure");
  expect(trace).toEqual(["financial"]);
});
