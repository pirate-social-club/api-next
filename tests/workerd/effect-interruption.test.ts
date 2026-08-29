/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  defaultRetrySchedule,
  handleScheduled,
  type JobDefinition,
  type JobsWorkerEnv,
  makeCommunityCatalogIntegrityJob,
} from "../../apps/jobs-worker/src/index";

const env = testEnv as unknown as JobsWorkerEnv;

/**
 * Spike (b): prove `Effect.timeout` INTERRUPTS in-flight work on workerd —
 * cancellation, not deadline-gating. The old API's deadline gates starts but
 * cannot cancel (000 §1); if the fiber runtime misbehaved on workerd the loop
 * below would keep incrementing after the TimeoutError and the finalizer
 * would never run.
 */
describe("Effect.timeout real interruption (workerd)", () => {
  it("cancels in-flight work and runs the scope finalizer", async () => {
    const probe = { ticks: 0, finalized: false };

    // Endless work: every 10ms increments a counter. This is the shape of a
    // hung fetch/DB call wrapped by a job deadline.
    const work = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          probe.finalized = true;
        }),
      );
      return yield* Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(10);
          probe.ticks += 1;
        }),
      );
    });

    const result = await Effect.runPromise(Effect.flip(Effect.scoped(Effect.timeout(work, 120))));
    expect(result).toMatchObject({ _tag: "TimeoutError" });

    // The work demonstrably started (in-flight, not pre-start gated)...
    expect(probe.ticks).toBeGreaterThan(0);
    // ...the interruption reached the async boundary (finalizer ran)...
    expect(probe.finalized).toBe(true);

    // ...and the cancelled fiber actually stopped: after 5x the loop period
    // with nothing else scheduled, the counter has not moved. If timeout had
    // merely raced the deadline without cancelling, ticks would keep rising.
    const atCancel = probe.ticks;
    await Effect.runPromise(Effect.sleep(50));
    expect(probe.ticks).toBe(atCancel);
  });

  it("interruption propagates through the lane scheduler and reports the timeout", async () => {
    let started = false;
    const job: JobDefinition = {
      name: "spike.hangs",
      lane: "spike-timeout",
      schedule: "*/5 * * * *",
      timeout: 150,
      retry: defaultRetrySchedule,
      expectedFailures: [],
      severity: {
        expectedFailure: {},
        timeout: "medium",
        transactionOutcomeUnknown: "high",
        defect: "high",
      },
      reads: [],
      writes: [],
      run: Effect.gen(function* () {
        started = true;
        return yield* Effect.forever(Effect.sleep(10));
      }),
    };
    const result = await handleScheduled(env, "spike-timeout", job);
    expect(started).toBe(true); // it was in-flight, not gated at start
    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(true);
    // The scheduler survived the interruption and released the lease.
    expect(result.leaseAfterRun).toBeNull();
  });

  it("proves the real job abort path before the DO lease is released", async () => {
    const trace: string[] = [];
    const db = {
      execute: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              trace.push("adapter_aborted");
            }),
          ),
        ),
      withTransaction: () => Effect.die("routing audit must remain read-only"),
    } as unknown as ControlPlaneDb["Service"];
    const sink = {};
    const job = makeCommunityCatalogIntegrityJob(sink, { timeout: 50 });

    const result = await handleScheduled(env, job.lane, job, Date.now(), {
      runtime: Layer.succeed(ControlPlaneDb, db),
      leaseTtlMs: 1_000,
      renewIntervalMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(trace).toEqual(["adapter_aborted"]);
    expect(result.leaseAfterRun).toBeNull();
  });
});
