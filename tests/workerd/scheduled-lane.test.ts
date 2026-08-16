/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { type Alert, ControlPlaneDb } from "@pirate/application";
import type { AlertDigest } from "@pirate/platform-cf";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  defaultRetrySchedule,
  handleScheduled,
  type JobDefinition,
  type JobsWorkerEnv,
  makeCommunityRoutingIntegrityJob,
} from "../../apps/jobs-worker/src/index";

const env = testEnv as unknown as JobsWorkerEnv;

describe("scheduled lane holding a DO lease (workerd)", () => {
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

  it("runs the real routing audit, renews its lease, and aggregates alerts", async () => {
    const statements: Array<{ readonly readonly: boolean; readonly text: string }> = [];
    const emails: AlertDigest[] = [];
    const webhooks: Array<readonly Alert[]> = [];
    const rows = [
      { violation: "stuck_provisioning", violation_count: 2 },
      { violation: "ready_missing_binding", violation_count: 1 },
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
    const job = makeCommunityRoutingIntegrityJob(sink, {
      now: () => 1_000_000,
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
    expect(statements[0]?.text).toContain("community_database_routing");
    expect(statements[0]?.text).toContain("backend = 'd1'");
    expect(emails).toHaveLength(1);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.every((alert) => alert.severity === "high")).toBe(true);
    expect(webhooks[0]?.every((alert) => !alert.body.includes("$1"))).toBe(true);
  });
});
