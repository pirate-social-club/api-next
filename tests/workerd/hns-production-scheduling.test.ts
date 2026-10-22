/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  HNS_ROOT_HEALTH_RENEWAL_JOB,
  HNS_ROOT_HEALTH_RENEWAL_LANE,
} from "../../apps/jobs-worker/src/hns-root-health-renewal";
import jobsWorker, {
  buildJobRegistry,
  groupDueJobsByLane,
  handleScheduled,
  type JobsWorkerEnv,
  makeHnsRouteRevalidationComposition,
  makeJobsWorkerDeclarations,
} from "../../apps/jobs-worker/src/index";
import { MEGAPOT_REWARDS_CYCLE_LANE } from "../../apps/jobs-worker/src/megapot-rewards-cycle";
import {
  STUDY_SPOKEN_ANSWER_RECOVERY_JOB,
  STUDY_SPOKEN_ANSWER_RECOVERY_LANE,
} from "../../apps/jobs-worker/src/study-spoken-answer-recovery";

const production = JSON.parse(
  (testEnv as unknown as { PRODUCTION_JOBS_CONFIGURATION: string }).PRODUCTION_JOBS_CONFIGURATION,
) as {
  vars: Record<string, string>;
  triggers: { crons: string[] };
  r2_buckets: Array<{ binding: string }>;
};

function productionEnv(getByName: (name: string) => unknown): JobsWorkerEnv {
  return {
    ...production.vars,
    // These tests isolate HNS and learner recovery from other v1 lanes.
    MEDIA_PROCESSING_ENABLED: "false",
    VIDEO_ANALYSIS_ENABLED: "false",
    VIDEO_DELIVERY_ENABLED: "false",
    SONG_VIDEO_PCM_ADMISSION_ENABLED: "false",
    KARAOKE_FINALIZATION_RECOVERY_ENABLED: "false",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.invalid/",
    CF_VERSION_METADATA: { id: "production-test", tag: "", timestamp: "2026-09-05T00:00:00Z" },
    CRON_LOCK: { getByName } as JobsWorkerEnv["CRON_LOCK"],
    CONTROL_PLANE: { connectionString: "postgres://unused:unused@127.0.0.1:1/unused" },
    ...Object.fromEntries(production.r2_buckets.map(({ binding }) => [binding, {}])),
  };
}

const dueAt = Date.UTC(2026, 8, 5, 17, 30);

