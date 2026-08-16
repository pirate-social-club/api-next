/// <reference types="@cloudflare/workers-types" />

import {
  type Alert,
  AlertCollector,
  type ControlPlaneDb,
  type ControlPlaneError,
} from "@pirate/application";
import {
  type AlertSink,
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
import { Cause, Effect, Exit, type Layer, Option } from "effect";

import { buildJobRegistry, groupDueJobsByLane, JobContext, type JobDeclaration } from "./registry";
import { makeCommunityRoutingIntegrityJob } from "./routing-integrity";

export { ScheduledCronLockDO } from "@pirate/platform-cf";
export {
  buildJobRegistry,
  defaultRetrySchedule,
  groupDueJobsByLane,
  isScheduleDue,
  JobContext,
  type JobDeclaration,
  type JobRegistry,
  type JobRuntimeContext,
  RegistryConfigurationError,
  type SeverityMapping,
  selectDueJobs,
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
  readonly ranJobs: readonly string[];
  readonly timedOut: boolean;
  readonly leaseRenewals: number;
  readonly leaseAfterRun: LeaseRecord | null;
}

export interface LaneRunOptions {
  /** Runtime service layer for jobs that use application ports. */
  readonly runtime?: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  /** Tick-level sink; a declaration-specific sink takes precedence. */
  readonly alertSink?: AlertSink;
  /** Narrower values are used by workerd tests to make renewal observable. */
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
}

const LANE_LEASE_TTL_MS = 30_000;

function tagOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined;
  return typeof error._tag === "string" ? error._tag : undefined;
}

function typedErrorOf(cause: Cause.Cause<unknown>): unknown | undefined {
  const result = Cause.findErrorOption(cause);
  return Option.isSome(result) ? result.value : undefined;
}

function isRunnerTimeout(cause: Cause.Cause<unknown>): boolean {
  return tagOf(typedErrorOf(cause)) === "TimeoutError";
}

function isUnknownControlPlaneOutcome(error: unknown): boolean {
  if (tagOf(error) === "ControlPlaneTransactionOutcomeUnknown") return true;
  if (
    tagOf(error) !== "ControlPlaneOperationTimedOut" &&
    tagOf(error) !== "ControlPlaneStatementFailed"
  ) {
    return false;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeCertainty" in error &&
    error.outcomeCertainty === "unknown"
  );
}

export function runnerAlert<Failure, Requirements>(
  job: JobDefinition<Failure, Requirements>,
  cause: Cause.Cause<unknown>,
): Alert {
  const error = typedErrorOf(cause);
  const tag = tagOf(error);
  if (tag === "TimeoutError") {
    return {
      key: "jobs:runner-timeout",
      severity: job.severity.timeout,
      body: "api-next job runner timeout.",
      entity: `job:${job.name}`,
    };
  }
  if (isUnknownControlPlaneOutcome(error)) {
    return {
      key: "jobs:transaction-outcome-unknown",
      severity: job.severity.transactionOutcomeUnknown,
      body: "api-next job transaction outcome is unknown.",
      entity: `job:${job.name}`,
    };
  }
  if (tag !== undefined && job.expectedFailures.includes(tag)) {
    return {
      key: "jobs:expected-failure",
      severity: job.severity.expectedFailure[tag] ?? job.severity.defect,
      body: "api-next job expected failure.",
      entity: `job:${job.name}`,
    };
  }
  return {
    key: "jobs:defect",
    severity: job.severity.defect,
    body: Cause.hasDies(cause) ? "api-next job defect." : "api-next job failed.",
    entity: `job:${job.name}`,
  };
}

/**
 * One scheduled lane tick: acquire the lane's DO lease, run due jobs
 * sequentially under their own `Effect.timeout`, then release owner-fenced.
 * A tick that loses the lease runs nothing — the one-writing-scheduler rule
 * (000 §13) starts here.
 */
