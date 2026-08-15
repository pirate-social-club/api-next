/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as testEnv } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { handleScheduled, type JobsWorkerEnv } from "../../apps/jobs-worker/src/index";

const env = testEnv as unknown as JobsWorkerEnv;

describe("scheduled lane holding a DO lease (workerd)", () => {
  it("runs exactly one concurrent tick per lane; loser runs nothing", async () => {
    let ran = 0;
    const job = {
      name: "spike.lane-probe",
      lane: "spike-lane",
      timeout: 5_000,
      run: Effect.gen(function* () {
        ran += 1;
        // Hold the lane long enough for the competing tick to be denied.
        yield* Effect.sleep(300);
      }),
    };
    const [winner, loser] = await Promise.all([
      handleScheduled(env, job.lane, job),
      handleScheduled(env, job.lane, job),
    ]);
    expect(ran).toBe(1);
    expect(winner.acquired).toBe(true);
    expect(loser.acquired).toBe(false);
    expect(loser.ranJob).toBeNull();
    // The winner released owner-fenced: the lease is free again afterwards.
    expect(winner.leaseAfterRun).toBeNull();

    // Post-release, a fresh tick can acquire the lane again.
    const again = await handleScheduled(env, job.lane, job);
    expect(again.acquired).toBe(true);
    expect(ran).toBe(2);
  });
});
