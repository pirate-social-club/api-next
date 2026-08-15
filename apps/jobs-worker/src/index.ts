/// <reference types="@cloudflare/workers-types" />

import { CRON_LOCK_NAME, type LeaseRecord, type ScheduledCronLockDO } from "@pirate/platform-cf";
import { type Duration, Effect } from "effect";

export { ScheduledCronLockDO } from "@pirate/platform-cf";

export interface JobsWorkerEnv {
  readonly CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO>;
}

/** One job as an Effect program (000 §12): declarative metadata plus run. */
export interface JobDefinition {
  readonly name: string;
  readonly lane: string;
  readonly timeout: Duration.Input;
  readonly run: Effect.Effect<unknown, unknown, never>;
}

export interface LaneRunResult {
  readonly lane: string;
  readonly acquired: boolean;
  /** null when the lease was not acquired; false when no job ran. */
  readonly ranJob: string | null;
  readonly timedOut: boolean;
  readonly leaseAfterRun: LeaseRecord | null;
}

const LANE_LEASE_TTL_MS = 30_000;

/**
 * One scheduled lane tick: acquire the lane's DO lease, run the lane's single
 * job under `Effect.timeout` (real interruption), then release owner-fenced.
 * A tick that loses the lease runs nothing — the one-writing-scheduler rule
 * (000 §13) starts here.
 */
export async function handleScheduled(
  env: JobsWorkerEnv,
  lane: string,
  job: JobDefinition,
  now: number = Date.now(),
): Promise<LaneRunResult> {
  const stub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:${lane}`);
  const owner = crypto.randomUUID();
  const acquired = await stub.tryAcquire(LANE_LEASE_TTL_MS, owner, now);
  if (!acquired) {
    return { lane, acquired: false, ranJob: null, timedOut: false, leaseAfterRun: null };
  }
  let timedOut = false;
  try {
    await Effect.runPromise(
      Effect.timeout(job.run, job.timeout).pipe(
        Effect.catchIf(
          (error: unknown): boolean =>
            typeof error === "object" &&
            error !== null &&
            (error as { _tag?: string })._tag === "TimeoutError",
          () =>
            Effect.sync(() => {
              timedOut = true;
            }),
        ),
      ),
    );
  } finally {
    await stub.release(owner);
  }
  return {
    lane,
    acquired: true,
    ranJob: job.name,
    timedOut,
    leaseAfterRun: await stub.currentLease(),
  };
}

export default {
  async scheduled(event: ScheduledEvent, env: JobsWorkerEnv, ctx: ExecutionContext) {
    // The lane registry is data (000 §12); one lane proves the kernel here.
    const spikeJob: JobDefinition = {
      name: "spike.noop",
      lane: event.cron,
      timeout: "5 seconds",
      run: Effect.void,
    };
    await ctx.waitUntil(handleScheduled(env, spikeJob.lane, spikeJob));
  },
};
