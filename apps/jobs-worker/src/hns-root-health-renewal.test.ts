import { describe, expect, test } from "bun:test";
import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect } from "effect";
import {
  HNS_ROOT_HEALTH_HEARTBEAT_FRESHNESS_SECONDS,
  HNS_ROOT_HEALTH_RENEW_WHEN_REMAINING_SECONDS,
  HNS_ROOT_HEALTH_RENEWAL_BATCH_LIMIT,
  makeHnsRootHealthRenewalJob,
} from "./hns-root-health-renewal";
import { JobContext } from "./registry";

const sink: AlertSink = {
  log: () => undefined,
  delivery: {
    markSent: () => Effect.succeed(true),
    compensate: () => Effect.void,
  },
};

describe("HNS root health renewal scheduler", () => {
  test("schedules day-four successors and records the heartbeat in one fenced write", async () => {
    const statements: Array<
      Readonly<{ readonly text: string; readonly values: readonly unknown[] }>
    > = [];
    const job = makeHnsRootHealthRenewalJob(sink);
    const db = {
      execute: <Row>(statement: { readonly text: string; readonly values: readonly unknown[] }) =>
        Effect.sync(() => {
          statements.push(statement);
          return {
            rows: [
              { eligible_roots: 2, enqueued_roots: 1, successful_tick_at: new Date() },
            ] as Row[],
            rowCount: 1,
          };
        }),
      withTransaction: () => Effect.die("scheduler must use its atomic database function"),
    } as unknown as ControlPlaneDb["Service"];

    await Effect.runPromise(
      job.run.pipe(
        Effect.provideService(ControlPlaneDb, db),
        Effect.provideService(AlertCollector, { emit: () => Effect.void }),
        Effect.provideService(JobContext, {
          adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
          attemptId: "attempt-1",
          lease: () => ({ expiresAt: Date.now() + 60_000, generation: 1, owner: "test-owner" }),
          owner: "test-owner",
        }),
      ),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain("schedule_hns_root_health_renewals_v1");
    expect(statements[0]?.values).toEqual([
      HNS_ROOT_HEALTH_RENEWAL_BATCH_LIMIT,
      HNS_ROOT_HEALTH_RENEW_WHEN_REMAINING_SECONDS,
      HNS_ROOT_HEALTH_HEARTBEAT_FRESHNESS_SECONDS,
    ]);
    expect(job.writes).toEqual([
      "postgres:hns_root_health_renewal_jobs",
      "postgres:hns_root_health_renewal_scheduler_heartbeat",
    ]);
  });
});
