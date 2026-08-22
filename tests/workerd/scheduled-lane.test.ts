/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { type Alert, ControlPlaneDb } from "@pirate/application";
import type { AlertDigest } from "@pirate/platform-cf";
import { Cause, Effect, Exit, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_JOB,
  COMMUNITY_PURCHASE_FUNDING_RECONCILIATION_LANE,
  COMMUNITY_PURCHASE_FUNDING_WRITES,
} from "../../apps/jobs-worker/src/community-purchase-funding";
import {
  defaultRetrySchedule,
  HNS_ROUTE_REVALIDATION_JOB,
  handleScheduled,
  type JobDefinition,
  type JobsWorkerEnv,
  default as jobsWorker,
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
    CRON_LOCK: env.CRON_LOCK,
    CONTROL_PLANE: {
      connectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    },
    API_NEXT_ENV: "development",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.invalid/",
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
    const sink = { email: () => Effect.void, webhook: () => Effect.void };
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
          CONTROL_PLANE: controlPlane,
          API_NEXT_ENV: "staging",
          COMMUNITY_PURCHASE_FUNDING_RPC_URL: "http://rpc.test",
        } as JobsWorkerEnv,
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
    const sink = { email: () => Effect.void, webhook: () => Effect.void };
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

  it("runs the real routing audit, renews its lease, and aggregates alerts", async () => {
    const statements: Array<{ readonly readonly: boolean; readonly text: string }> = [];
    const emails: AlertDigest[] = [];
    const webhooks: Array<readonly Alert[]> = [];
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
    const sink = {
      email: (digest: AlertDigest) => Effect.sync(() => emails.push(digest)),
      webhook: (alerts: readonly Alert[]) => Effect.sync(() => void webhooks.push([...alerts])),
    };
    const job = makeCommunityCatalogIntegrityJob(sink, {
      timeout: 5_000,
    });

    const result = await handleScheduled(env, job.lane, job, 1_000_000, {
      runtime: Layer.succeed(ControlPlaneDb, db),
      leaseTtlMs: 60,
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
    expect(emails).toHaveLength(1);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.every((alert) => alert.severity === "high")).toBe(true);
    expect(webhooks[0]?.every((alert) => !alert.body.includes("$1"))).toBe(true);
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
    const emails: AlertDigest[] = [];
    const digests: AlertDigest[] = [];
    const sink = {
      email: (digest: AlertDigest) => Effect.sync(() => emails.push(digest)),
      digest: (digest: AlertDigest) => Effect.sync(() => digests.push(digest)),
      webhook: () => Effect.void,
    };
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
    expect(emails).toHaveLength(1);
    expect(emails[0]?.groups).toHaveLength(1);
    expect(emails[0]?.groups[0]?.severity).toBe("medium");

    emails.length = 0;
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
    expect(emails).toHaveLength(1);
    expect(emails[0]?.groups[0]?.severity).toBe("high");

    emails.length = 0;
    const expectedHigh: JobDefinition = {
      ...expectedFailure,
      name: "severity.expected-high",
      lane: "severity-expected-high",
      expectedFailures: ["ControlPlaneStatementFailed"],
      run: Effect.fail({ _tag: "ControlPlaneStatementFailed" }),
    };
    await expect(handleScheduled(env, expectedHigh.lane, expectedHigh)).rejects.toBeDefined();
    expect(emails).toHaveLength(1);
    expect(emails[0]?.groups).toHaveLength(1);
    expect(emails[0]?.groups[0]?.severity).toBe("high");

    emails.length = 0;
    const expectedLow: JobDefinition = {
      ...expectedFailure,
      name: "severity.expected-low",
      lane: "severity-expected-low",
      expectedFailures: ["LowExpectedFailure"],
      run: Effect.fail({ _tag: "LowExpectedFailure" }),
    };
    await expect(handleScheduled(env, expectedLow.lane, expectedLow)).rejects.toBeDefined();
    expect(emails).toHaveLength(0);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.groups).toHaveLength(1);
    expect(digests[0]?.groups[0]?.severity).toBe("low");

    digests.length = 0;
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
    expect(emails).toHaveLength(1);
    expect(emails[0]?.groups).toHaveLength(1);
    expect(emails[0]?.groups[0]?.severity).toBe("high");

    emails.length = 0;
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
    expect(emails).toHaveLength(1);
    expect(emails[0]?.groups).toHaveLength(1);
    expect(emails[0]?.groups[0]?.severity).toBe("medium");
  });
});
