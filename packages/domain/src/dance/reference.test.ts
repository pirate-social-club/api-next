import { describe, expect, test } from "bun:test";
import {
  appendDanceChoreographyRevision,
  clearDanceSongPresentation,
  completeDanceReferenceProcessing,
  createDanceChoreography,
  type DanceChoreography,
  type DanceDecision,
  type DanceReferenceReadyEvidence,
  type DanceReferenceTerms,
  type DanceSongSegment,
  danceChoreographyInvariant,
  decideDanceRightsSafetyCutoff,
  decideDanceSongSegmentCreation,
  disableDanceChoreography,
  retireDanceChoreography,
  selectActiveDanceRevision,
  setDanceSongPresentation,
} from "./reference";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);
const T0 = "2026-08-30T10:00:00.000Z";
const T1 = "2026-08-30T10:01:00.000Z";
const T2 = "2026-08-30T10:02:00.000Z";

function value<T>(decision: DanceDecision<T>): T {
  if (decision.kind === "rejected") throw new Error(decision.reason);
  return decision.value;
}

function terms(revision = 1, overrides: Partial<DanceReferenceTerms> = {}): DanceReferenceTerms {
  return {
    revision,
    audioRevision: 4,
    referenceVideoPostId: `reference-video-${revision}`,
    referenceVideoSha256: HASH_A,
    startMs: 10_000,
    endMs: 16_000,
    mirrorPolicy: "allowed",
    alignmentPolicyVersion: "alignment-v1",
    poseModelVersion: "pose-v1",
    featureSchemaVersion: "features-v1",
    scorerContractVersion: "scorer-v1",
    fingerprintPolicyVersion: "fingerprint-v1",
    integrityPolicyVersion: "integrity-v1",
    ownerPolicyRevision: 7,
    ownerPolicyHash: HASH_B,
    revisionTermsHash: revision === 1 ? HASH_A : HASH_C,
    ...overrides,
  };
}

function segment(overrides: Partial<DanceSongSegment> = {}): DanceSongSegment {
  return {
    segmentId: "segment-1",
    songPostId: "song-1",
    audioRevision: 4,
    startMs: 10_000,
    endMs: 16_000,
    durationMs: 6_000,
    canonicalAudioDurationMs: 180_000,
    canonicalSegmentSha256: HASH_A,
    extractionPolicyVersion: "extract-v1",
    sourceMediaSha256: HASH_B,
    segmentTermsHash: HASH_C,
    ...overrides,
  };
}

function createProcessing(): DanceChoreography {
  return value(
    createDanceChoreography({
      choreographyId: "choreography-1",
      songPostId: "song-1",
      creatorAccountId: "creator-1",
      creatorPersonaId: "persona-1",
      terms: terms(),
    }),
  );
}

function readyEvidence(
  overrides: Partial<DanceReferenceReadyEvidence> = {},
): DanceReferenceReadyEvidence {
  return {
    outcome: "ready",
    evidenceDigest: HASH_A,
    segment: segment(),
    referenceVideoScoredStartMs: 20_000,
    referenceVideoScoredEndMs: 26_000,
    referenceArtifactSha256: HASH_B,
    alignmentAccepted: true,
    timeStretchDetected: false,
    bodyCoverageAccepted: true,
    timelineEvidenceAccepted: true,
    visibilityEvidenceAccepted: true,
    subjectContinuityAccepted: true,
    meaningfulMotionAccepted: true,
    terminalAt: T0,
    ...overrides,
  };
}

function createReady(): DanceChoreography {
  return value(
    completeDanceReferenceProcessing(createProcessing(), {
      expectedVersion: 1,
      revision: 1,
      evidence: readyEvidence(),
    }),
  );
}