describe("production HNS renewal scheduling", () => {
  it("runs the registered Notifications handler through the kernel and its real DO lease", async () => {
    const statements: ControlPlaneStatement[] = [];
    const db: ControlPlaneDb["Service"] = {
      execute: () => Effect.die("Notifications recovery must remain transactional"),
      withTransaction: (use) =>
        use({
          execute: <Row>(statement: ControlPlaneStatement) => {
            statements.push(statement);
            const rows: unknown[] =
              statement.label === "notifications.recover.facts"
                ? [{ outbox_event_id: "workerd-notification-fact" }]
                : [{ result: { processed: true, delivered: true } }];
            return Effect.succeed({ rows: rows as Row[], rowCount: rows.length });
          },
        }),
    };
    const [job] = makeJobsWorkerDeclarations(
      {},
      "https://rpc.invalid/",
      { enabled: false },
      "production",
      null,
      false,
    );
    if (!job) throw new Error("Notifications declaration required");
    expect(job.name).toBe("notifications.recover-publications");
    const locks = (testEnv as unknown as { CRON_LOCK: JobsWorkerEnv["CRON_LOCK"] }).CRON_LOCK;
    const env = productionEnv((name) => locks.getByName(name));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Notifications inbox recovery must not call a provider");
    });
    try {
      const result = await handleScheduled(env, job.lane, job, Date.now(), {
        runtime: Layer.succeed(ControlPlaneDb, db),
      });
      expect(result.acquired).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.leaseAfterRun).toBeNull();
      expect(
        statements.map(({ label, readonly, values }) => ({ label, readonly, values })),
      ).toEqual([
        { label: "notifications.recover.facts", readonly: true, values: [] },
        { label: "notifications.deliver", readonly: false, values: ["workerd-notification-fact"] },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["false", "true"] as const)(
    "the real handler admits Notifications, Account Study and HNS with Rewards %s and guest serving off",
    async (rewardsEnabled) => {
      const acquisitions: string[] = [];
      const workerEnv: JobsWorkerEnv & { GUEST_STUDY_SERVING_ENABLED: "false" } = {
        ...productionEnv((name) => ({
          tryAcquireWithFence: async () => {
            acquisitions.push(name);
            return null;
          },
        })),
        API_NEXT_ENV: "staging",
        MEGAPOT_REWARDS_ENABLED: rewardsEnabled,
        MEGAPOT_CHAIN_ID: "84532",
        ...(rewardsEnabled === "true"
          ? {
              MEGAPOT_V2_RPC_URL: "https://rpc.invalid/",
              MEGAPOT_CUSTODY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
              MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: "https://commitments.invalid",
              MEGAPOT_COMMITMENTS: {} as R2Bucket,
            }
          : {}),
        GUEST_STUDY_SERVING_ENABLED: "false",
      };
      const waits: Promise<unknown>[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("Refused leases must not perform provider work");
      });
      try {
        expect(workerEnv.LEARNER_AUDIO).toBeDefined();
        expect(workerEnv.HNS_ROOT_HEALTH_RENEWAL_ENABLED).toBe("true");
        expect(workerEnv.GUEST_STUDY_SERVING_ENABLED).toBe("false");
        await jobsWorker.scheduled(
          { scheduledTime: dueAt, cron: production.triggers.crons[0] } as ScheduledEvent,
          workerEnv,
          {
            waitUntil: (promise: Promise<unknown>) => waits.push(promise),
          } as unknown as ExecutionContext,
        );
        await Promise.all(waits);
        expect(acquisitions.sort()).toEqual([
          `scheduled-cron-main:${HNS_ROOT_HEALTH_RENEWAL_LANE}`,
          `scheduled-cron-main:${rewardsEnabled === "true" ? MEGAPOT_REWARDS_CYCLE_LANE : STUDY_SPOKEN_ANSWER_RECOVERY_LANE}`,
          "scheduled-cron-main:notification-delivery",
        ]);
        expect(waits).toHaveLength(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
  it("active ownership renewal retains its separate lane alongside learner-audio recovery", async () => {
    const acquisitions: string[] = [];
    const env: JobsWorkerEnv = {
      ...productionEnv((name) => ({
        tryAcquireWithFence: async () => {
          acquisitions.push(name);
          return null;
        },
      })),
      HNS_ROOT_HEALTH_RENEWAL_ENABLED: "false",
      HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "true",
      HNS_ROUTE_RENEWAL_LEAD_SECONDS: "900",
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-observer-regtest",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-observer-config-v1",
      HNS_OWNER_VERIFIER: {
        fetch: async () => {
          throw new Error("Declined lease must not call verifier");
        },
      },
    };
    const waits: Promise<unknown>[] = [];
    await jobsWorker.scheduled(
      { scheduledTime: dueAt, cron: "*/5 * * * *" } as ScheduledEvent,
      env,
      {
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(acquisitions.sort()).toEqual([
      "scheduled-cron-main:hns-route-revalidation",
      `scheduled-cron-main:${STUDY_SPOKEN_ANSWER_RECOVERY_LANE}`,
      "scheduled-cron-main:notification-delivery",
    ]);
  });

  it("keeps HNS and learner recovery independently selectable with the v1 minute wakeup", async () => {
    const env = productionEnv(() => ({}));
    const ownership = makeHnsRouteRevalidationComposition(env);
    expect(ownership).toEqual({ enabled: false });
    expect(production.triggers.crons).toEqual(["* * * * *"]);
    expect(env.LEARNER_AUDIO).toBeDefined();
    for (const flag of [
      "COMMUNITY_MAINTENANCE_ENABLED",
      "DATA_REGISTRATION_ENABLED",
      "MEGAPOT_REWARDS_ENABLED",
    ])
      expect(production.vars[flag]).toBe("false");
    for (const flag of [
      "MEDIA_PROCESSING_ENABLED",
      "VIDEO_ANALYSIS_ENABLED",
      "VIDEO_DELIVERY_ENABLED",
      "SONG_VIDEO_PCM_ADMISSION_ENABLED",
      "KARAOKE_FINALIZATION_RECOVERY_ENABLED",
    ]) {
      expect(production.vars[flag]).toBe("true");
      expect(env[flag as keyof JobsWorkerEnv]).toBe("false");
    }
    const declarations = makeJobsWorkerDeclarations(
      {},
      "https://rpc.invalid/",
      ownership,
      "production",
      null,
      env.COMMUNITY_MAINTENANCE_ENABLED === "true",
      env.LEARNER_AUDIO,
      undefined,
      env.HNS_ROOT_HEALTH_RENEWAL_ENABLED === "true",
    );
    expect(declarations.map(({ name }) => name)).toEqual([
      "notifications.recover-publications",
      HNS_ROOT_HEALTH_RENEWAL_JOB,
      STUDY_SPOKEN_ANSWER_RECOVERY_JOB,
    ]);
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
    expect([...groupDueJobsByLane(registry, dueAt).keys()]).toEqual([
      "notification-delivery",
      HNS_ROOT_HEALTH_RENEWAL_LANE,
      STUDY_SPOKEN_ANSWER_RECOVERY_LANE,
    ]);
    expect([...groupDueJobsByLane(registry, dueAt + 60_000).keys()]).toEqual([
      "notification-delivery",
      STUDY_SPOKEN_ANSWER_RECOVERY_LANE,
    ]);
    expect(
      makeJobsWorkerDeclarations(
        {},
        "https://rpc.invalid/",
        ownership,
        "production",
        null,
        false,
      ).map(({ name, lane }) => ({ name, lane })),
    ).toEqual([{ name: "notifications.recover-publications", lane: "notification-delivery" }]);
  });

  it("the real handler attempts Notifications, HNS and learner recovery leases, with no effects on refusal", async () => {
    const acquisitions: string[] = [];
    const unexpectedCalls: string[] = [];
    const env = productionEnv((name) => ({
      tryAcquireWithFence: async () => {
        acquisitions.push(name);
        return null;
      },
      markSent: async () => {
        unexpectedCalls.push("alert-or-balance");
        throw new Error("unexpected side effect");
      },
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      unexpectedCalls.push("fetch");
      throw new Error("unrelated external work must stay disabled");
    });
    const waits: Promise<unknown>[] = [];
    try {
      await jobsWorker.scheduled(
        { scheduledTime: dueAt, cron: production.triggers.crons[0] } as ScheduledEvent,
        env,
        {
          waitUntil: (promise: Promise<unknown>) => waits.push(promise),
        } as unknown as ExecutionContext,
      );
      await Promise.all(waits);
      expect(acquisitions.sort()).toEqual([
        `scheduled-cron-main:${HNS_ROOT_HEALTH_RENEWAL_LANE}`,
        `scheduled-cron-main:${STUDY_SPOKEN_ANSWER_RECOVERY_LANE}`,
        "scheduled-cron-main:notification-delivery",
      ]);
      expect(waits).toHaveLength(1);
      expect(unexpectedCalls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
