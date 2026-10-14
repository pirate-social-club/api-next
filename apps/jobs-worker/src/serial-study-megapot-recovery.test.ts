import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runSerialStudyMegapotRecovery } from "./serial-study-megapot-recovery.ts";

// Pure ordering/budget causal tests. Actual DB/registry/IO are separate gates.
describe("serial Study then financial recovery", () => {
  test("retains a genuinely outstanding Study stage before starting financial work", async () => {
    const trace: string[] = [];
    let release = (): void => {};
    const outstanding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Effect.runPromise(
      runSerialStudyMegapotRecovery({
        study: Effect.promise(async () => {
          trace.push("account-guest-expiry-cleanup");
          await outstanding;
          trace.push("study-settled");
        }),
        financial: Effect.sync(() => {
          trace.push("financial");
        }),
        outerStartedAtMs: 1000,
        now: () => 2000,
      }),
    );
    // Observe rejection immediately; a failing assertion cannot strand work.
    const observed = running.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.resolve();
      expect(trace).toEqual(["account-guest-expiry-cleanup"]);
    } finally {
      release();
      await observed;
    }
    const settled = await observed;
    if ("error" in settled) throw settled.error;
    expect(settled.value).toEqual({ financial: "ran", remainingMs: 49000 });
    expect(trace).toEqual(["account-guest-expiry-cleanup", "study-settled", "financial"]);
  });
  test("original unknown COMMIT stops all financial work without retry or replacement", async () => {
    const original = {
      _tag: "ControlPlaneTransactionOutcomeUnknown",
      originalKey: "same-original-source-operation",
    };
    let financial = 0,
      study = 0;
    const failure = await Effect.runPromise(
      Effect.flip(
        runSerialStudyMegapotRecovery({
          study: Effect.suspend(() => {
            study++;
            return Effect.fail(original);
          }),
          financial: Effect.sync(() => {
            financial++;
          }),
          outerStartedAtMs: 1000,
          now: () => 2000,
        }),
      ),
    );
    expect(failure).toBe(original);
    expect(study).toBe(1);
    expect(financial).toBe(0);
  });
  test("slow actual source work consumes the original budget and holds financial work", async () => {
    let current = 31000,
      financial = 0;
    const result = await Effect.runPromise(
      runSerialStudyMegapotRecovery({
        study: Effect.sync(() => {
          current = 39000;
        }),
        financial: Effect.sync(() => {
          financial++;
        }),
        outerStartedAtMs: 1000,
        now: () => current,
      }),
    );
    expect(result).toEqual({ financial: "skipped_remaining_budget", remainingMs: 12000 });
    expect(financial).toBe(0);
  });
  test("missing/backward original clock refuses rather than inventing a financial budget", async () => {
    let work = 0;
    for (const started of [Number.NaN, 3000]) {
      await expect(
        Effect.runPromise(
          runSerialStudyMegapotRecovery({
            study: Effect.sync(() => {
              work++;
            }),
            financial: Effect.sync(() => {
              work++;
            }),
            outerStartedAtMs: started,
            now: () => 2000,
          }),
        ),
      ).rejects.toBeDefined();
    }
    expect(work).toBe(0);
  });
});
