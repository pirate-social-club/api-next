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
  assertMegapotRewardRuntimePosture,
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
  type DataRegistrationJobsBindings,
  makeDataRegistrationMaintenance,
} from "./data-registration-runtime";
import {
  type HnsRouteRevalidationBindings,
  type HnsRouteRevalidationComposition,
  makeHnsRouteRevalidationComposition,
  makeHnsRouteRevalidationJob,
} from "./hns-route-revalidation";
import { type MediaJobsBindings, makeMediaMaintenance } from "./media-runtime";
import { handleMegapotPublicCommitment } from "./megapot-commitment-public";
import { type MegapotRewardsJobOptions, makeMegapotRewardsJob } from "./megapot-rewards";
import { buildJobRegistry, groupDueJobsByLane, JobContext, type JobDeclaration } from "./registry";
import { makeCommunityCatalogIntegrityJob } from "./routing-integrity";
import {
  collectSongPipelineOutboxAlerts,
  runSongPipelineOutboxAlertTick,
} from "./song-pipeline-outbox-alerts";

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
  MEGAPOT_REWARDS_CYCLE_JOB,
  MEGAPOT_REWARDS_CYCLE_LANE,
  MEGAPOT_REWARDS_CYCLE_SCHEDULE,
  MEGAPOT_REWARDS_CYCLE_TIMEOUT,
  type MegapotRewardsCycleSummary,
  type MegapotRewardsJobOptions,
  type MegapotRewardsRuntime,
  makeMegapotRewardsJob,
  runMegapotRewardsCycle,
} from "./megapot-rewards";
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

export interface JobsWorkerEnv
  extends AlertSinkBindings,
    DataRegistrationJobsBindings,
    HnsRouteRevalidationBindings,
    MediaJobsBindings {
  readonly CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO>;
  readonly CONTROL_PLANE?: HyperdriveConnection;
  readonly MEGAPOT_COMMITMENTS?: R2Bucket;
  readonly API_NEXT_ENV?: string;
  readonly COMMUNITY_PURCHASE_FUNDING_RPC_URL?: string;
  readonly MEGAPOT_REWARDS_ENABLED?: string;
  readonly MEGAPOT_CHAIN_ID?: string;
  readonly MEGAPOT_V2_RPC_URL?: string;
  readonly MEGAPOT_ATTESTATION_ID?: string;
  readonly MEGAPOT_REQUIRED_CONFIRMATIONS?: string;
  readonly MEGAPOT_CUSTODY_PRIVATE_KEY?: string;
  readonly MEGAPOT_COMMITMENT_PUBLIC_ORIGIN?: string;
  readonly MEGAPOT_OBSERVATION_TTL_SECONDS?: string;
  readonly MEGAPOT_APPROVED_ALLOWANCE_ATOMIC?: string;
  readonly MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS?: string;
  readonly MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS?: string;
  readonly MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI?: string;
  readonly MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING?: string;
  readonly MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC?: string;
  readonly MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING?: string;
  readonly MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC?: string;
}

function loadJobsWorkerConfig(env: JobsWorkerEnv): JobsWorkerConfigValue {
  try {
    return loadConfigFrom(JobsWorkerConfig, {
      API_NEXT_ENV: env.API_NEXT_ENV,
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: env.COMMUNITY_PURCHASE_FUNDING_RPC_URL,
      MEGAPOT_REWARDS_ENABLED: env.MEGAPOT_REWARDS_ENABLED,
      MEGAPOT_CHAIN_ID: env.MEGAPOT_CHAIN_ID,
      MEGAPOT_V2_RPC_URL: env.MEGAPOT_V2_RPC_URL,
      MEGAPOT_ATTESTATION_ID: env.MEGAPOT_ATTESTATION_ID,
      MEGAPOT_REQUIRED_CONFIRMATIONS: env.MEGAPOT_REQUIRED_CONFIRMATIONS,
      MEGAPOT_CUSTODY_PRIVATE_KEY: env.MEGAPOT_CUSTODY_PRIVATE_KEY,
      MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: env.MEGAPOT_COMMITMENT_PUBLIC_ORIGIN,
      MEGAPOT_OBSERVATION_TTL_SECONDS: env.MEGAPOT_OBSERVATION_TTL_SECONDS,
      MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: env.MEGAPOT_APPROVED_ALLOWANCE_ATOMIC,
      MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: env.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS,
      MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: env.MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS,
      MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: env.MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI,
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING:
        env.MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING,
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC:
        env.MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC,
      MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: env.MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING,
      MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC:
        env.MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC,
    });
  } catch {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
}

const UINT256_MAX = (1n << 256n) - 1n;

function bigintSetting(value: string, allowZero = false): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (allowZero ? parsed < 0n : parsed < 1n)) {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
  return parsed;
}

