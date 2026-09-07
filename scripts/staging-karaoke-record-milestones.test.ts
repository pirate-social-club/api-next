import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal, signedBytes } from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import { verifyKaraokeJournalState } from "./staging-karaoke-journal-manifest.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture as fixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeFenceRelease } from "./staging-karaoke-record-release.ts";

afterEach(disposeMilestoneFixtures);

test("full ceremony: passes, reset origin, retirement pass, all-retired, release and 24h follow-up", async () => {
  const {
    pass,
    resetOrigin,
    retirementOrigin,
    releaseOrigin,
    state,
    reads,
    journal,
    now,
    advance,
  } = fixture();
  const postFence = await pass("post-fence");
  expect(postFence.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  const preReset = await pass("pre-reset");
  expect(preReset.resetAdmission).toBe("eligible");
  state.identityPresent = false;
  const reset = await resetOrigin();
  expect(reset.executionAuthorized).toBe(false);
  state.markers = "retired";
  const retirement = await pass("retirement");
  expect(retirement.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  expect(retirement.resetAdmission).toBe("blocked");
  const allRetired = await retirementOrigin();
  expect(allRetired.executionAuthorized).toBe(false);
  const releasedHead = await releaseOrigin();
  expect(releasedHead.executionAuthorized).toBe(false);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
  const fenceReadsAtFollowUp = reads.fence;
  advance(86_400_000);
  const followUp = await pass("follow-up");
  expect(followUp.retentionStatus).toBe("observed-stable");
  expect(followUp.latestPasses.every((p) => p.outcome === "observed-empty")).toBe(true);
  // Post-release passes cite historical fence evidence, never a fresh claim.
  expect(reads.fence).toBe(fenceReadsAtFollowUp);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
});

test("follow-up obeys the 24-hour boundary and requires a recorded release", async () => {
  const { pass, resetOrigin, retirementOrigin, releaseOrigin, state, journal, now, advance } =
    fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  await expect(pass("follow-up")).rejects.toThrow("karaoke_pass_release_scope_denied");
  await releaseOrigin();
  await expect(pass("follow-up")).rejects.toThrow();
  advance(86_400_000);
  const followUp = await pass("follow-up");
  expect(followUp.retentionStatus).toBe("observed-stable");
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
});

test("reset origin requires eligible admission, zero counts and fresh completion", async () => {
  const { pass, resetOrigin, completion, state, journal, now, held } = fixture();
  await pass("post-fence");
  await expect(resetOrigin()).rejects.toThrow("karaoke_reset_origin_admission_denied");
  await pass("pre-reset");
  state.identityPresent = false;
  const counts = {
    ...completion(now()),
    personaCounts: { unbound: 0, singleCommunity: 1, multiCommunity: 0 },
  };
  await expect(resetOrigin(counts)).rejects.toThrow("karaoke_reset_origin_completion_unproven");
  await expect(resetOrigin()).resolves.toHaveProperty("executionAuthorized", false);
  await expect(resetOrigin()).rejects.toThrow("karaoke_reset_origin_state_denied");
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("reset");
  expect(held.head).toBeDefined();
});

function releaseEvidenceTime(journal: ReturnType<typeof readKaraokeMaintenanceJournal>): string {
  const released = journal.entries.find(({ entry }) => entry.event.kind === "released");
  if (released?.entry.event.kind !== "released") throw new Error("missing released entry");
  for (const id of released.entry.event.evidenceIds) {
    const parsed = JSON.parse(journal.readArtifact(id)) as {
      kind?: string;
      release?: { releasedAt?: string };
    };
    if (parsed.kind === "release-evidence" && parsed.release?.releasedAt !== undefined)
      return parsed.release.releasedAt;
  }
  throw new Error("missing release evidence");
}

test("release recovers from inspection failure after execution with the preserved release time", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const port = async () => {
    const result = { releasedAt: now(), allSixRetired: true };
    actualReleasedAt = result.releasedAt;
    state.fenceHeld = false;
    return result;
  };
  state.failInspectionOnce = true;
  const attempted = recordKaraokeFenceRelease({ ...base, verifyFenceRelease: port });
  await expect(attempted).rejects.toThrow("fixture inspection failed");
  expect(state.fenceHeld).toBe(false);
  expect(actualReleasedAt).not.toBe("");
  // The durable release record outlives the interrupted command; the retry
  // cannot observe a held fence and must complete from the retained record.
  const recovered = await recordKaraokeFenceRelease({ ...base, verifyFenceRelease: port });
  expect(recovered.executionAuthorized).toBe(false);
  const after = readKaraokeMaintenanceJournal(journal, now());
  expect(after.state).toBe("released");
  // The signed release evidence preserves the actual release time; the
  // journal entry records the later recording time.
  expect(releaseEvidenceTime(after)).toBe(actualReleasedAt);
});

test("release recovers from an append failure after execution with the preserved release time", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now, append } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const port = async () => {
    const concurrent = now();
    const result = { releasedAt: now(), allSixRetired: true };
    actualReleasedAt = result.releasedAt;
    append("fence-observed", concurrent);
    state.fenceHeld = false;
    return result;
  };
  // A concurrent journal advance between execution and append refuses the
  // entry while the release itself has already happened.
  const raced = recordKaraokeFenceRelease({ ...base, verifyFenceRelease: port });
  await expect(raced).rejects.toThrow("karaoke_journal_head_changed");
  const recovered = await recordKaraokeFenceRelease({ ...base, verifyFenceRelease: port });
  expect(recovered.executionAuthorized).toBe(false);
  const after = readKaraokeMaintenanceJournal(journal, now());
  expect(after.state).toBe("released");
  expect(releaseEvidenceTime(after)).toBe(actualReleasedAt);
});

