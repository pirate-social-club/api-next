/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  HNS_ROOT_HEALTH_RENEWAL_JOB,
  HNS_ROOT_HEALTH_RENEWAL_LANE,
} from "../../apps/jobs-worker/src/hns-root-health-renewal";
import jobsWorker, {
  buildJobRegistry,
  groupDueJobsByLane,
  type JobsWorkerEnv,
  makeHnsRouteRevalidationComposition,
  makeJobsWorkerDeclarations,
} from "../../apps/jobs-worker/src/index";

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
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.invalid/",
    CF_VERSION_METADATA: { id: "production-test", tag: "", timestamp: "2026-09-05T00:00:00Z" },
    CRON_LOCK: { getByName } as JobsWorkerEnv["CRON_LOCK"],
    CONTROL_PLANE: { connectionString: "postgres://unused:unused@127.0.0.1:1/unused" },
    ...Object.fromEntries(production.r2_buckets.map(({ binding }) => [binding, {}])),
  };
}

const dueAt = Date.UTC(2026, 8, 5, 17, 30);

describe("production HNS renewal scheduling", () => {
  it("the scheduled handler admits explicitly configured active ownership renewal without recovery", async () => {
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
    expect(acquisitions).toEqual(["scheduled-cron-main:hns-route-revalidation"]);
  });

  it("admits exactly renewal from the complete checked-in production declaration list", async () => {
    const env = productionEnv(() => ({}));
    const ownership = makeHnsRouteRevalidationComposition(env);
    expect(ownership).toEqual({ enabled: false });
    expect(production.triggers.crons).toEqual(["*/30 * * * *"]);
    expect(env.LEARNER_AUDIO).toBeUndefined();
    for (const flag of [
      "COMMUNITY_MAINTENANCE_ENABLED",
      "MEDIA_PROCESSING_ENABLED",
      "VIDEO_ANALYSIS_ENABLED",
      "DATA_REGISTRATION_ENABLED",
      "MEGAPOT_REWARDS_ENABLED",
      "KARAOKE_FINALIZATION_RECOVERY_ENABLED",
    ])
      expect(production.vars[flag]).toBe("false");
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
    expect(declarations.map(({ name }) => name)).toEqual([HNS_ROOT_HEALTH_RENEWAL_JOB]);
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
    expect([...groupDueJobsByLane(registry, dueAt).keys()]).toEqual([HNS_ROOT_HEALTH_RENEWAL_LANE]);
    expect(groupDueJobsByLane(registry, dueAt + 60_000).size).toBe(0);
    expect(
      makeJobsWorkerDeclarations({}, "https://rpc.invalid/", ownership, "production", null, false),
    ).toEqual([]);
  });

  it("the real scheduled handler attempts only the renewal lease with production bindings", async () => {
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
      expect(acquisitions).toEqual([`scheduled-cron-main:${HNS_ROOT_HEALTH_RENEWAL_LANE}`]);
      expect(unexpectedCalls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
