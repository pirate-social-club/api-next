/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { ControlPlaneDb } from "@pirate/application";
import type { PipelineLogFields } from "@pirate/platform-cf";
import { Cause, Effect, Exit, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_JOB,
  COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_LANE,
  COMMUNITY_PURCHASE_FUNDING_WRITES,
} from "../../apps/jobs-worker/src/community-purchase-funding";
import {
  buildJobRegistry,
  defaultRetrySchedule,
  HNS_ROUTE_REVALIDATION_JOB,
  handleScheduled,
  type JobDefinition,
  type JobsWorkerEnv,
  default as jobsWorker,
  MEGAPOT_REWARDS_CYCLE_JOB,
  makeCommunityCatalogIntegrityJob,
  makeHnsRouteRevalidationComposition,
  makeJobsWorkerDeclarations,
  runScheduled,
} from "../../apps/jobs-worker/src/index";

const env = testEnv as unknown as JobsWorkerEnv;

const nonDueScheduledEvent = {
  scheduledTime: Date.UTC(2026, 7, 19, 0, 1),
  cron: "*/5 * * * *",
} as ScheduledEvent;

function scheduledWorkerEnv(hns: Partial<JobsWorkerEnv> = {}): JobsWorkerEnv {
  return {
    CF_VERSION_METADATA: {
      id: "worker-version-test",
      tag: "",
      timestamp: "2026-08-30T05:00:00.000Z",
    },
    CRON_LOCK: env.CRON_LOCK,
    CONTROL_PLANE: {
      connectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    },
    API_NEXT_ENV: "development",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.invalid/",
    MEGAPOT_REWARDS_ENABLED: "false",
    MEGAPOT_CHAIN_ID: "84532",
    MEGAPOT_V2_RPC_URL: "https://megapot-rpc.invalid/",
    MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
    MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
    MEGAPOT_OBSERVATION_TTL_SECONDS: "300",
    MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "1000000000",
    MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: "120",
    MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: "12000",
    MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: "1000000000000000",
    MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "5",
    MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "50000000",
    MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "50",
    MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "500000000",
    ...hns,
  };
}

function recordingContext(waits: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
  } as unknown as ExecutionContext;
}

