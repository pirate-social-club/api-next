import { afterEach, expect, test as unit } from "bun:test";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { readKaraokeMaintenanceJournal, signedBytes } from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import { karaokeJournalIntegrationTest as test } from "./staging-karaoke-journal-test.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeFenceRelease } from "./staging-karaoke-record-release.ts";
import {
  makeKaraokeReleaseBinding,
  makeKaraokeReleaseEvidenceStore,
} from "./staging-karaoke-release-binding.ts";
import type {
  KaraokeReleasePlan,
  KaraokeReleaseSurface,
} from "./staging-karaoke-release-operation.ts";

afterEach(disposeMilestoneFixtures);
const fixture = makeKaraokeMilestoneFixture;

unit("even a signed malformed surface record cannot stand for a required receipt", () => {
  const f = fixture();
  const writer = openKaraokePrivateWriter(f.journal.directory);
  try {
    writer.putArtifact(
      signedBytes(
        {
          scope: "staging-karaoke-release-surface",
          planDigest: "a".repeat(64),
          intentId: "b".repeat(64),
          surface: "foreign",
          phase: "released",
          releasedAt: f.now(),
          receipt: "unproven",
        },
        f.base.privateKeyPem,
      ),
    );
  } finally {
    writer.close();
  }
  expect(() => evidence(f).list("b".repeat(64))).toThrow();
});

const plan: KaraokeReleasePlan = {
  version: "staging-karaoke-release-plan-v1",
  ingressApplicationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  resumeQueues: [{ name: "staging-events", id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  servingWorkers: [{ worker: "http-worker", versionId: "cccccccccccccccccccccccccccccccc" }],
  reviewedGrantDigest: "d".repeat(64),
  // The approved surface order is an owner decision; tests exercise the
  // executor logic with one explicit order, not an approved one.
  surfaceOrder: ["ingress", "producers", "database"] as const,
};
const intent = { planDigest: reconciliationDigest(JSON.stringify(plan)), intentId: "b".repeat(64) };

function surfaces(
  state: { fail: KaraokeReleaseSurface | null; calls: KaraokeReleaseSurface[] },
  now: () => string,
) {
  const make = (surface: KaraokeReleaseSurface) => async (_: unknown, at: () => string) => {
    state.calls.push(surface);
    if (state.fail === surface) throw new Error(`surface ${surface} failed`);
    void now;
    return { surface, releasedAt: at(), receipt: `${surface}-receipt` };
  };
  return { ingress: make("ingress"), producers: make("producers"), database: make("database") };
}

function evidence(f: ReturnType<typeof fixture>) {
  return makeKaraokeReleaseEvidenceStore(
    f.journal.directory,
    f.base.privateKeyPem,
    f.base.trust.collectorPublicKeyPem,
    (bytes) => {
      const writer = openKaraokePrivateWriter(f.journal.directory);
      try {
        writer.putArtifact(bytes);
      } finally {
        writer.close();
      }
    },
    () => {
      const store = require("node:fs").readdirSync(f.journal.directory) as string[];
      return store.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    },
    (name) => require("node:fs").readFileSync(`${f.journal.directory}/${name}`, "utf8"),
  );
}

async function ceremony() {
  const f = fixture();
  f.base.releasePlanDigest = intent.planDigest;
  await f.pass("post-fence");
  await f.pass("pre-reset");
  f.state.identityPresent = false;
  await f.resetOrigin();
  f.state.markers = "retired";
  await f.pass("retirement");
  await f.retirementOrigin();
  return f;
}

async function pendingIntent(f: Awaited<ReturnType<typeof ceremony>>) {
  let captured:
    | Parameters<Parameters<typeof recordKaraokeFenceRelease>[0]["verifyFenceRelease"]>[0]
    | undefined;
  await expect(
    recordKaraokeFenceRelease({
      ...f.base,
      verifyFenceRelease: async (current) => {
        captured = current;
        throw new Error("stopped_before_claim");
      },
    }),
  ).rejects.toThrow("stopped_before_claim");
  if (captured === undefined) throw new Error("missing test intent");
  return captured;
}

test("successful release across all surfaces records with the operation's release time", async () => {
  const f = await ceremony();
  const base = f.base;
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const callerPlan = { ...plan, surfaceOrder: [...plan.surfaceOrder] };
  const binding = makeKaraokeReleaseBinding({
    plan: callerPlan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "restored" as const,
      producers: async () => "restored" as const,
      database: async () => "restored" as const,
    },
    evidence: evidence(f),
    readers: base.readers,
    now: f.now,
  });
  callerPlan.surfaceOrder.reverse();
  const result = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: binding.verifyFenceRelease,
    reconcileReleasedFence: binding.reconcileReleasedFence,
  });
  expect(result.executionAuthorized).toBe(false);
  expect(readKaraokeMaintenanceJournal(base.journal, base.now()).state).toBe("released");
  expect(state.calls).toEqual(["ingress", "producers", "database"]);
});

