import { expect, test } from "bun:test";
import { HnsStagingPostMigrationRefused } from "./staging-hns-post-migration-entry.ts";
import type { KaraokeReleaseSurface } from "./staging-karaoke-release-operation.ts";
import {
  executeStagingResetRelease,
  StagingResetReleaseFailure,
} from "./staging-reset-release-executor.ts";

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof StagingResetReleaseFailure) return error;
    throw error;
  }
  throw new Error("expected a structured failure");
}

// Synthetic directives, not a reviewed live restoration plan.
const plan = {
  version: "staging-karaoke-release-plan-v2",
  ingressApplicationId: "a".repeat(32),
  resumeQueues: [{ name: "queue", id: "b".repeat(32) }],
  servingWorkers: [{ worker: "fixture-worker", versionId: "c".repeat(32) }],
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["versions", "database", "ingress", "producers"],
};

// The entry point's own result and refusal shapes, as the live call returns
// them: the executor must pass them through rather than restate them.
const hnsSteps = [
  "target_and_ledger",
  "identities",
  "grants",
  "privilege_matrix",
  "bundle",
  "probe",
  "service",
  "schema_compatibility",
  "service_identity",
  "executor_progress",
] as const;

const hnsAppliedResult = {
  outcome: "post_migration_applied" as const,
  attempt_id: "attempt-0dd71225",
  results: hnsSteps.map((step) => ({ step, result: { step } })),
};

const hnsPreStartRefusal = {
  outcome: "post_migration_refused" as const,
  step: "probe" as const,
  reason: "probe_seed_failed",
  completed_results: [{ step: "target_and_ledger" as const, result: { applied_migrations: 172 } }],
};

const hnsServiceStartRefusal = {
  outcome: "post_migration_refused" as const,
  step: "service" as const,
  reason: "service_start_failed",
  completed_results: [{ step: "probe" as const, result: { seeded: true } }],
};

const hnsPostStartRefusal = {
  outcome: "post_migration_refused" as const,
  step: "service_identity" as const,
  reason: "service_never_started",
  completed_results: [{ step: "service" as const, result: { started: true } }],
  service_disposition: {
    unit: "pirate-hns-authority-provisioner-staging.service",
    started: true as const,
    disposition: "started_unverified" as const,
    attempt_id: "attempt-0dd71225",
  },
  recovery: {
    resumable: true as const,
    stop_service_before_rerun: true as const,
    attempt_id: "attempt-0dd71225",
  },
};

