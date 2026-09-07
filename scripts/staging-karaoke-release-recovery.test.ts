import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal, signedBytes } from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeFenceRelease } from "./staging-karaoke-record-release.ts";

afterEach(disposeMilestoneFixtures);

async function zeroExecutionCase(failure: "timeout" | "invalid-evidence" | "write-failure") {
  const { base, journal, now } = await retiredCeremony();
  let actualReleasedAt = "";
  const lost = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      actualReleasedAt = now();
      throw new Error("lost response");
    },
  });
  await expect(lost).rejects.toThrow("lost response");
  let executions = 0;
  const attempt = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      executions++;
      throw new Error("must not execute again");
    },
    reconcileReleasedFence: async () => {
      if (failure === "timeout") throw new Error("reconciliation timeout");
      if (failure === "invalid-evidence")
        return { disposition: "released", release: { allSixRetired: false } };
      return {
        disposition: "released",
        release: { releasedAt: actualReleasedAt, allSixRetired: true },
      };
    },
  });
  if (failure === "write-failure") {
    const { chmodSync } = await import("node:fs");
    chmodSync(journal.directory, 0o500);
    await expect(attempt).rejects.toThrow();
    chmodSync(journal.directory, 0o700);
  } else {
    await expect(attempt).rejects.toThrow();
  }
  expect(executions).toBe(0);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("retired");
}

test("a reconciliation timeout never enables another execution while the fence reads held", async () => {
  await zeroExecutionCase("timeout");
});

test("invalid reconciliation evidence never enables another execution while the fence reads held", async () => {
  await zeroExecutionCase("invalid-evidence");
});

test("an artifact-write failure after released reconciliation never enables another execution", async () => {
  await zeroExecutionCase("write-failure");
});

async function retiredCeremony() {
  const fixture = makeKaraokeMilestoneFixture();
  await fixture.pass("post-fence");
  await fixture.pass("pre-reset");
  fixture.state.identityPresent = false;
  await fixture.resetOrigin();
  fixture.state.markers = "retired";
  await fixture.pass("retirement");
  await fixture.retirementOrigin();
  return fixture;
}

test("changing the plan after an intent is retained refuses before recovery or fencing", async () => {
  const { base, journal, now } = await retiredCeremony();
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => {
        throw new Error("interrupted before claim");
      },
    }),
  ).rejects.toThrow("interrupted before claim");
  const before = readKaraokeMaintenanceJournal(journal, now()).head;
  let calls = 0;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      releasePlanDigest: "f".repeat(64),
      readers: {
        ...base.readers,
        observeMaintainedFence: async () => {
          calls++;
          throw new Error("must not fence");
        },
      },
      verifyFenceRelease: async () => {
        calls++;
        throw new Error("must not execute");
      },
      reconcileReleasedFence: async () => {
        calls++;
        throw new Error("must not reconcile");
      },
    }),
  ).rejects.toThrow("karaoke_release_plan_changed");
  expect(calls).toBe(0);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(before);
});

test("an unknown signed release record refuses rather than disappearing from recovery", async () => {
  const { base, journal, now } = await retiredCeremony();
  const head = readKaraokeMaintenanceJournal(journal, now()).head;
  const writer = openKaraokePrivateWriter(journal.directory);
  try {
    writer.putArtifact(
      signedBytes(
        {
          kind: "release-unrecognized",
          epoch: base.trust.epoch,
          bucket: base.trust.bucket,
          residualDispositionId: base.trust.residualDispositionId,
          expectedHead: { entryId: head.entryId, sequence: head.sequence },
          recordedAt: now(),
        },
        base.privateKeyPem,
      ),
    );
  } finally {
    writer.close();
  }
  let executions = 0;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => {
        executions++;
        throw new Error("must not execute");
      },
    }),
  ).rejects.toThrow("karaoke_release_origin_recovery_denied");
  expect(executions).toBe(0);
});

