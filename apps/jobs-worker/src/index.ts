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
import { Cause, Deferred, Effect, Exit, Fiber, type Layer, Option, Schedule, Schema } from "effect";

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

export class LaneLeaseLost extends Schema.TaggedError<LaneLeaseLost>()("LaneLeaseLost", {}) {}

export class LaneAdapterSafetyUnproven extends Schema.TaggedError<LaneAdapterSafetyUnproven>()(
  "LaneAdapterSafetyUnproven",
  { job: Schema.String },
) {}

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
interface LaneState {
  currentLease: FencedLeaseRecord;
  leaseLost: boolean;
  releaseSafe: boolean;
  leaseRenewals: number;
  leaseAfterRun: LeaseRecord | null;
}

const acquireLaneLease = Effect.fn("acquireLaneLease")(function* (
  stub: DurableObjectStub<ScheduledCronLockDO>,
  ttlMs: number,
  owner: string,
  now: number,
) {
  return yield* Effect.tryPromise({
    try: () => stub.tryAcquireWithFence(ttlMs, owner, now),
    catch: () => new LaneLeaseLost(),
  });
});

const renewLaneLease = Effect.fn("renewLaneLease")(function* (
  stub: DurableObjectStub<ScheduledCronLockDO>,
  state: LaneState,
  ttlMs: number,
  owner: string,
) {
  const renewed = yield* Effect.tryPromise({
    try: () => stub.renew(ttlMs, owner, state.currentLease.generation, Date.now()),
    catch: () => new LaneLeaseLost(),
  });
  if (renewed === null) return yield* Effect.fail(new LaneLeaseLost());
  state.currentLease = renewed;
  state.leaseRenewals += 1;
});

const releaseLaneLease = Effect.fn("releaseLaneLease")(function* (
  stub: DurableObjectStub<ScheduledCronLockDO>,
  state: LaneState,
  owner: string,
) {
  const released = yield* Effect.tryPromise({
    try: () => stub.releaseWithFence(owner, state.currentLease.generation),
    catch: () => new LaneLeaseLost(),
  });
  if (!released) return yield* Effect.fail(new LaneLeaseLost());
  state.leaseAfterRun = yield* Effect.tryPromise({
    try: () => stub.currentLease(),
    catch: () => new LaneLeaseLost(),
  });
});

const runScheduledJob = Effect.fn("runScheduledJob")(function* <Failure, Requirements>(
  job: JobDefinition<Failure, Requirements>,
  state: LaneState,
  leaseLoss: Deferred<void, LaneLeaseLost>,
  owner: string,
  options: LaneRunOptions,
) {
  const adapterSafety = { proven: false };
  const runContext = {
    owner,
    attemptId: `${owner}:${job.name}`,
    lease: () => state.currentLease,
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
          Effect.provide(options.runtime)(retried as Effect.Effect<void, unknown, ControlPlaneDb>),
        );
  const leaseGuard = Deferred.await(leaseLoss);
  const timed = Effect.raceFirst(Effect.timeout(withRuntime, job.timeout), leaseGuard);
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
    exit: yield* Effect.exit(observed as Effect.Effect<void, unknown, never>),
    adapterSafety,
  };
});

export const runScheduled = Effect.fn("runScheduled")(function* <
  Failure = unknown,
  Requirements = never,
>(
  env: JobsWorkerEnv,
  lane: string,
  jobsInput: JobDefinition<Failure, Requirements> | readonly JobDefinition<Failure, Requirements>[],
  now: number = Date.now(),
  options: LaneRunOptions = {},
) {
  const jobs = Array.isArray(jobsInput) ? jobsInput : [jobsInput];
  const stub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:${lane}`);
  const owner = crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? LANE_LEASE_TTL_MS;
  const renewIntervalMs = Math.max(1, options.renewIntervalMs ?? Math.floor(leaseTtlMs / 3));
  const grant = yield* acquireLaneLease(stub, leaseTtlMs, owner, now);
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
  const scopedRun = Effect.acquireRelease(
    Effect.gen(function* () {
      const state: LaneState = {
        currentLease: grant,
        leaseLost: false,
        releaseSafe: true,
        leaseRenewals: 0,
        leaseAfterRun: null,
      };
      const leaseLoss = yield* Deferred.make<void, LaneLeaseLost>();
      const renewal = Effect.repeat(
        Effect.sleep(renewIntervalMs).pipe(
          Effect.flatMap(() => renewLaneLease(stub, state, leaseTtlMs, owner)),
        ),
        Schedule.forever,
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            state.leaseLost = true;
            return error;
          }).pipe(
            Effect.flatMap((leaseError) =>
              Deferred.fail(leaseLoss, leaseError).pipe(Effect.andThen(Effect.fail(leaseError))),
            ),
          ),
        ),
      );
      const renewalFiber = yield* renewal.pipe(Effect.forkScoped);
      return { state, leaseLoss, renewalFiber };
    }),
    ({ state, renewalFiber }) =>
      Fiber.interrupt(renewalFiber).pipe(
        Effect.andThen(
          state.releaseSafe && !state.leaseLost
            ? releaseLaneLease(stub, state, owner)
            : Effect.void,
        ),
      ),
  ).pipe(
    Effect.flatMap(({ state, leaseLoss }) =>
      Effect.gen(function* () {
        const timedOutJobs: string[] = [];
        const ranJobs: string[] = [];
        let firstFailure: Cause.Cause<unknown> | undefined;

        for (const job of jobs) {
          const result = yield* runScheduledJob(job, state, leaseLoss, owner, options);
          ranJobs.push(job.name);
          if (Exit.isSuccess(result.exit)) continue;
          if (tagOf(typedErrorOf(result.exit.cause)) === "LaneLeaseLost") {
            state.releaseSafe = false;
            break;
          }
          if (isRunnerTimeout(result.exit.cause)) {
            timedOutJobs.push(job.name);
            if (job.requiresAdapterSafety && !result.adapterSafety.proven) {
              state.releaseSafe = false;
              return yield* Effect.fail(new LaneAdapterSafetyUnproven({ job: job.name }));
            }
            continue;
          }
          firstFailure ??= result.exit.cause;
        }
        if (state.leaseLost) return yield* Effect.fail(new LaneLeaseLost());
        if (firstFailure !== undefined) return yield* Effect.failCause(firstFailure);
        return {
          lane,
          acquired: true,
          ranJob: ranJobs[0] ?? null,
          ranJobs,
          timedOut: timedOutJobs.length > 0,
          leaseRenewals: state.leaseRenewals,
          leaseAfterRun: state.leaseAfterRun,
        } satisfies LaneRunResult;
      }),
    ),
  );
  return yield* Effect.scoped(scopedRun);
});

export async function handleScheduled<Failure = unknown, Requirements = never>(
  env: JobsWorkerEnv,
  lane: string,
  jobsInput: JobDefinition<Failure, Requirements> | readonly JobDefinition<Failure, Requirements>[],
  now: number = Date.now(),
  options: LaneRunOptions = {},
): Promise<LaneRunResult> {
  return Effect.runPromise(runScheduled(env, lane, jobsInput, now, options));
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