function harness(
  options: {
    failSurface?: KaraokeReleaseSurface;
    completionFails?: boolean;
    acceptanceFails?: boolean;
    refenceIngressFails?: boolean;
    refenceDatabaseFails?: boolean;
    refenceProducersFails?: boolean;
    refenceServiceFails?: boolean;
    skipServicePort?: boolean;
    throwOnAttempt?: KaraokeReleaseSurface;
    recoveryReportFails?: boolean;
    hnsOutcome?:
      | "applied"
      | "refused-pre-start"
      | "refused-service-start"
      | "refused-after-start"
      | "thrown";
    surfaceOrder?: readonly KaraokeReleaseSurface[];
  } = {},
) {
  const calls: string[] = [];
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 8, 9, 12, 0, clock++)).toISOString();
  const make = (surface: KaraokeReleaseSurface) => async (_: unknown, at: () => string) => {
    calls.push(`surface:${surface}`);
    if (options.failSurface === surface) throw new Error(`surface ${surface} failed`);
    return { surface, releasedAt: at(), receipt: `${surface}-receipt` };
  };
  const state = {
    calls,
    recovered: [] as unknown[],
    servingPairVerified: false,
    outcome: undefined as Awaited<ReturnType<typeof executeStagingResetRelease>> | undefined,
  };
  const hnsOutcome = options.hnsOutcome;
  const run = () =>
    executeStagingResetRelease({
      plan:
        options.surfaceOrder === undefined ? plan : { ...plan, surfaceOrder: options.surfaceOrder },
      now,
      onAttempt: (record) => {
        if (record.phase === "intent" && options.throwOnAttempt === record.surface)
          throw new Error("journal write failed");
      },
      surfaces: {
        versions: make("versions"),
        database: make("database"),
        ingress: make("ingress"),
        producers: make("producers"),
      },
      reset: {
        async completeAfterPairedRelease(verifyServingPair) {
          calls.push("reset:completion");
          if (options.completionFails) throw new Error("reset completion refused");
          await verifyServingPair();
          state.servingPairVerified = true;
        },
      },
      async acceptance() {
        calls.push("acceptance");
        if (options.acceptanceFails) throw new Error("persona contract rejected");
      },
      onRecovery: (refenced) => {
        state.recovered.push(refenced);
        if (options.recoveryReportFails) throw new Error("recovery journal write failed");
      },
      ...(hnsOutcome === undefined
        ? {}
        : {
            hns: {
              async run() {
                calls.push("hns:run");
                switch (hnsOutcome) {
                  case "applied":
                    return hnsAppliedResult;
                  case "refused-pre-start":
                    throw new HnsStagingPostMigrationRefused(hnsPreStartRefusal);
                  case "refused-service-start":
                    throw new HnsStagingPostMigrationRefused(hnsServiceStartRefusal);
                  case "refused-after-start":
                    throw new HnsStagingPostMigrationRefused(hnsPostStartRefusal);
                  case "thrown":
                    throw new Error("hns transport lost");
                  default:
                    throw new Error("unreachable hns outcome");
                }
              },
            },
          }),
      refence: {
        async producers() {
          calls.push("refence:producers");
          if (options.refenceProducersFails) throw new Error("producer refence failed");
        },
        async ingress() {
          calls.push("refence:ingress");
          if (options.refenceIngressFails) throw new Error("ingress refence failed");
        },
        async database() {
          calls.push("refence:database");
          if (options.refenceDatabaseFails) throw new Error("database refence failed");
        },
        ...(options.skipServicePort
          ? {}
          : {
              async service() {
                calls.push("refence:service");
                if (options.refenceServiceFails) throw new Error("service stop failed");
              },
            }),
      },
    });
  return { state, run };
}

test("a complete run verifies the pair while producers are fenced and accepts before resuming", async () => {
  const h = harness();
  const outcome = await h.run();
  expect(outcome.disposition).toBe("released");
  expect(h.state.servingPairVerified).toBe(true);
  // Completion runs after the pair is deployed and before anything is reopened;
  // acceptance runs after ingress and before delivery resumes.
  expect(h.state.calls).toEqual([
    "surface:versions",
    "reset:completion",
    "surface:database",
    "surface:ingress",
    "acceptance",
    "surface:producers",
  ]);
});

test("reset completion refusing stops before ingress opens and re-fences nothing", async () => {
  const h = harness({ completionFails: true });
  const outcome = await h.run();
  expect(outcome.disposition).toBe("unresolved");
  if (outcome.disposition !== "unresolved") throw new Error("unreachable");
  expect(outcome.failedSurface).toBe("database");
  expect(outcome.receipts.map((receipt) => receipt.surface)).toEqual(["versions"]);
  expect(outcome.refenced).toBeUndefined();
  expect(h.state.calls).not.toContain("surface:ingress");
  expect(h.state.calls).not.toContain("refence:ingress");
});

test("acceptance failure re-fences HTTP and the database instead of only stopping", async () => {
  const h = harness({ acceptanceFails: true });
  const outcome = await h.run();
  expect(outcome.disposition).toBe("unresolved");
  if (outcome.disposition !== "unresolved") throw new Error("unreachable");
  expect(outcome.failedSurface).toBe("producers");
  // Every receipt earned before the refusal is retained.
  expect(outcome.receipts.map((receipt) => receipt.surface)).toEqual([
    "versions",
    "database",
    "ingress",
  ]);
  // Acceptance refused before the surface ran, so no delivery resumed and the
  // producer fence was never lifted.
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    ingress: "restored",
    database: "restored",
  });
  expect(h.state.calls).toEqual([
    "surface:versions",
    "reset:completion",
    "surface:database",
    "surface:ingress",
    "acceptance",
    "refence:ingress",
    "refence:database",
  ]);
  // Delivery never resumed against the unaccepted pairing.
  expect(h.state.calls).not.toContain("surface:producers");
});