describe("scheduled lane holding a DO lease (workerd)", () => {
  it("registers the bounded funding reconciler as the only writer for its tables", () => {
    const sink = {};
    const declarations = makeJobsWorkerDeclarations(sink, "https://rpc.test/");
    const funding = declarations.find(
      (declaration) => declaration.name === COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_JOB,
    );

    expect(funding?.lane).toBe(COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_LANE);
    expect(funding?.writes).toEqual(COMMUNITY_PURCHASE_FUNDING_WRITES);
    expect(funding?.requiresAdapterSafety).toBe(true);
    const fundingWrites = new Set<string>(COMMUNITY_PURCHASE_FUNDING_WRITES);
    expect(
      declarations.filter((declaration) =>
        declaration.writes.some((table) => fundingWrites.has(table)),
      ),
    ).toEqual([funding]);
  });

  it("registers the Megapot custody machine as one exclusive writer lane", async () => {
    const sink = {};
    const declarations = makeJobsWorkerDeclarations(
      sink,
      "https://rpc.test/",
      { enabled: false },
      "development",
      {
        environment: "development",
        workerVersion: {
          id: "worker-version-test",
          tag: "",
          timestamp: "2026-08-30T05:00:00.000Z",
        },
        attestationId: "megapot-base-sepolia-v2",
        rpcUrl: "https://megapot-rpc.test/",
        custodyPrivateKey: `0x${"1".repeat(64)}`,
        commitmentBucket: {
          get: async () => null,
          put: async () => ({ uploaded: new Date() }),
        },
        commitmentPublicOrigin: "https://commitments.test",
        requiredConfirmations: 3,
        observationTtlMs: 300_000,
        approvedAllowanceAtomic: 1_000_000_000n,
        purchaseSafetyMarginSeconds: 120,
        gasLimitMultiplierBps: 12_000,
        nativeGasReserveFloorWei: 1_000_000_000_000_000n,
        externalSponsorDailyTicketCeiling: 5,
        externalSponsorDailySpendCeilingAtomic: 50_000_000n,
        sharedSponsorDailyTicketCeiling: 50,
        sharedSponsorDailySpendCeilingAtomic: 500_000_000n,
      },
    );
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
    expect(registry.byName.get(MEGAPOT_REWARDS_CYCLE_JOB)?.lane).toBe("megapot-rewards");
    expect(
      declarations.filter((declaration) =>
        declaration.writes.includes("postgres:reward_chain_effects"),
      ),
    ).toEqual([registry.byName.get(MEGAPOT_REWARDS_CYCLE_JOB)]);
  });

  it("fails closed before registry or database work when funding RPC config is invalid", async () => {
    const scheduledEvent = {
      scheduledTime: Date.UTC(2026, 7, 19),
      cron: "*/5 * * * *",
    } as ScheduledEvent;
    const context = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const controlPlane = {} as NonNullable<JobsWorkerEnv["CONTROL_PLANE"]>;

    await expect(
      jobsWorker.scheduled(
        scheduledEvent,
        { CONTROL_PLANE: controlPlane } as JobsWorkerEnv,
        context,
      ),
    ).rejects.toThrow("Jobs worker configuration is incomplete or invalid");
    await expect(
      jobsWorker.scheduled(
        scheduledEvent,
        {
          ...scheduledWorkerEnv(),
          CONTROL_PLANE: controlPlane,
          COMMUNITY_PURCHASE_FUNDING_RPC_URL: "http://rpc.test",
        },
        context,
      ),
    ).rejects.toThrow("Jobs worker configuration is incomplete or invalid");
    await expect(
      jobsWorker.scheduled(
        scheduledEvent,
        scheduledWorkerEnv({
          MEGAPOT_REWARDS_ENABLED: "true",
          MEGAPOT_COMMITMENTS: {} as R2Bucket,
          MEGAPOT_CUSTODY_PRIVATE_KEY: `0x${"1".repeat(64)}`,
          MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: "https://commitments.test/",
          MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: "0",
        }),
        context,
      ),
    ).rejects.toThrow("Jobs worker configuration is incomplete or invalid");
  });

  it("keeps HNS disabled when scheduled without HNS configuration or a verifier binding", async () => {
    const waits: Promise<unknown>[] = [];
    const workerEnv = scheduledWorkerEnv();

    await jobsWorker.scheduled(nonDueScheduledEvent, workerEnv, recordingContext(waits));
    expect(waits).toHaveLength(1);
    await Promise.all(waits);

    const hns = makeHnsRouteRevalidationComposition(workerEnv);
    expect(hns).toEqual({ enabled: false });
    const sink = {};
    const declarations = makeJobsWorkerDeclarations(
      sink,
      "https://rpc.invalid/",
      hns,
      "development",
    );
    expect(
      declarations.some((declaration) => declaration.name === HNS_ROUTE_REVALIDATION_JOB),
    ).toBe(false);
    for (const binding of [
      "HNS_OWNER_VERIFIER",
      "HNS_OWNERSHIP_ENABLED",
      "HNS_OWNERSHIP_CONFIGURATION_REFERENCE",
      "HNS_OWNERSHIP_CONFIGURATION_VERSION",
    ]) {
      expect(binding in workerEnv).toBe(false);
    }
  });

  it("does not query song outbox alerts when both media runtimes are disabled", async () => {
    const waits: Promise<unknown>[] = [];
    const workerEnv = scheduledWorkerEnv({
      MEDIA_PROCESSING_ENABLED: "false",
      DATA_REGISTRATION_ENABLED: "false",
    });

    await jobsWorker.scheduled(nonDueScheduledEvent, workerEnv, recordingContext(waits));
    expect(waits).toHaveLength(1);
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });

  it("declares database-time expiry under the sole HNS route-binding writer when enabled", () => {
    const hns = makeHnsRouteRevalidationComposition({
      HNS_OWNER_VERIFIER: {
        fetch: async () => new Response(null, { status: 204 }),
      },
      HNS_OWNERSHIP_ENABLED: "true",
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-test",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
    });
    expect(hns.enabled).toBe(true);
    const sink = {};
    const declarations = makeJobsWorkerDeclarations(
      sink,
      "https://rpc.invalid/",
      hns,
      "development",
    );
    const hnsJob = declarations.find(
      (declaration) => declaration.name === HNS_ROUTE_REVALIDATION_JOB,
    );
    expect(hnsJob?.writes).toContain("postgres:community_route_lifecycle_transitions");
    expect(hnsJob?.writes).toContain("postgres:community_canonical_route_bindings");
    expect(
      declarations.filter((declaration) =>
        declaration.writes.includes("postgres:community_canonical_route_bindings"),
      ),
    ).toEqual([hnsJob]);
  });

  it("fails closed before scheduling when HNS is enabled without its verifier authority", async () => {
    const waits: Promise<unknown>[] = [];
    const workerEnv = scheduledWorkerEnv({ HNS_OWNERSHIP_ENABLED: "true" });

    await expect(
      jobsWorker.scheduled(nonDueScheduledEvent, workerEnv, recordingContext(waits)),
    ).rejects.toThrow("Jobs worker HNS route-revalidation configuration is incomplete or invalid");
    expect(waits).toHaveLength(0);
  });

  it("runs exactly one concurrent tick per lane; loser runs nothing", async () => {
    let ran = 0;
    const job: JobDefinition = {
      name: "spike.lane-probe",
      lane: "spike-lane",
      schedule: "*/5 * * * *",
      timeout: 5_000,
      retry: defaultRetrySchedule,
      expectedFailures: [],
      severity: {
        expectedFailure: {},
        timeout: "low",
        transactionOutcomeUnknown: "high",
        defect: "high",
      },
      reads: [],
      writes: [],
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

  it("runs multiple jobs in one lane sequentially under one lease", async () => {
    const order: string[] = [];
    const makeJob = (name: string): JobDefinition => ({
      name,
      lane: "sequential-lane",
      schedule: "*/5 * * * *",
      timeout: 5_000,
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
        order.push(`${name}:start`);
        yield* Effect.sleep(30);
        order.push(`${name}:end`);
      }),
    });

    const result = await handleScheduled(env, "sequential-lane", [
      makeJob("first"),
      makeJob("second"),
    ]);

    expect(result.ranJobs).toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(result.leaseAfterRun).toBeNull();
  });

  it("drains an in-flight renewal before releasing its latest fence", async () => {
    let renewalStarted!: () => void;
    const renewalStartedPromise = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let renewalCompleted = false;
    let releasedGeneration: number | null = null;
    const stub = {
      tryAcquireWithFence: async (_ttlMs: number, owner: string, now: number) => ({
        owner,
        expiresAt: now + 1_000,
        generation: 1,
      }),
      renew: async (_ttlMs: number, owner: string, generation: number, now: number) => {
        expect(generation).toBe(1);
        renewalStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
        renewalCompleted = true;
        return { owner, expiresAt: now + 1_000, generation: 2 };
      },
      releaseWithFence: async (_owner: string, generation: number) => {
        expect(renewalCompleted).toBe(true);
        releasedGeneration = generation;
        return generation === 2;
      },
      currentLease: async () => null,
    };
    const fakeEnv = {
      CRON_LOCK: {
        getByName: () => stub,
      },
    } as unknown as JobsWorkerEnv;
    const job: JobDefinition = {
      name: "spike.in-flight-renewal",
      lane: "in-flight-renewal-lane",
      schedule: "*/5 * * * *",
      timeout: 5_000,
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
      run: Effect.promise(() => renewalStartedPromise),
    };

    const result = await handleScheduled(fakeEnv, job.lane, job, Date.now(), {
      leaseTtlMs: 1_000,
      renewIntervalMs: 1,
      renewDeadlineMs: 100,
    });

    expect(result.acquired).toBe(true);
    expect(releasedGeneration).toBe(2);
    expect(result.leaseAfterRun).toBeNull();
  });

  it("bounds a stuck renewal and skips release with unknown fence authority", async () => {
    let renewalStarted!: () => void;
    const renewalStartedPromise = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let releaseCalls = 0;
    const stub = {
      tryAcquireWithFence: async (_ttlMs: number, owner: string, now: number) => ({
        owner,
        expiresAt: now + 1_000,
        generation: 1,
      }),
      renew: async () => {
        renewalStarted();
        return new Promise<never>(() => undefined);
      },
      releaseWithFence: async () => {
        releaseCalls += 1;
        return true;
      },
      currentLease: async () => null,
    };
    const fakeEnv = {
      CRON_LOCK: {
        getByName: () => stub,
      },
    } as unknown as JobsWorkerEnv;
    const job: JobDefinition = {
      name: "spike.stuck-renewal",
      lane: "stuck-renewal-lane",
      schedule: "*/5 * * * *",
      timeout: 5_000,
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
      run: Effect.promise(() => renewalStartedPromise),
    };

    await expect(
      handleScheduled(fakeEnv, job.lane, job, Date.now(), {
        leaseTtlMs: 1_000,
        renewIntervalMs: 1,
        renewDeadlineMs: 20,
      }),
    ).rejects.toMatchObject({ _tag: "LaneLeaseLost" });
    expect(releaseCalls).toBe(0);
  });

  it("runs the real routing audit, renews its lease, and aggregates alerts", async () => {
    const statements: Array<{ readonly readonly: boolean; readonly text: string }> = [];
    const logs: PipelineLogFields[] = [];
    const rows = [
      { violation: "blank_display_name", violation_count: 2 },
      { violation: "updated_before_created", violation_count: 1 },
    ];
    const db = {
      execute: (statement: { readonly readonly: boolean; readonly text: string }) => {
        statements.push(statement);
        return Effect.gen(function* () {
          yield* Effect.sleep(80);
          return { rows, rowCount: rows.length };
        });
      },
      withTransaction: () => Effect.die("routing audit must remain read-only"),
    } as unknown as ControlPlaneDb["Service"];
    const sink = { log: (_event: string, fields: PipelineLogFields) => logs.push(fields) };
    const job = {
      ...makeCommunityCatalogIntegrityJob(sink, { timeout: 5_000 }),
      // Workerd test files share the DO namespace and can run concurrently.
      lane: "workerd-routing-audit-renewal",
    };

    const result = await handleScheduled(env, job.lane, job, Date.now(), {
      runtime: Layer.succeed(ControlPlaneDb, db),
      // Keep enough expiry margin for loaded CI runners while the short
      // renewal cadence still proves that the heartbeat runs during the job.
      leaseTtlMs: 1_000,
      renewIntervalMs: 20,
    });

    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.leaseRenewals).toBeGreaterThan(0);
    expect(result.leaseAfterRun).toBeNull();
    expect(statements[0]?.readonly).toBe(true);
    expect(statements[0]?.text).toContain("FROM communities");
    expect(statements[0]?.text).not.toContain("community_database_routing");
    expect(statements[0]?.text).not.toContain("backend = 'd1'");
    expect(logs).toHaveLength(2);
    expect(logs.every((fields) => fields.event === "pipeline.alert")).toBe(true);
    expect(
      logs.every((fields) => fields.event !== "pipeline.alert" || fields.severity === "high"),
    ).toBe(true);
  });

  it("interrupts in-flight work and refuses release when lease renewal is lost", async () => {
    let interrupted = false;
    let released = false;
    const lease = { owner: "owner", expiresAt: Date.now() + 100, generation: 1 };
    const stub = {
      tryAcquireWithFence: async () => lease,
      renew: async () => null,
      releaseWithFence: async () => {
        released = true;
        return true;
      },
      currentLease: async () => lease,
    };
    const leaseEnv = {
      CRON_LOCK: { getByName: () => stub },
    } as unknown as JobsWorkerEnv;
    const job: JobDefinition = {
      name: "lease-loss.interruption",
      lane: "lease-loss",
      schedule: "*/5 * * * *",
      timeout: 5_000,
      retry: Schedule.recurs(0),
      expectedFailures: [],
      severity: {
        expectedFailure: {},
        timeout: "high",
        transactionOutcomeUnknown: "high",
        defect: "high",
      },
      reads: [],
      writes: [],
      run: Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    };

    const exit = await Effect.runPromise(
      Effect.exit(
        runScheduled(leaseEnv, job.lane, job, Date.now(), {
          leaseTtlMs: 100,
          renewIntervalMs: 10,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error) ? error.value : undefined).toMatchObject({
        _tag: "LaneLeaseLost",
      });
    }
    expect(interrupted).toBe(true);
    expect(released).toBe(false);
  });

  it("routes expected failures, defects, and runner timeouts through declared severity", async () => {
    const logs: PipelineLogFields[] = [];
    const sink = { log: (_event: string, fields: PipelineLogFields) => logs.push(fields) };
    const severity = {
      expectedFailure: {
        ControlPlaneOperationTimedOut: "medium" as const,
        ControlPlaneStatementFailed: "high" as const,
        LowExpectedFailure: "low" as const,
      },
      timeout: "medium" as const,
      transactionOutcomeUnknown: "high" as const,
      defect: "high" as const,
    };
    const expectedFailure: JobDefinition = {
      name: "severity.expected-failure",
      lane: "severity-expected-failure",
      schedule: "*/5 * * * *",
      timeout: 5_000,
      retry: Schedule.recurs(0),
      expectedFailures: ["ControlPlaneOperationTimedOut"],
      severity,
      reads: [],
      writes: [],
      alertSink: sink,
      run: Effect.fail({ _tag: "ControlPlaneOperationTimedOut" }),
    };
    await expect(handleScheduled(env, expectedFailure.lane, expectedFailure)).rejects.toBeDefined();
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "medium" });

    const ambiguous: JobDefinition = {
      ...expectedFailure,
      name: "severity.transaction-ambiguity",
      lane: "severity-transaction-ambiguity",
      expectedFailures: [],
      severity: {
        ...severity,
        transactionOutcomeUnknown: "high",
      },
      run: Effect.fail({ _tag: "ControlPlaneOperationTimedOut", outcomeCertainty: "unknown" }),
    };
    await expect(handleScheduled(env, ambiguous.lane, ambiguous)).rejects.toBeDefined();
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "high" });
    const expectedHigh: JobDefinition = {
      ...expectedFailure,
      name: "severity.expected-high",
      lane: "severity-expected-high",
      expectedFailures: ["ControlPlaneStatementFailed"],
      run: Effect.fail({ _tag: "ControlPlaneStatementFailed" }),
    };
    await expect(handleScheduled(env, expectedHigh.lane, expectedHigh)).rejects.toBeDefined();
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "high" });
    const expectedLow: JobDefinition = {
      ...expectedFailure,
      name: "severity.expected-low",
      lane: "severity-expected-low",
      expectedFailures: ["LowExpectedFailure"],
      run: Effect.fail({ _tag: "LowExpectedFailure" }),
    };
    await expect(handleScheduled(env, expectedLow.lane, expectedLow)).rejects.toBeDefined();
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "low" });

    const defect: JobDefinition = {
      name: "severity.defect",
      lane: "severity-defect",
      schedule: "*/5 * * * *",
      timeout: 5_000,
      retry: Schedule.recurs(0),
      expectedFailures: [],
      severity,
      reads: [],
      writes: [],
      alertSink: sink,
      run: Effect.die("test defect"),
    };
    await expect(handleScheduled(env, defect.lane, defect)).rejects.toBeDefined();
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "high" });
    const timeout: JobDefinition = {
      name: "severity.runner-timeout",
      lane: "severity-runner-timeout",
      schedule: "*/5 * * * *",
      timeout: 25,
      retry: Schedule.recurs(0),
      expectedFailures: [],
      severity,
      reads: [],
      writes: [],
      alertSink: sink,
      run: Effect.forever(Effect.sleep(10)),
    };
    const timeoutResult = await handleScheduled(env, timeout.lane, timeout);
    expect(timeoutResult.timedOut).toBe(true);
    expect(logs.at(-1)).toMatchObject({ event: "pipeline.alert", severity: "medium" });
  });
});