test("a journal entry timestamped after the release still recovers with monotonic history", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now, append } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const port = async () => {
    const result = { releasedAt: now(), allSixRetired: true };
    actualReleasedAt = result.releasedAt;
    state.fenceHeld = false;
    // A concurrent writer signs AFTER the actual release moment.
    append("fence-observed", now());
    return result;
  };
  await expect(recordKaraokeFenceRelease({ ...base, verifyFenceRelease: port })).rejects.toThrow(
    "karaoke_journal_head_changed",
  );
  const recovered = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      throw new Error("must not execute again");
    },
  });
  expect(recovered.executionAuthorized).toBe(false);
  const after = readKaraokeMaintenanceJournal(journal, now());
  expect(after.state).toBe("released");
  expect(releaseEvidenceTime(after)).toBe(actualReleasedAt);
  const times = after.entries.map(({ entry }) => Date.parse(entry.observedAt));
  expect([...times].sort((left, right) => left - right)).toEqual(times);
});

async function releaseCeremony() {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  return { base, state, journal, now };
}

test("a fabricated unsigned release sidecar never becomes authority", async () => {
  {
    const { base, state, journal, now } = await releaseCeremony();
    const head = readKaraokeMaintenanceJournal(journal, now()).head;
    const writer = openKaraokePrivateWriter(journal.directory);
    try {
      writer.putArtifact(
        JSON.stringify({
          kind: "release-executed",
          epoch: base.trust.epoch,
          bucket: base.trust.bucket,
          residualDispositionId: base.trust.residualDispositionId,
          expectedHead: head,
          intentId: "f".repeat(64),
          release: { releasedAt: now(), allSixRetired: true },
          source: "execution",
          recordedAt: now(),
        }),
      );
    } finally {
      writer.close();
    }
    state.fenceHeld = false;
    await expect(
      recordKaraokeFenceRelease({
        ...base,
        verifyFenceRelease: async () => {
          throw new Error("must not execute again");
        },
      }),
    ).rejects.toThrow();
  }
});