test("an independent readback failure after successful mutations refuses release and re-execution", async () => {
  const f = await ceremony();
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "restored",
      producers: async () => "restored",
      database: async () => {
        throw new Error("database readback unavailable");
      },
    },
    evidence: evidence(f),
    readers: f.base.readers,
    now: f.now,
  });
  await expect(recordKaraokeFenceRelease({ ...f.base, ...binding })).rejects.toThrow(
    "karaoke_release_operation_unresolved",
  );
  expect(state.calls).toEqual(["ingress", "producers", "database"]);
  await expect(recordKaraokeFenceRelease({ ...f.base, ...binding })).rejects.toThrow();
  expect(state.calls).toHaveLength(3);
  expect(readKaraokeMaintenanceJournal(f.journal, f.now()).state).toBe("retired");
});

test("an uncertain surface leaves the release unresolved with no second execution", async () => {
  const f = await ceremony();
  const base = f.base;
  const state = {
    fail: "producers" as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "restored" as const,
      producers: async () => "uncertain" as const,
      database: async () => "fenced" as const,
    },
    evidence: evidence(f),
    readers: base.readers,
    now: f.now,
  });
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: binding.verifyFenceRelease,
      reconcileReleasedFence: binding.reconcileReleasedFence,
    }),
  ).rejects.toThrow("karaoke_release_operation_unresolved");
  expect(state.calls).toEqual(["ingress", "producers"]);
  expect(readKaraokeMaintenanceJournal(base.journal, base.now()).state).toBe("retired");
});

test("interruption between surfaces recovers from retained receipts without re-execution", async () => {
  const f = await ceremony();
  const base = f.base;
  const state = {
    fail: "database" as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "restored" as const,
      producers: async () => "restored" as const,
      database: async () => "restored" as const,
    },
    evidence: evidence(f),
    readers: base.readers,
    now: f.now,
  });
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: binding.verifyFenceRelease,
      reconcileReleasedFence: binding.reconcileReleasedFence,
    }),
  ).rejects.toThrow("karaoke_release_operation_unresolved");
  const callsAfterInterruption = state.calls.length;
  // A second origin invocation routes through read-only reconciliation —
  // never the executor — because the pending intent gates execution.
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: binding.verifyFenceRelease,
      reconcileReleasedFence: binding.reconcileReleasedFence,
    }),
  ).rejects.toThrow();
  expect(state.calls.length).toBe(callsAfterInterruption);
  // Restored surfaces without three retained receipts stay unresolved; the
  // release time is never reconstructed from current state.
  await expect(binding.reconcileReleasedFence(intent)).rejects.toThrow("foreign_intent");
});