describe("Dance canonical segment decisions", () => {
  test("accepts exact 6000 and 30000 millisecond intervals and derives duration", () => {
    for (const [startMs, endMs] of [
      [0, 6_000],
      [5_000, 35_000],
    ] as const) {
      const decision = decideDanceSongSegmentCreation(null, {
        ...segment({ startMs, endMs, durationMs: endMs - startMs }),
      });
      expect(decision).toMatchObject({
        kind: "accepted",
        replayed: false,
        value: { durationMs: endMs - startMs },
      });
    }
  });

  test("rejects invalid half-open bounds and exact-identity disagreements", () => {
    expect(
      decideDanceSongSegmentCreation(null, {
        ...segment({ endMs: 15_999, durationMs: 5_999 }),
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_command" });
    const existing = segment();
    expect(decideDanceSongSegmentCreation(existing, { ...existing })).toMatchObject({
      kind: "accepted",
      replayed: true,
      value: existing,
    });
    expect(
      decideDanceSongSegmentCreation(existing, {
        ...existing,
        canonicalSegmentSha256: HASH_C,
      }),
    ).toEqual({ kind: "rejected", reason: "segment_identity_conflict" });
    expect(
      decideDanceSongSegmentCreation(existing, {
        ...existing,
        sourceMediaSha256: HASH_C,
      }),
    ).toEqual({ kind: "rejected", reason: "segment_identity_conflict" });
  });
});

describe("Dance choreography and reference reducers", () => {
  test("creates one processing revision and makes the first ready result active", () => {
    const processing = createProcessing();
    expect(processing).toMatchObject({
      version: 1,
      status: "processing",
      activeRevision: null,
      revisions: [{ status: "processing", terminalEvidence: null }],
    });
    const ready = createReady();
    expect(ready).toMatchObject({
      version: 2,
      status: "ready",
      activeRevision: 1,
      revisions: [{ status: "ready" }],
    });
    expect(danceChoreographyInvariant(ready)).toBeNull();
  });

  test("requires every readiness gate and forbids time stretching", () => {
    for (const evidence of [
      readyEvidence({ timelineEvidenceAccepted: false }),
      readyEvidence({ visibilityEvidenceAccepted: false }),
      readyEvidence({ subjectContinuityAccepted: false }),
      readyEvidence({ timeStretchDetected: true }),
      readyEvidence({ referenceVideoScoredEndMs: 25_999 }),
    ]) {
      expect(
        completeDanceReferenceProcessing(createProcessing(), {
          expectedVersion: 1,
          revision: 1,
          evidence,
        }),
      ).toEqual({ kind: "rejected", reason: "invalid_command" });
    }
  });

  test("makes terminal replay harmless and preserves the first result on conflict", () => {
    const processing = createProcessing();
    const evidence = readyEvidence();
    const ready = value(
      completeDanceReferenceProcessing(processing, {
        expectedVersion: 1,
        revision: 1,
        evidence,
      }),
    );
    expect(
      completeDanceReferenceProcessing(ready, {
        expectedVersion: 1,
        revision: 1,
        evidence,
      }),
    ).toMatchObject({ kind: "accepted", replayed: true, value: ready });
    expect(
      completeDanceReferenceProcessing(ready, {
        expectedVersion: 2,
        revision: 1,
        evidence: { ...evidence, evidenceDigest: HASH_C },
      }),
    ).toEqual({ kind: "rejected", reason: "terminal_result_conflict" });
  });

  test("retries failed processing only through a new append-only revision", () => {
    const failed = value(
      completeDanceReferenceProcessing(createProcessing(), {
        expectedVersion: 1,
        revision: 1,
        evidence: {
          outcome: "processing_failed",
          evidenceDigest: HASH_A,
          failureCode: "insufficient_motion",
          terminalAt: T0,
        },
      }),
    );
    expect(failed).toMatchObject({ status: "processing", version: 2 });
    expect(
      completeDanceReferenceProcessing(failed, {
        expectedVersion: 2,
        revision: 1,
        evidence: readyEvidence(),
      }),
    ).toEqual({ kind: "rejected", reason: "terminal_result_conflict" });
    const retry = value(
      appendDanceChoreographyRevision(failed, {
        expectedVersion: 2,
        actorAccountId: "creator-1",
        terms: terms(2),
      }),
    );
    expect(retry.revisions.map((revision) => revision.status)).toEqual([
      "processing_failed",
      "processing",
    ]);
  });

  test("rejects changed terms at an existing revision and preserves ready revisions", () => {
    const ready = createReady();
    expect(
      appendDanceChoreographyRevision(ready, {
        expectedVersion: 2,
        actorAccountId: "creator-1",
        terms: terms(1, { referenceVideoPostId: "changed-video" }),
      }),
    ).toEqual({ kind: "rejected", reason: "revision_identity_conflict" });
    const appended = value(
      appendDanceChoreographyRevision(ready, {
        expectedVersion: 2,
        actorAccountId: "creator-1",
        terms: terms(2),
      }),
    );
    expect(appended).toMatchObject({ status: "ready", activeRevision: 1, version: 3 });
    expect(appended.revisions[0]).toEqual(ready.revisions[0]);
  });

  test("moves only the presentation default to another ready revision", () => {
    const firstReady = createReady();
    const processingSecond = value(
      appendDanceChoreographyRevision(firstReady, {
        expectedVersion: 2,
        actorAccountId: "creator-1",
        terms: terms(2),
      }),
    );
    const bothReady = value(
      completeDanceReferenceProcessing(processingSecond, {
        expectedVersion: 3,
        revision: 2,
        evidence: readyEvidence({
          evidenceDigest: HASH_C,
          segment: segment({ segmentId: "segment-2" }),
          terminalAt: T1,
        }),
      }),
    );
    expect(selectActiveDanceRevision(bothReady, 4, "not-creator", 2)).toEqual({
      kind: "rejected",
      reason: "creator_required",
    });
    const selected = value(selectActiveDanceRevision(bothReady, 4, "creator-1", 2));
    expect(selected).toMatchObject({ version: 5, activeRevision: 2 });
    expect(selected.revisions.map((revision) => revision.status)).toEqual(["ready", "ready"]);
  });

  test("records terminal cutoffs and will not accept late provider completion", () => {
    const processing = createProcessing();
    const disabled = value(disableDanceChoreography(processing, 1, T1, "rights"));
    expect(disabled).toMatchObject({
      status: "disabled",
      disabledReason: "rights",
      disabledAt: T1,
      version: 2,
    });
    expect(
      completeDanceReferenceProcessing(disabled, {
        expectedVersion: 2,
        revision: 1,
        evidence: readyEvidence(),
      }),
    ).toEqual({ kind: "rejected", reason: "transition_not_allowed" });
    const retired = value(retireDanceChoreography(disabled, 2, T2));
    expect(retired).toMatchObject({ status: "retired", retiredAt: T2, version: 3 });
    expect(retireDanceChoreography(createReady(), 2, T2)).toEqual({
      kind: "rejected",
      reason: "transition_not_allowed",
    });
  });
});

describe("Dance featured presentation and cutoff decisions", () => {
  test("allows only the exact song owner to feature an exact ready revision", () => {
    const ready = createReady();
    const command = {
      expectedPresentationRevision: 0,
      actorAccountId: "song-owner",
      songOwnerAccountId: "song-owner",
      songPostId: "song-1",
      audioRevision: 4,
      choreography: ready,
      choreographyRevision: 1,
      updatedAt: T1,
    } as const;
    const presentation = value(setDanceSongPresentation(null, command));
    expect(presentation).toMatchObject({
      presentationRevision: 1,
      featured: { choreographyId: "choreography-1", choreographyRevision: 1 },
    });
    expect(setDanceSongPresentation(presentation, command)).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(setDanceSongPresentation(null, { ...command, actorAccountId: "not-owner" })).toEqual({
      kind: "rejected",
      reason: "song_owner_required",
    });
    expect(setDanceSongPresentation(null, { ...command, audioRevision: 5 })).toEqual({
      kind: "rejected",
      reason: "target_not_selectable",
    });
  });

  test("clearing changes presentation only and is idempotent", () => {
    const presentation = value(
      setDanceSongPresentation(null, {
        expectedPresentationRevision: 0,
        actorAccountId: "song-owner",
        songOwnerAccountId: "song-owner",
        songPostId: "song-1",
        audioRevision: 4,
        choreography: createReady(),
        choreographyRevision: 1,
        updatedAt: T1,
      }),
    );
    const clear = {
      expectedPresentationRevision: 1,
      actorAccountId: "song-owner",
      songOwnerAccountId: "song-owner",
      songPostId: "song-1",
      audioRevision: 4,
      updatedAt: T2,
    } as const;
    const cleared = value(clearDanceSongPresentation(presentation, clear));
    expect(cleared).toMatchObject({ presentationRevision: 2, featured: null });
    expect(clearDanceSongPresentation(cleared, clear)).toMatchObject({
      kind: "accepted",
      replayed: true,
      value: cleared,
    });
  });

  test("applies the no-new-session boundary without rewriting frozen attempts", () => {
    const base = {
      cutoffAt: T2,
      uploadSealedAt: null,
      gradingDispatchDurablyPendingAt: null,
      terminalResultDurablyPendingAt: null,
    } as const;
    expect(decideDanceRightsSafetyCutoff({ ...base, operation: "create_session" })).toEqual({
      kind: "reject_new_session",
    });
    expect(decideDanceRightsSafetyCutoff({ ...base, operation: "continue_existing" })).toEqual({
      kind: "abandon",
      reason: "reference_disabled_before_upload",
    });
    expect(
      decideDanceRightsSafetyCutoff({
        ...base,
        operation: "continue_existing",
        uploadSealedAt: T0,
        gradingDispatchDurablyPendingAt: T1,
      }),
    ).toEqual({ kind: "finalize_frozen_attempt" });
    expect(
      decideDanceRightsSafetyCutoff({
        ...base,
        operation: "continue_existing",
        uploadSealedAt: T0,
        gradingDispatchDurablyPendingAt: T2,
      }),
    ).toEqual({ kind: "reject_new_attempt" });
  });
});