function makeMegapotOptions(
  env: JobsWorkerEnv,
  config: JobsWorkerConfigValue,
): MegapotRewardsJobOptions | null {
  assertMegapotRewardRuntimePosture(config);
  if (!config.MEGAPOT_REWARDS_ENABLED) return null;
  if (env.MEGAPOT_COMMITMENTS === undefined) {
    throw new Error("MEGAPOT_COMMITMENTS R2 binding is required when Megapot rewards are enabled");
  }
  const custodyPrivateKey = Redacted.value(config.MEGAPOT_CUSTODY_PRIVATE_KEY);
  const commitmentPublicOrigin = Redacted.value(config.MEGAPOT_COMMITMENT_PUBLIC_ORIGIN);
  let parsedCommitmentOrigin: URL;
  try {
    parsedCommitmentOrigin = new URL(commitmentPublicOrigin);
  } catch {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
  if (
    !/^0x[0-9a-f]{64}$/iu.test(custodyPrivateKey) ||
    parsedCommitmentOrigin.protocol !== "https:" ||
    parsedCommitmentOrigin.pathname !== "/" ||
    parsedCommitmentOrigin.search.length > 0 ||
    parsedCommitmentOrigin.hash.length > 0 ||
    parsedCommitmentOrigin.username.length > 0 ||
    parsedCommitmentOrigin.password.length > 0 ||
    !Number.isSafeInteger(config.MEGAPOT_OBSERVATION_TTL_SECONDS) ||
    config.MEGAPOT_OBSERVATION_TTL_SECONDS < 1 ||
    config.MEGAPOT_OBSERVATION_TTL_SECONDS > 900 ||
    !Number.isSafeInteger(config.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS) ||
    config.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS < 1 ||
    config.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS > 3_600 ||
    !Number.isSafeInteger(config.MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS) ||
    config.MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS < 10_000 ||
    config.MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS > 20_000 ||
    config.MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING < 1 ||
    config.MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING < 1
  ) {
    throw new Error("Jobs worker configuration is incomplete or invalid");
  }
  return {
    attestationId: config.MEGAPOT_ATTESTATION_ID,
    rpcUrl: fundingRpcUrl(Redacted.value(config.MEGAPOT_V2_RPC_URL), config.API_NEXT_ENV),
    custodyPrivateKey,
    commitmentBucket: env.MEGAPOT_COMMITMENTS,
    commitmentPublicOrigin,
    requiredConfirmations: config.MEGAPOT_REQUIRED_CONFIRMATIONS,
    observationTtlMs: config.MEGAPOT_OBSERVATION_TTL_SECONDS * 1_000,
    approvedAllowanceAtomic: bigintSetting(config.MEGAPOT_APPROVED_ALLOWANCE_ATOMIC),
    purchaseSafetyMarginSeconds: config.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS,
    gasLimitMultiplierBps: config.MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS,
    nativeGasReserveFloorWei: bigintSetting(config.MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI, true),
    externalSponsorDailyTicketCeiling: config.MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING,
    externalSponsorDailySpendCeilingAtomic: bigintSetting(
      config.MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC,
    ),
    sharedSponsorDailyTicketCeiling: config.MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING,
    sharedSponsorDailySpendCeilingAtomic: bigintSetting(
      config.MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC,
    ),
  };
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
  readonly renewDeadlineMs?: number;
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
  deadlineMs: number,
) {
  const renewed = yield* Effect.tryPromise({
    try: () =>
      new Promise<FencedLeaseRecord | null>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new LaneLeaseLost());
        }, deadlineMs);
        stub.renew(ttlMs, owner, state.currentLease.generation, Date.now()).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          },
        );
      }),
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
  const renewDeadlineMs = Math.max(
    1,
    Math.min(options.renewDeadlineMs ?? Math.floor(leaseTtlMs / 3), leaseTtlMs),
  );
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
      const renewOnce = renewLaneLease(stub, state, leaseTtlMs, owner, renewDeadlineMs).pipe(
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
      const renewal = Effect.repeat(
        Effect.sleep(renewIntervalMs).pipe(
          // A Durable Object RPC can still commit after an interrupted
          // Promise stops notifying its caller. Drain an in-flight renewal so
          // release always uses the generation that the DO actually stored.
          Effect.flatMap(() => Effect.uninterruptible(renewOnce)),
        ),
        Schedule.forever,
      );
      const renewalFiber = yield* renewal.pipe(Effect.forkScoped);
      return { state, leaseLoss, renewalFiber };
    }),
    ({ state, renewalFiber }) =>
      Fiber.interrupt(renewalFiber).pipe(
        Effect.flatMap(() =>
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
            : state.leaseLost
              ? Effect.sync(() => {
                  releaseResult.error = new LaneLeaseLost();
                })
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
  megapot: MegapotRewardsJobOptions | null = null,
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
  if (megapot !== null) declarations.push(makeMegapotRewardsJob(sink, megapot));
  return declarations;
}

export default {
  async fetch(request: Request, env: JobsWorkerEnv) {
    return handleMegapotPublicCommitment(request, env.MEGAPOT_COMMITMENTS);
  },
  async scheduled(event: ScheduledEvent, env: JobsWorkerEnv, ctx: ExecutionContext) {
    if (env.CONTROL_PLANE === undefined) {
      throw new Error("CONTROL_PLANE Hyperdrive binding is required for jobs-worker");
    }
    const config = loadJobsWorkerConfig(env);
    const hns = makeHnsRouteRevalidationComposition(env);
    const megapot = makeMegapotOptions(env, config);
    const rpcUrl = fundingRpcUrl(
      Redacted.value(config.COMMUNITY_PURCHASE_FUNDING_RPC_URL),
      config.API_NEXT_ENV,
    );
    const deliveryStub = env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:alerts`);
    const sink = makeConfiguredAlertSink(env, makeAlertDeliveryLedger(deliveryStub));
    const declarations = makeJobsWorkerDeclarations(
      sink,
      rpcUrl,
      hns,
      config.API_NEXT_ENV,
      megapot,
    );
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
    const dueByLane = groupDueJobsByLane(registry, event.scheduledTime);
    const runtime = makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE);
    const mediaMaintenance = makeMediaMaintenance(env, runtime);
    const dataRegistrationMaintenance = makeDataRegistrationMaintenance(env, runtime);
    const scheduledWork: Promise<unknown>[] = Array.from(dueByLane, ([lane, laneJobs]) =>
      handleScheduled(env, lane, laneJobs, event.scheduledTime, { runtime }),
    );
    if (mediaMaintenance !== null) scheduledWork.push(mediaMaintenance());
    if (dataRegistrationMaintenance !== null) {
      scheduledWork.push(dataRegistrationMaintenance());
    }
    if (mediaMaintenance !== null || dataRegistrationMaintenance !== null) {
      scheduledWork.push(
        runSongPipelineOutboxAlertTick(
          sink,
          collectSongPipelineOutboxAlerts(runtime, {
            media: mediaMaintenance !== null,
            data: dataRegistrationMaintenance !== null,
          }),
        ),
      );
    }
    await ctx.waitUntil(Promise.all(scheduledWork));
  },
};