test("a producers surface that failed partway re-pauses delivery as well as HTTP", async () => {
  // The surface began, so queues or schedules may already have resumed even
  // though no receipt came back.
  const h = harness({ failSurface: "producers" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toEqual({
    producers: "restored",
    ingress: "restored",
    database: "restored",
  });
  expect(h.state.calls.slice(-3)).toEqual([
    "refence:producers",
    "refence:ingress",
    "refence:database",
  ]);
});

test("a lost ingress response is re-fenced even though no receipt was recorded", async () => {
  // The removal may have applied remotely and the response never arrived, so
  // HTTP can be open with nothing to show for it.
  const h = harness({ failSurface: "ingress" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.receipts.map((receipt) => receipt.surface)).toEqual(["versions", "database"]);
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    ingress: "restored",
    database: "restored",
  });
  expect(h.state.calls).not.toContain("acceptance");
  expect(h.state.calls).not.toContain("refence:producers");
});

test("a failed producer re-fence is reported without stopping the others", async () => {
  const h = harness({ failSurface: "producers", refenceProducersFails: true });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toEqual({
    producers: "failed",
    ingress: "restored",
    database: "restored",
  });
});

test("a failed re-fence is reported rather than swallowed, and never stops the other one", async () => {
  const h = harness({ acceptanceFails: true, refenceIngressFails: true });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    ingress: "failed",
    database: "restored",
  });
  expect(h.state.calls).toContain("refence:database");
});

test("a failure before the pair deploys re-fences nothing and completes nothing", async () => {
  const h = harness({ failSurface: "versions" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.failedSurface).toBe("versions");
  expect(outcome.receipts).toHaveLength(0);
  expect(h.state.servingPairVerified).toBe(false);
  expect(h.state.calls).toEqual(["surface:versions"]);
});

test("no surface, completion or acceptance is attempted twice in one run", async () => {
  const h = harness();
  await h.run();
  const counted = new Map<string, number>();
  for (const call of h.state.calls) counted.set(call, (counted.get(call) ?? 0) + 1);
  expect([...counted.values()].every((count) => count === 1)).toBe(true);
});

test("grant restoration that commits and then loses its confirmation is re-fenced", async () => {
  // The surface began, so privileges may already be restored even though no
  // receipt came back, and ingress never opened.
  const h = harness({ failSurface: "database" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    ingress: "not-required",
    database: "restored",
  });
  expect(h.state.calls).not.toContain("surface:ingress");
  expect(h.state.calls).toContain("refence:database");
});

test("a refused completion gate re-fences nothing, because no surface ran", async () => {
  const h = harness({ completionFails: true });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toBeUndefined();
  expect(h.state.calls.some((call) => call.startsWith("refence:"))).toBe(false);
});

test("the rethrown failure carries the receipts and per-fence outcomes with it", async () => {
  const h = harness({ throwOnAttempt: "producers", refenceIngressFails: true });
  const failure = await failureOf(h.run);
  // The original error is preserved as the cause, not replaced.
  expect((failure.cause as Error).message).toBe("journal write failed");
  // Without these the failed ingress fence would vanish behind the reporting
  // error and nobody would learn a fence was left down.
  expect(failure.refenced).toEqual({
    producers: "not-required",
    ingress: "failed",
    database: "restored",
  });
  expect(failure.receipts.map((receipt) => receipt.surface)).toEqual([
    "versions",
    "database",
    "ingress",
  ]);
  expect(failure.recordingFailure).toBeUndefined();
  expect(h.state.recovered).toHaveLength(1);
});

test("a failed recording is carried on the failure rather than swallowed", async () => {
  const h = harness({ throwOnAttempt: "producers", recoveryReportFails: true });
  const failure = await failureOf(h.run);
  expect((failure.cause as Error).message).toBe("journal write failed");
  expect(failure.recordingFailure).toBe("recovery journal write failed");
  // The outcomes survive on the failure even though the durable copy did not.
  expect(failure.refenced).toEqual({
    producers: "not-required",
    ingress: "restored",
    database: "restored",
  });
});

test("recovery outcomes are still offered for durable recording", async () => {
  const h = harness({ throwOnAttempt: "producers" });
  await failureOf(h.run);
  expect(h.state.recovered).toEqual([
    { producers: "not-required", ingress: "restored", database: "restored" },
  ]);
});

test("a reporting callback that throws after ingress opened still triggers recovery", async () => {
  // onAttempt runs outside the operation's protected block, so a failed
  // journal write escapes it entirely.
  const h = harness({ throwOnAttempt: "producers" });
  await failureOf(h.run);
  expect(h.state.calls).toContain("refence:ingress");
  expect(h.state.calls).toContain("refence:database");
  // The surface never ran, so delivery was never resumed.
  expect(h.state.calls).not.toContain("refence:producers");
});

test("the delegated HNS step runs once between the database release and ingress", async () => {
  const h = harness({ hnsOutcome: "applied" });
  const outcome = await h.run();
  expect(outcome.disposition).toBe("released");
  if (outcome.disposition !== "released") throw new Error("unreachable");
  // All ten named results and the exact fresh attempt pass through unchanged.
  expect(outcome.hnsResult).toEqual(hnsAppliedResult);
  expect(outcome.hnsResult?.results).toHaveLength(10);
  expect(outcome.hnsResult?.attempt_id).toBe("attempt-0dd71225");
  expect(h.state.calls).toEqual([
    "surface:versions",
    "reset:completion",
    "surface:database",
    "hns:run",
    "surface:ingress",
    "acceptance",
    "surface:producers",
  ]);
});

test("a confirmed pre-start refusal re-fences the database and stops no service", async () => {
  const h = harness({ hnsOutcome: "refused-pre-start" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.failedSurface).toBe("ingress");
  // The structured refusal travels with its ordered completed results.
  expect(outcome.hnsRefusal).toEqual(hnsPreStartRefusal);
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    service: "not-required",
    ingress: "not-required",
    database: "restored",
  });
  expect(h.state.calls).not.toContain("surface:ingress");
  expect(h.state.calls).not.toContain("refence:service");
});

