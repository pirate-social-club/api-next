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
import {
  JobsWorkerConfig,
  type JobsWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  type Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";

import { makeCommunityPurchaseFundingReconciliationJob } from "./community-purchase-funding";
import {
  type HnsRouteRevalidationBindings,
  type HnsRouteRevalidationComposition,
  makeHnsRouteRevalidationComposition,
  makeHnsRouteRevalidationJob,
} from "./hns-route-revalidation";
import { buildJobRegistry, groupDueJobsByLane, JobContext, type JobDeclaration } from "./registry";
import { makeCommunityCatalogIntegrityJob } from "./routing-integrity";

export { ScheduledCronLockDO } from "@pirate/platform-cf";
export {
  HNS_ROUTE_EXPIRY_BATCH_LIMIT,
  HNS_ROUTE_EXPIRY_PRINCIPAL_ID,
  HNS_ROUTE_JOB_TIMEOUT_MS,
  HNS_ROUTE_PROVIDER_BUDGET_MARGIN_MS,
  HNS_ROUTE_RECOVERY_BACKOFF_SECONDS,
  HNS_ROUTE_REVALIDATION_BATCH_LIMIT,
  HNS_ROUTE_REVALIDATION_JOB,
  HNS_ROUTE_REVALIDATION_LANE,
  HNS_ROUTE_REVALIDATION_PRINCIPAL_ID,
  HNS_ROUTE_REVALIDATION_SCHEDULE,
  HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
  HNS_ROUTE_REVALIDATION_TIMEOUT,
  type HnsRouteRevalidationBindings,
  type HnsRouteRevalidationComposition,
  type HnsRouteRevalidationForce,
  makeHnsRouteRevalidationComposition,
  makeHnsRouteRevalidationJob,
} from "./hns-route-revalidation";
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
  COMMUNITY_CATALOG_INTEGRITY_JOB,
  COMMUNITY_CATALOG_INTEGRITY_LANE,
  COMMUNITY_CATALOG_INTEGRITY_SCHEDULE,
  COMMUNITY_CATALOG_INTEGRITY_SQL,
  COMMUNITY_CATALOG_INTEGRITY_TIMEOUT,
  COMMUNITY_CATALOG_READS,
  type CommunityCatalogIntegrityJobOptions,
  makeCommunityCatalogIntegrityJob,
} from "./routing-integrity";

export interface JobsWorkerEnv extends AlertSinkBindings, HnsRouteRevalidationBindings {
  readonly CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO>;
  readonly CONTROL_PLANE?: HyperdriveConnection;
  readonly API_NEXT_ENV?: string;
  readonly COMMUNITY_PURCHASE_FUNDING_RPC_URL?: string;
}

function loadJobsWorkerConfig(env: JobsWorkerEnv): JobsWorkerConfigValue {
  try {
    return loadConfigFrom(JobsWorkerConfig, {
      API_NEXT_ENV: env.API_NEXT_ENV,
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: env.COMMUNITY_PURCHASE_FUNDING_RPC_URL,
    });
  } catch {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
}

function fundingRpcUrl(value: string, environment: JobsWorkerConfigValue["API_NEXT_ENV"]): string {
  try {
    const parsed = new URL(value);
    const developmentLocal =
      environment === "development" &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    if (parsed.protocol !== "https:" && !developmentLocal) throw new Error("invalid RPC URL");
    return parsed.toString();
  } catch {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
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
  leaseLoss: Deferred.Deferred<void, LaneLeaseLost>,
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

const runScheduledEffect = Effect.fn("runScheduled")(function* <
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
  const releaseResult: { error: LaneLeaseLost | null } = { error: null };
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
            ? Effect.exit(releaseLaneLease(stub, state, owner)).pipe(
                Effect.flatMap((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) {
                      const error = typedErrorOf(exit.cause);
                      releaseResult.error =
                        error instanceof LaneLeaseLost ? error : new LaneLeaseLost();
                    }
                  }),
                ),
              )
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
  const result = yield* Effect.scoped(scopedRun);
  if (releaseResult.error !== null) return yield* Effect.fail(releaseResult.error);
  return result;
});

type RunScheduled = <Failure = unknown, Requirements = never>(
  env: JobsWorkerEnv,
  lane: string,
  jobsInput: JobDefinition<Failure, Requirements> | readonly JobDefinition<Failure, Requirements>[],
  now?: number,
  options?: LaneRunOptions,
) => Effect.Effect<LaneRunResult, unknown, never>;

export const runScheduled: RunScheduled = (env, lane, jobsInput, now, options) =>
  runScheduledEffect(env, lane, jobsInput, now, options) as Effect.Effect<
    LaneRunResult,
    unknown,
    never
  >;

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
  rpcUrl: string,
  hns: HnsRouteRevalidationComposition = { enabled: false },
  environment: JobsWorkerConfigValue["API_NEXT_ENV"] = "development",
) {
  const declarations: Array<JobDeclaration<unknown, ControlPlaneDb | AlertCollector>> = [
    makeCommunityCatalogIntegrityJob(sink),
    makeCommunityPurchaseFundingReconciliationJob(sink, rpcUrl),
  ];
  if (hns.enabled) {
    declarations.push(
      makeHnsRouteRevalidationJob({
        sink,
        provider: hns.provider,
        configuration: hns.configuration,
        force: hns.force,
        environment,
      }),
    );
  }
  return declarations;
}

export default {
  async scheduled(event: ScheduledEvent, env: JobsWorkerEnv, ctx: ExecutionContext) {
    if (env.CONTROL_PLANE === undefined) {
      throw new Error("CONTROL_PLANE Hyperdrive binding is required for jobs-worker");
    }
    const config = loadJobsWorkerConfig(env);
    const hns = makeHnsRouteRevalidationComposition(env);
    const rpcUrl = fundingRpcUrl(
      Redacted.value(config.COMMUNITY_PURCHASE_FUNDING_RPC_URL),
      config.API_NEXT_ENV,
    );
    const deliveryStub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:alerts`);
    const sink = makeConfiguredAlertSink(env, makeAlertDeliveryLedger(deliveryStub));
    const declarations = makeJobsWorkerDeclarations(sink, rpcUrl, hns, config.API_NEXT_ENV);
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
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