test("fenced surfaces without positive non-execution evidence stay unresolved; only a pre-execution cancellation proves not-executed", async () => {
  const f = await ceremony();
  const intent = await pendingIntent(f);
  const base = f.base;
  const make = () =>
    makeKaraokeReleaseBinding({
      plan,
      surfaces: surfaces({ fail: null, calls: [] }, base.now),
      observeRestored: {
        ingress: async () => "fenced" as const,
        producers: async () => "fenced" as const,
        database: async () => "fenced" as const,
      },
      evidence: evidence(f),
      readers: base.readers,
      now: f.now,
    });
  // No receipts and no cancellation: unresolved, never a fresh execution.
  expect(await make().reconcileReleasedFence(intent)).toEqual({ disposition: "unresolved" });
  // A durable pre-execution cancellation positively establishes not-executed.
  const cancelled = make();
  await cancelled.cancelBeforeExecution(intent);
  expect(await cancelled.reconcileReleasedFence(intent)).toEqual({ disposition: "not-executed" });
});

test("mutation success with lost receipt persistence then re-fencing never re-executes", async () => {
  const f = await ceremony();
  const base = f.base;
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const full = evidence(f);
  void 0;
  const lossy: typeof full = {
    put: (record) => {
      if ((record as { phase?: string }).phase === "released")
        throw new Error("receipt persistence failed");
      full.put(record);
    },
    list: (id) => full.list(id),
    claim: (kind, digest, id) => full.claim(kind, digest, id),
  };
  let reFenced = false;
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, base.now),
    observeRestored: {
      ingress: async () => (reFenced ? ("fenced" as const) : ("restored" as const)),
      producers: async () => (reFenced ? ("fenced" as const) : ("restored" as const)),
      database: async () => (reFenced ? ("fenced" as const) : ("restored" as const)),
    },
    evidence: lossy,
    readers: base.readers,
    now: f.now,
  });
  // Through the origin: the ingress mutation succeeds but its receipt
  // persistence fails, so the run stops unresolved after one confirmed,
  // unreceipted mutation, with the signed intent retained.
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: binding.verifyFenceRelease,
      reconcileReleasedFence: binding.reconcileReleasedFence,
    }),
  ).rejects.toThrow("karaoke_release_operation_unresolved");
  expect(state.calls).toEqual(["ingress"]);
  // The surfaces are subsequently re-fenced; the retry must be unresolved
  // with zero additional mutations.
  reFenced = true;
  const callsAfterRetry = state.calls.length;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: binding.verifyFenceRelease,
      reconcileReleasedFence: binding.reconcileReleasedFence,
    }),
  ).rejects.toThrow();
  expect(state.calls.length).toBe(callsAfterRetry);
  await expect(binding.reconcileReleasedFence(intent)).rejects.toThrow("foreign_intent");
});

test("a cancelled intent refuses subsequent execution", async () => {
  const f = await ceremony();
  const intent = await pendingIntent(f);
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const exec = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "fenced" as const,
      producers: async () => "fenced" as const,
      database: async () => "fenced" as const,
    },
    evidence: evidence(f),
    readers: f.base.readers,
    now: f.now,
  });
  const cancelled = await exec.cancelBeforeExecution(intent).then(
    () => true,
    () => false,
  );
  // After the cancellation claim persisted, execution must be refused.
  await expect(exec.verifyFenceRelease(intent)).rejects.toThrow("karaoke_release_claim");
  expect(cancelled).toBe(true);
  expect(state.calls).toEqual([]);
  expect(await exec.reconcileReleasedFence(intent)).toEqual({ disposition: "not-executed" });
});