test("an invalid signed pending intent refuses before fence observation or execution", async () => {
  const { base, journal, now } = await retiredCeremony();
  const head = readKaraokeMaintenanceJournal(journal, now()).head;
  const writer = openKaraokePrivateWriter(journal.directory);
  try {
    writer.putArtifact(
      signedBytes(
        {
          kind: "release-intent",
          planDigest: base.releasePlanDigest,
          nonce: "c".repeat(64),
          previousNotExecutedId: null,
          epoch: base.trust.epoch,
          bucket: base.trust.bucket,
          residualDispositionId: base.trust.residualDispositionId,
          expectedHead: { entryId: head.entryId, sequence: head.sequence },
          fence: {
            verifiedAt: now(),
            ingress: false,
            producers: true,
            databaseWrites: true,
            reconnectDenied: true,
            runtimeSessions: 0,
            residualDispositionId: base.trust.residualDispositionId,
          },
          recordedAt: now(),
        },
        base.privateKeyPem,
      ),
    );
  } finally {
    writer.close();
  }
  let fenceReads = 0;
  let executions = 0;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      readers: {
        ...base.readers,
        observeMaintainedFence: async () => {
          fenceReads++;
          return base.readers.observeMaintainedFence();
        },
      },
      verifyFenceRelease: async () => {
        executions++;
        return { releasedAt: now(), allSixRetired: true };
      },
    }),
  ).rejects.toThrow("karaoke_release_origin_unresolved");
  expect(fenceReads).toBe(0);
  expect(executions).toBe(0);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(head);
});

test("a durable not-executed disposition survives interruption before fresh admission", async () => {
  const { base, journal, now } = await retiredCeremony();
  const head = readKaraokeMaintenanceJournal(journal, now()).head;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => {
        throw new Error("fixture before execution");
      },
    }),
  ).rejects.toThrow("fixture before execution");
  let reconciliations = 0;
  let executions = 0;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      reconcileReleasedFence: async () => {
        reconciliations++;
        return { disposition: "not-executed" };
      },
      readers: {
        ...base.readers,
        observeMaintainedFence: async () => {
          throw new Error("fixture interrupted admission");
        },
      },
      verifyFenceRelease: async () => {
        executions++;
        return { releasedAt: now(), allSixRetired: true };
      },
    }),
  ).rejects.toThrow("fixture interrupted admission");
  expect(executions).toBe(0);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(head);
  const beforeRestart = openKaraokePrivateArtifacts(journal.directory);
  let retainedNames: string[];
  try {
    retainedNames = beforeRestart.names().sort();
  } finally {
    beforeRestart.close();
  }
  // A new invocation has no reconciliation binding. Only the retained,
  // authenticated disposition can close the original pending intent.
  const result = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      executions++;
      return { releasedAt: now(), allSixRetired: true };
    },
  });
  expect(result.executionAuthorized).toBe(false);
  expect(reconciliations).toBe(1);
  expect(executions).toBe(1);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
  const afterRestart = openKaraokePrivateArtifacts(journal.directory);
  try {
    expect(afterRestart.names()).toEqual(expect.arrayContaining(retainedNames));
  } finally {
    afterRestart.close();
  }
});

test("a signed not-executed disposition from a foreign lineage refuses recovery", async () => {
  const { base, journal, now } = await retiredCeremony();
  const head = readKaraokeMaintenanceJournal(journal, now()).head;
  const writer = openKaraokePrivateWriter(journal.directory);
  try {
    writer.putArtifact(
      signedBytes(
        {
          kind: "release-not-executed",
          epoch: base.trust.epoch,
          bucket: base.trust.bucket,
          residualDispositionId: base.trust.residualDispositionId,
          expectedHead: { entryId: "f".repeat(64), sequence: head.sequence },
          intentId: "e".repeat(64),
          recordedAt: now(),
        },
        base.privateKeyPem,
      ),
    );
  } finally {
    writer.close();
  }
  let executions = 0;
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => {
        executions++;
        return { releasedAt: now(), allSixRetired: true };
      },
    }),
  ).rejects.toThrow("karaoke_release_origin_recovery_denied");
  expect(executions).toBe(0);
  expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(head);
});