test("a modified release sidecar whose bytes do not hash to its name never becomes authority", async () => {
  {
    const { base, state, journal, now } = await releaseCeremony();
    const head = readKaraokeMaintenanceJournal(journal, now()).head;
    const writer = openKaraokePrivateWriter(journal.directory);
    try {
      const intentId = writer.putArtifact(
        signedBytes(
          {
            kind: "release-intent",
            epoch: base.trust.epoch,
            bucket: base.trust.bucket,
            residualDispositionId: base.trust.residualDispositionId,
            expectedHead: head,
            fence: {
              verifiedAt: now(),
              ingress: true,
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
      const executed = signedBytes(
        {
          kind: "release-executed",
          epoch: base.trust.epoch,
          bucket: base.trust.bucket,
          residualDispositionId: base.trust.residualDispositionId,
          expectedHead: head,
          intentId,
          release: { releasedAt: now(), allSixRetired: true },
          source: "execution",
          recordedAt: now(),
        },
        base.privateKeyPem,
      );
      // Same valid bytes, stored under a mismatched digest name.
      const { writeFileSync, chmodSync } = await import("node:fs");
      const { join } = await import("node:path");
      const bogus = join(journal.directory, `${"0".repeat(64)}.json`);
      writeFileSync(bogus, executed, { mode: 0o600 });
      chmodSync(bogus, 0o600);
    } finally {
      writer.close();
    }
    state.fenceHeld = false;
    await expect(
      recordKaraokeFenceRelease({
        ...base,
        verifyFenceRelease: async () => {
          throw new Error("must not execute again");
        },
      }),
    ).rejects.toThrow("karaoke_release_origin_recovery_denied");
  }
});

test("a cross-ceremony release sidecar bound to a foreign journal head never becomes authority", async () => {
  {
    const { base, state, journal, now } = await releaseCeremony();
    const writer = openKaraokePrivateWriter(journal.directory);
    try {
      const intentId = writer.putArtifact(
        signedBytes(
          {
            kind: "release-intent",
            epoch: base.trust.epoch,
            bucket: base.trust.bucket,
            residualDispositionId: base.trust.residualDispositionId,
            expectedHead: { entryId: "a".repeat(64), sequence: 99 },
            fence: {
              verifiedAt: now(),
              ingress: true,
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
      writer.putArtifact(
        signedBytes(
          {
            kind: "release-executed",
            epoch: base.trust.epoch,
            bucket: base.trust.bucket,
            residualDispositionId: base.trust.residualDispositionId,
            expectedHead: { entryId: "a".repeat(64), sequence: 99 },
            intentId,
            release: { releasedAt: now(), allSixRetired: true },
            source: "execution",
            recordedAt: now(),
          },
          base.privateKeyPem,
        ),
      );
    } finally {
      writer.close();
    }
    state.fenceHeld = false;
    await expect(
      recordKaraokeFenceRelease({
        ...base,
        verifyFenceRelease: async () => {
          throw new Error("must not execute again");
        },
      }),
    ).rejects.toThrow("karaoke_release_origin_recovery_denied");
  }
});

test("uncertain execution reconciles read-only from a signed intent without executing again", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const lost = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      actualReleasedAt = now();
      state.fenceHeld = false;
      throw new Error("lost response");
    },
  });
  await expect(lost).rejects.toThrow("lost response");
  // Without a read-only reconciliation binding the uncertain state refuses.
  await expect(
    recordKaraokeFenceRelease({
      ...base,
      verifyFenceRelease: async () => {
        throw new Error("must not execute again");
      },
    }),
  ).rejects.toThrow("karaoke_release_origin_uncertain_denied");
  const recovered = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      throw new Error("must not execute again");
    },
    reconcileReleasedFence: async () => ({
      disposition: "released",
      release: { releasedAt: actualReleasedAt, allSixRetired: true },
    }),
  });
  expect(recovered.executionAuthorized).toBe(false);
  const after = readKaraokeMaintenanceJournal(journal, now());
  expect(after.state).toBe("released");
  expect(releaseEvidenceTime(after)).toBe(actualReleasedAt);
});

test("uncertain execution recovers even when the concrete fence reader throws", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const lost = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      actualReleasedAt = now();
      throw new Error("lost response");
    },
  });
  await expect(lost).rejects.toThrow("lost response");
  // The real collectors throw when fencing is absent; recovery must select
  // from the pending signed intent without any fence observation.
  const throwing = { ...base, readers: { ...base.readers } };
  throwing.readers.observeMaintainedFence = async () => {
    throw new Error("karaoke_collector_fence_absent");
  };
  let receivedIntent = false;
  const recovered = await recordKaraokeFenceRelease({
    ...throwing,
    verifyFenceRelease: async () => {
      throw new Error("must not execute again");
    },
    reconcileReleasedFence: async (pendingIntent) => {
      receivedIntent =
        (pendingIntent as { fence?: { ingress?: boolean } } | undefined)?.fence?.ingress === true;
      return {
        disposition: "released",
        release: { releasedAt: actualReleasedAt, allSixRetired: true },
      };
    },
  });
  expect(recovered.executionAuthorized).toBe(false);
  expect(receivedIntent).toBe(true);
  const after = readKaraokeMaintenanceJournal(journal, now());
  expect(after.state).toBe("released");
  expect(releaseEvidenceTime(after)).toBe(actualReleasedAt);
});