test("a service-start refusal without a disposition still stops the unit first", async () => {
  // The start port threw, so the acknowledgment was lost; the absent
  // disposition is not proof that nothing started.
  const h = harness({ hnsOutcome: "refused-service-start" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.hnsRefusal).toEqual(hnsServiceStartRefusal);
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    service: "restored",
    ingress: "not-required",
    database: "restored",
  });
  expect(h.state.calls.slice(-2)).toEqual(["refence:service", "refence:database"]);
});

test("a failed service stop is recorded while the database re-fence still runs", async () => {
  const h = harness({ hnsOutcome: "refused-after-start", refenceServiceFails: true });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.hnsRefusal).toEqual(hnsPostStartRefusal);
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    service: "failed",
    ingress: "not-required",
    database: "restored",
  });
  expect(h.state.calls).toContain("refence:database");
});

test("a required stop with no bound service port is failed, not not-required", async () => {
  const h = harness({ hnsOutcome: "refused-after-start", skipServicePort: true });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    service: "failed",
    ingress: "not-required",
    database: "restored",
  });
});

test("an unshaped HNS failure is an uncertain start and never not-required", async () => {
  const h = harness({ hnsOutcome: "thrown" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.hnsRefusal).toBeUndefined();
  expect(outcome.refenced).toEqual({
    producers: "not-required",
    service: "restored",
    ingress: "not-required",
    database: "restored",
  });
  expect(h.state.calls).toContain("refence:service");
});

test("HNS success followed by a later failure stops the unit and preserves the result", async () => {
  const h = harness({ hnsOutcome: "applied", failSurface: "producers" });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(outcome.hnsResult).toEqual(hnsAppliedResult);
  expect(outcome.refenced).toEqual({
    producers: "restored",
    service: "restored",
    ingress: "restored",
    database: "restored",
  });
  expect(h.state.calls.slice(-4)).toEqual([
    "refence:producers",
    "refence:service",
    "refence:ingress",
    "refence:database",
  ]);
});

test("an ingress hook ordered before the database receipt refuses before HNS runs", async () => {
  const h = harness({
    hnsOutcome: "applied",
    surfaceOrder: ["versions", "ingress", "database", "producers"],
  });
  const outcome = await h.run();
  if (outcome.disposition !== "unresolved") throw new Error("expected unresolved");
  expect(h.state.calls).not.toContain("hns:run");
  // Nothing ran, so nothing needs putting back.
  expect(outcome.refenced).toBeUndefined();
  expect(outcome.hnsResult).toBeUndefined();
});
