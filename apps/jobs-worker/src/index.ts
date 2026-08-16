/// <reference types="@cloudflare/workers-types" />

import {
  CRON_LOCK_NAME,
  type FencedLeaseRecord,
  type LeaseRecord,
  type ScheduledCronLockDO,
} from "@pirate/platform-cf";
import { Effect } from "effect";

import {
  buildJobRegistry,
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
} from "./registry";

export { ScheduledCronLockDO } from "@pirate/platform-cf";
export {
  buildJobRegistry,
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type JobRegistry,
  type JobRuntimeContext,
  RegistryConfigurationError,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export interface JobsWorkerEnv {
  readonly CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO>;
}

/** One job as declaration-as-data (000 §12), consumed by the generic runner. */
export type JobDefinition = JobDeclaration;

export interface LaneRunResult {
  readonly lane: string;
  readonly acquired: boolean;
  /** null when the lease was not acquired; false when no job ran. */
  readonly ranJob: string | null;
  readonly timedOut: boolean;
  readonly leaseAfterRun: LeaseRecord | null;
}

const LANE_LEASE_TTL_MS = 30_000;
const LANE_RENEW_INTERVAL_MS = Math.floor(LANE_LEASE_TTL_MS / 3);

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
  const grant = await stub.tryAcquireWithFence(LANE_LEASE_TTL_MS, owner, now);
  if (grant === null) {
    return { lane, acquired: false, ranJob: null, timedOut: false, leaseAfterRun: null };
  }
  let currentLease: FencedLeaseRecord = grant;
  let renewalInFlight = Promise.resolve();
  const renewalTimer = setInterval(() => {
    renewalInFlight = renewalInFlight
      .then(async () => {
        const renewed = await stub.renew(
          LANE_LEASE_TTL_MS,
          owner,
          currentLease.generation,
          Date.now(),
        );
        if (renewed !== null) currentLease = renewed;
      })
      .catch(() => undefined);
  }, LANE_RENEW_INTERVAL_MS);
  let timedOut = false;
  try {
    const run = Effect.provideService(job.run, JobContext, {
      owner,
      attemptId: owner,
      lease: () => currentLease,
    });
    await Effect.runPromise(
      Effect.timeout(run, job.timeout).pipe(
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
    clearInterval(renewalTimer);
    await renewalInFlight;
    await stub.releaseWithFence(owner, currentLease.generation);
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
      schedule: event.cron,
      timeout: "5 seconds",
      retry: defaultRetrySchedule,
      expectedFailures: [],
      severity: {
        expectedFailure: {},
        timeout: "low",
        transactionOutcomeUnknown: "high",
        defect: "high",
      },
      writes: [],
      run: Effect.void,
    };
    await Effect.runPromise(buildJobRegistry([spikeJob]));
    await ctx.waitUntil(handleScheduled(env, spikeJob.lane, spikeJob));
  },
};
