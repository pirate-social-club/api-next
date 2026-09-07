import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import { makeKaraokeMilestoneFixture } from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeFenceRelease } from "./staging-karaoke-record-release.ts";
import {
  makeKaraokeReleaseBinding,
  makeKaraokeReleaseEvidenceStore,
} from "./staging-karaoke-release-binding.ts";
import type {
  KaraokeReleasePlan,
  KaraokeReleaseSurface,
} from "./staging-karaoke-release-operation.ts";

afterEach(() => undefined);
const fixture = makeKaraokeMilestoneFixture;

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
  const writer = openKaraokePrivateWriter(f.journal.directory);
  return makeKaraokeReleaseEvidenceStore(
    f.base.privateKeyPem,
    f.base.trust.collectorPublicKeyPem,
    (bytes) => writer.putArtifact(bytes),
    () => {
      const store = require("node:fs").readdirSync(f.journal.directory) as string[];
      return store.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    },
    (name) => require("node:fs").readFileSync(`${f.journal.directory}/${name}`, "utf8"),
  );
}

async function ceremony() {
  const f = fixture();
  await f.pass("post-fence");
  await f.pass("pre-reset");
  f.state.identityPresent = false;
  await f.resetOrigin();
  f.state.markers = "retired";
  await f.pass("retirement");
  await f.retirementOrigin();
  return f;
}

test("successful release across all surfaces records with the operation's release time", async () => {
  const f = await ceremony();
  const base = f.base;
  const state = {
    fail: null as KaraokeReleaseSurface | null,
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
  const result = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: binding.verifyFenceRelease,
    reconcileReleasedFence: binding.reconcileReleasedFence,
  });
  expect(result.executionAuthorized).toBe(false);
  expect(readKaraokeMaintenanceJournal(base.journal, base.now()).state).toBe("released");
  expect(state.calls).toEqual(["ingress", "producers", "database"]);
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
  const reconciled = await binding.reconcileReleasedFence({
    recordedAt: "2000-01-01T00:00:00.000Z",
  });
  expect(reconciled).toEqual({ disposition: "unresolved" });
});

test("all surfaces still fenced reconciles as not-executed", async () => {
  const f = await ceremony();
  const base = f.base;
  const binding = makeKaraokeReleaseBinding({
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
  expect(await binding.reconcileReleasedFence({})).toEqual({ disposition: "not-executed" });
});