export async function handleScheduled<Failure = unknown, Requirements = never>(
  env: JobsWorkerEnv,
  lane: string,
  jobsInput: JobDefinition<Failure, Requirements> | readonly JobDefinition<Failure, Requirements>[],
  now: number = Date.now(),
  options: LaneRunOptions = {},
): Promise<LaneRunResult> {
  const jobs = Array.isArray(jobsInput) ? jobsInput : [jobsInput];
  const stub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:${lane}`);
  const owner = crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? LANE_LEASE_TTL_MS;
  const renewIntervalMs = Math.max(1, options.renewIntervalMs ?? Math.floor(leaseTtlMs / 3));
  const grant = await stub.tryAcquireWithFence(leaseTtlMs, owner, now);
  if (grant === null) {
    return {
      lane,
      acquired: false,
      ranJob: null,
      ranJobs: [],
      timedOut: false,
      leaseRenewals: 0,
      leaseAfterRun: null,
    };
  }
  let currentLease: FencedLeaseRecord = grant;
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
  let firstFailure: Cause.Cause<unknown> | undefined;
  const ranJobs: string[] = [];

  const runJob = async (job: JobDefinition<Failure, Requirements>) => {
    const adapterSafety = { proven: false };
    try {
      const runContext = {
        owner,
        attemptId: `${owner}:${job.name}`,
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
          const tag = tagOf(error);
          return tag !== undefined && job.expectedFailures.includes(tag);
        },
      });
      const withRuntime: Effect.Effect<void, unknown, never> =
        options.runtime === undefined
          ? (retried as Effect.Effect<void, unknown, never>)
          : Effect.scoped(
              Effect.provide(options.runtime)(
                retried as Effect.Effect<void, unknown, ControlPlaneDb>,
              ),
            );
      const timed = Effect.timeout(withRuntime, job.timeout);
      const alertSink = job.alertSink ?? options.alertSink;
      const observed =
        alertSink === undefined
          ? timed
          : alertTick(
              alertSink,
              Effect.gen(function* () {
                const collector = yield* AlertCollector;
                const result = yield* Effect.exit(timed);
                if (Exit.isFailure(result)) {
                  yield* collector.emit(runnerAlert(job, result.cause));
                  return yield* Effect.failCause(result.cause);
                }
                return result.value;
              }),
            );
      return {
        exit: await Effect.runPromise(Effect.exit(observed as Effect.Effect<void, unknown, never>)),
        adapterSafety,
      };
    } catch (error) {
      return {
        exit: Exit.die(error),
        adapterSafety,
      };
    }
  };

  try {
    for (const job of jobs) {
      const result = await runJob(job);
      ranJobs.push(job.name);
      if (Exit.isSuccess(result.exit)) continue;
      if (isRunnerTimeout(result.exit.cause)) {
        timedOut = true;
        if (job.requiresAdapterSafety && !result.adapterSafety.proven) {
          releaseSafe = false;
          break;
        }
        continue;
      }
      firstFailure ??= result.exit.cause;
    }
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
    if (releaseSafe) await stub.releaseWithFence(owner, currentLease.generation);
  }
  if (!releaseSafe) {
    throw new Error("job timeout had no adapter abort or fence evidence");
  }
  if (firstFailure !== undefined) {
    await Effect.runPromise(Effect.failCause(firstFailure));
  }
  return {
    lane,
    acquired: true,
    ranJob: ranJobs[0] ?? null,
    ranJobs,
    timedOut,
    leaseRenewals,
    leaseAfterRun: await stub.currentLease(),
  };
}

export function makeJobsWorkerDeclarations(
  sink: AlertSink,
): readonly JobDefinition<ControlPlaneError, ControlPlaneDb | AlertCollector>[] {
  const factories = [makeCommunityRoutingIntegrityJob] as const;
  return factories.map((factory) => factory(sink));
}

export default {
  async scheduled(event: ScheduledEvent, env: JobsWorkerEnv, ctx: ExecutionContext) {
    if (env.CONTROL_PLANE === undefined) {
      throw new Error("CONTROL_PLANE Hyperdrive binding is required for jobs-worker");
    }
    const deliveryStub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:alerts`);
    const sink = makeConfiguredAlertSink(env, makeAlertDeliveryLedger(deliveryStub));
    const declarations = makeJobsWorkerDeclarations(sink);
    const registry = await Effect.runPromise(
      buildJobRegistry(declarations, ["control-plane:community_database_routing"]),
    );
    const dueByLane = groupDueJobsByLane(registry, event.scheduledTime);
    const runtime = makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE);
    await ctx.waitUntil(
      Promise.all(
        Array.from(dueByLane, ([lane, laneJobs]) =>
          handleScheduled(env, lane, laneJobs, event.scheduledTime, { runtime }),
        ),
      ),
    );
  },
};
