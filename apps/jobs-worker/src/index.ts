/// <reference types="@cloudflare/workers-types" />

import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import {
  type AlertSinkBindings,
  alertTick,
  CRON_LOCK_NAME,
  type FencedLeaseRecord,
  type HyperdriveConnection,
  type LeaseRecord,
  makeAlertDeliveryLedger,
  makeConfiguredAlertSink,
  makeHyperdriveControlPlaneLayer,
  type ScheduledCronLockDO,
} from "@pirate/platform-cf";
import { Effect, type Layer } from "effect";

import { buildJobRegistry, JobContext, type JobDeclaration } from "./registry";
import {
  COMMUNITY_ROUTING_INTEGRITY_LANE,
  makeCommunityRoutingIntegrityJob,
} from "./routing-integrity";

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
export {
  COMMUNITY_ROUTING_INTEGRITY_JOB,
  COMMUNITY_ROUTING_INTEGRITY_LANE,
  COMMUNITY_ROUTING_INTEGRITY_SCHEDULE,
  COMMUNITY_ROUTING_INTEGRITY_SQL,
  COMMUNITY_ROUTING_INTEGRITY_TIMEOUT,
  COMMUNITY_ROUTING_READS,
  COMMUNITY_ROUTING_STALE_AFTER_MS,
  type CommunityRoutingIntegrityJobOptions,
  makeCommunityRoutingIntegrityJob,
} from "./routing-integrity";

export interface JobsWorkerEnv extends AlertSinkBindings {
  readonly CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO>;
  readonly CONTROL_PLANE?: HyperdriveConnection;
}

/** One job as declaration-as-data (000 §12), consumed by the generic runner. */
export type JobDefinition<Failure = unknown, Requirements = never> = JobDeclaration<
  Failure,
  Requirements
>;

export interface LaneRunResult {
  readonly lane: string;
  readonly acquired: boolean;
  /** null when the lease was not acquired; false when no job ran. */
  readonly ranJob: string | null;
  readonly timedOut: boolean;
  readonly leaseRenewals: number;
  readonly leaseAfterRun: LeaseRecord | null;
}

export interface LaneRunOptions {
  /** Runtime service layer for jobs that use application ports. */
  readonly runtime?: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  /** Narrower values are used by workerd tests to make renewal observable. */
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
}

const LANE_LEASE_TTL_MS = 30_000;

/**
 * One scheduled lane tick: acquire the lane's DO lease, run the lane's single
 * job under `Effect.timeout` (real interruption), then release owner-fenced.
 * A tick that loses the lease runs nothing — the one-writing-scheduler rule
 * (000 §13) starts here.
 */
export async function handleScheduled<Failure = unknown, Requirements = never>(
  env: JobsWorkerEnv,
  lane: string,
  job: JobDefinition<Failure, Requirements>,
  now: number = Date.now(),
  options: LaneRunOptions = {},
): Promise<LaneRunResult> {
  const stub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:${lane}`);
  const owner = crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? LANE_LEASE_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? Math.floor(leaseTtlMs / 3);
  const grant = await stub.tryAcquireWithFence(leaseTtlMs, owner, now);
  if (grant === null) {
    return {
      lane,
      acquired: false,
      ranJob: null,
      timedOut: false,
      leaseRenewals: 0,
      leaseAfterRun: null,
    };
  }
  let currentLease: FencedLeaseRecord = grant;
  const adapterSafety = { proven: false };
  let leaseRenewals = 0;
  let renewalInFlight = Promise.resolve();
  const renewalTimer = setInterval(() => {
    renewalInFlight = renewalInFlight
      .then(async () => {
        const renewed = await stub.renew(leaseTtlMs, owner, currentLease.generation, Date.now());
        if (renewed !== null) {
          currentLease = renewed;
          leaseRenewals += 1;
        }
      })
      .catch(() => undefined);
  }, renewIntervalMs);
  let timedOut = false;
  let releaseSafe = true;
  try {
    const runContext = {
      owner,
      attemptId: owner,
      lease: () => currentLease,
      adapterSafety: {
        markAbortedOrFenced: () => {
          adapterSafety.proven = true;
        },
        isProven: () => adapterSafety.proven,
      },
    };
    const withContext = Effect.provideService(job.run, JobContext, runContext);
    const retried = Effect.retry(withContext, {
      schedule: job.retry,
      while: (error: unknown) => {
        const tag =
          typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
        return typeof tag === "string" && job.expectedFailures.includes(tag);
      },
    });
    const collected = job.alertSink === undefined ? retried : alertTick(job.alertSink, retried);
    const withRuntime: Effect.Effect<void, unknown, never> =
      options.runtime === undefined
        ? (collected as Effect.Effect<void, unknown, never>)
        : Effect.scoped(
            Effect.provide(options.runtime)(
              collected as Effect.Effect<void, unknown, ControlPlaneDb>,
            ),
          );
    await Effect.runPromise(
      Effect.timeout(withRuntime, job.timeout).pipe(
        Effect.catchIf(
          (error: unknown): boolean =>
            typeof error === "object" &&
            error !== null &&
            (error as { _tag?: string })._tag === "TimeoutError",
          () =>
            Effect.sync(() => {
              timedOut = true;
              if (job.requiresAdapterSafety && !adapterSafety.proven) {
                releaseSafe = false;
              }
            }),
        ),
      ) as Effect.Effect<void, unknown, never>,
    );
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
    if (releaseSafe) await stub.releaseWithFence(owner, currentLease.generation);
  }
  if (timedOut && job.requiresAdapterSafety && !adapterSafety.proven) {
    throw new Error("job timeout had no adapter abort or fence evidence");
  }
  return {
    lane,
    acquired: true,
    ranJob: job.name,
    timedOut,
    leaseRenewals,
    leaseAfterRun: await stub.currentLease(),
  };
}

export default {
  async scheduled(event: ScheduledEvent, env: JobsWorkerEnv, ctx: ExecutionContext) {
    if (env.CONTROL_PLANE === undefined) {
      throw new Error("CONTROL_PLANE Hyperdrive binding is required for jobs-worker");
    }
    const deliveryStub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:alerts`);
    const sink = makeConfiguredAlertSink(env, makeAlertDeliveryLedger(deliveryStub));
    const job = makeCommunityRoutingIntegrityJob(sink);
    await Effect.runPromise(buildJobRegistry([job], ["control-plane:community_database_routing"]));
    await ctx.waitUntil(
      handleScheduled(env, COMMUNITY_ROUTING_INTEGRITY_LANE, job, event.scheduledTime, {
        runtime: makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE),
      }),
    );
  },
};