test("lost response, a later journal append and read-only reconciliation recover together", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now, append } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  let actualReleasedAt = "";
  const lost = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      actualReleasedAt = now();
      state.fenceHeld = false;
      throw new Error("lost response");
    },
  });
  await expect(lost).rejects.toThrow("lost response");
  // Another writer signs after the actual release, before recording recovers.
  append("fence-observed", now());
  const after = readKaraokeMaintenanceJournal(journal, now());
  const admission = await verifyKaraokeJournalState({
    journal: after,
    trust: base.trust,
    nowUtc: now(),
  });
  expect(admission.releasedAt).toBe(null);
  const recovered = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      throw new Error("must not execute again");
    },
    reconcileReleasedFence: async () => ({
      disposition: "released",
      release: { releasedAt: actualReleasedAt, allSixRetired: true },
    }),
  });
  expect(recovered.executionAuthorized).toBe(false);
  const final = readKaraokeMaintenanceJournal(journal, now());
  expect(final.state).toBe("released");
  expect(releaseEvidenceTime(final)).toBe(actualReleasedAt);
  // The operational release time derives from the authenticated evidence,
  // not the later recording entry, and history stays monotonic.
  const verified = await verifyKaraokeJournalState({
    journal: final,
    trust: base.trust,
    nowUtc: now(),
  });
  expect(verified.releasedAt).toBe(actualReleasedAt);
  const times = final.entries.map(({ entry }) => Date.parse(entry.observedAt));
  expect([...times].sort((left, right) => left - right)).toEqual(times);
  const advance = 86_400_000;
  void advance;
});

test("a positively verified not-executed disposition permits fresh execution once", async () => {
  const { base, pass, resetOrigin, retirementOrigin, state, journal, now } = fixture();
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  state.markers = "retired";
  await pass("retirement");
  await retirementOrigin();
  const lost = recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => {
      throw new Error("binding failed before executing");
    },
  });
  await expect(lost).rejects.toThrow("binding failed before executing");
  const recovered = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => ({ releasedAt: now(), allSixRetired: true }),
    reconcileReleasedFence: async () => ({ disposition: "not-executed" }),
  });
  expect(recovered.executionAuthorized).toBe(false);
  expect(readKaraokeMaintenanceJournal(journal, now()).state).toBe("released");
});

test("retirement and release origins refuse wrong state or unretired markers", async () => {
  const { base, pass, resetOrigin, retirementOrigin, releaseOrigin, state, release, now } =
    fixture();
  await expect(retirementOrigin()).rejects.toThrow("karaoke_retirement_origin_state_denied");
  // While the journal is still held, retirement passes refuse regardless of
  // what the markers claim.
  state.markers = "retired";
  await expect(pass("retirement")).rejects.toThrow("karaoke_pass_retirement_state_denied");
  state.markers = "active";
  await pass("post-fence");
  await pass("pre-reset");
  state.identityPresent = false;
  await resetOrigin();
  await expect(pass("retirement")).rejects.toThrow("karaoke_pass_marker_or_authority_unproven");
  await expect(releaseOrigin()).rejects.toThrow("karaoke_release_origin_state_denied");
  state.markers = "retired";
  await pass("retirement");
  // Retirement passes are recorded, then a marker regresses: the origin must
  // refuse to certify all-retired from unretired readbacks.
  state.markers = "active";
  await expect(retirementOrigin()).rejects.toThrow("karaoke_retirement_origin_marker_unproven");
  state.markers = "retired";
  await retirementOrigin();
  await expect(releaseOrigin(release(now(), false))).rejects.toThrow(
    "karaoke_release_origin_release_unproven",
  );
  // The failed attempt leaves a pending intent; without a reconciliation
  // binding the state refuses before any fence reader runs.
  await expect(releaseOrigin()).rejects.toThrow("karaoke_release_origin_uncertain_denied");
  const resolved = await recordKaraokeFenceRelease({
    ...base,
    verifyFenceRelease: async () => ({ releasedAt: now(), allSixRetired: true }),
    reconcileReleasedFence: async () => ({ disposition: "not-executed" }),
  });
  expect(resolved.executionAuthorized).toBe(false);
});