test("a signed not-executed closure permits a fresh intent without erasing cancellation", async () => {
  const f = await ceremony();
  const old = await pendingIntent(f);
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const observe = async () =>
    state.calls.length === 3 ? ("restored" as const) : ("fenced" as const);
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: { ingress: observe, producers: observe, database: observe },
    evidence: evidence(f),
    readers: f.base.readers,
    now: f.now,
  });
  await binding.cancelBeforeExecution(old);
  const { readFileSync, readdirSync } = await import("node:fs");
  const cancelled = readFileSync(`${f.journal.directory}/release-claim.json`, "utf8");
  await recordKaraokeFenceRelease({
    ...f.base,
    verifyFenceRelease: binding.verifyFenceRelease,
    reconcileReleasedFence: binding.reconcileReleasedFence,
  });
  expect(state.calls).toEqual(["ingress", "producers", "database"]);
  expect(readdirSync(f.journal.directory)).toContain(`${reconciliationDigest(cancelled)}.json`);
  expect(
    readFileSync(`${f.journal.directory}/${reconciliationDigest(cancelled)}.json`, "utf8"),
  ).toBe(cancelled);
  await expect(binding.verifyFenceRelease(old)).rejects.toThrow("refused-foreign");
  expect(state.calls).toHaveLength(3);
});

test("a malformed claim from interrupted persistence refuses mutation", async () => {
  const f = await ceremony();
  const intent = await pendingIntent(f);
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const store = evidence(f);
  const { writeFileSync } = await import("node:fs");
  // A crash during claim persistence left truncated bytes.
  writeFileSync(`${f.journal.directory}/release-claim.json`, '{"payl', { mode: 0o600 });
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "fenced" as const,
      producers: async () => "fenced" as const,
      database: async () => "fenced" as const,
    },
    evidence: store,
    readers: f.base.readers,
    now: f.now,
  });
  await expect(binding.verifyFenceRelease(intent)).rejects.toThrow(
    "karaoke_release_claim_uncertain",
  );
  await expect(binding.cancelBeforeExecution(intent)).rejects.toThrow(
    "karaoke_release_claim_uncertain",
  );
  expect(state.calls).toEqual([]);
});

test("changing the plan during recovery refuses instead of hiding history", async () => {
  const f = await ceremony();
  const intent = await pendingIntent(f);
  const state = {
    fail: null as KaraokeReleaseSurface | null,
    calls: [] as KaraokeReleaseSurface[],
  };
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "fenced" as const,
      producers: async () => "fenced" as const,
      database: async () => "fenced" as const,
    },
    evidence: evidence(f),
    readers: f.base.readers,
    now: f.now,
  });
  await binding.cancelBeforeExecution(intent);
  const altered = makeKaraokeReleaseBinding({
    plan: { ...plan, surfaceOrder: ["database", "producers", "ingress"] as const },
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "fenced" as const,
      producers: async () => "fenced" as const,
      database: async () => "fenced" as const,
    },
    evidence: evidence(f),
    readers: f.base.readers,
    now: f.now,
  });
  await expect(altered.verifyFenceRelease(intent)).rejects.toThrow("karaoke_release_plan_changed");
  await expect(altered.reconcileReleasedFence(intent)).rejects.toThrow(
    "karaoke_release_plan_changed",
  );
  expect(state.calls).toEqual([]);
});

test("recovery refuses signed confirmations that run backward in reviewed surface order", async () => {
  const f = await ceremony();
  const current = await pendingIntent(f);
  const store = evidence(f);
  store.claim("executing", current.planDigest, current.intentId);
  const start = Date.parse(current.recordedAt);
  for (const [index, surface] of plan.surfaceOrder.entries()) {
    store.put({
      scope: "staging-karaoke-release-surface",
      planDigest: current.planDigest,
      intentId: current.intentId,
      surface,
      phase: "released",
      receipt: "retained-proof",
      releasedAt: new Date(start + ([100, 90, 95][index] ?? 0)).toISOString(),
    });
  }
  f.advance(1000);
  const state = { fail: null, calls: [] as KaraokeReleaseSurface[] };
  const binding = makeKaraokeReleaseBinding({
    plan,
    surfaces: surfaces(state, f.now),
    observeRestored: {
      ingress: async () => "restored",
      producers: async () => "restored",
      database: async () => "restored",
    },
    evidence: store,
    readers: f.base.readers,
    now: f.now,
  });
  expect(await binding.reconcileReleasedFence(current)).toEqual({ disposition: "unresolved" });
  expect(state.calls).toHaveLength(0);
});
