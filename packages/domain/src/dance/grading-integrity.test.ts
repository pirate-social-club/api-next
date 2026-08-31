import { describe, expect, test } from "bun:test";
import {
  type DanceFingerprintClaimEvidence,
  type DanceFingerprintPolicy,
  decideDanceFingerprintClaim,
  evaluateDanceGradingIntegrity,
  evaluateDanceSubjectContinuity,
  evaluateDanceTimelineEvidence,
  reduceDanceFeatureEvidence,
  validateDanceVisibilityMonotonicity,
} from "./grading-integrity";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);

describe("Dance decoded-timeline evidence", () => {
  const policy = {
    scoredStartMs: 1_000,
    scoredEndMs: 1_200,
    scoringGridStepMs: 40,
    minimumUsableCoverageBps: 8_000,
    maximumMissingGapSlots: 1,
  } as const;

  test("keeps omitted decoder timestamps as missing fixed-grid slots", () => {
    const evidence = evaluateDanceTimelineEvidence(policy, [
      { timestampMs: 1_000, usable: true },
      { timestampMs: 1_040, usable: true },
      { timestampMs: 1_160, usable: true },
    ]);
    expect(evidence).toEqual({
      kind: "accepted",
      value: {
        expectedSlotCount: 5,
        decodedFrameCount: 3,
        usableSlotCount: 3,
        usableCoverageBps: 6_000,
        maximumMissingGapSlots: 2,
        missingSlotIndexes: [2, 3],
        accepted: false,
      },
    });
  });

  test("counts unusable frames against coverage rather than deleting them", () => {
    expect(
      evaluateDanceTimelineEvidence(policy, [
        { timestampMs: 1_000, usable: true },
        { timestampMs: 1_040, usable: true },
        { timestampMs: 1_080, usable: false },
        { timestampMs: 1_120, usable: true },
        { timestampMs: 1_160, usable: true },
      ]),
    ).toMatchObject({
      kind: "accepted",
      value: {
        expectedSlotCount: 5,
        decodedFrameCount: 5,
        usableSlotCount: 4,
        usableCoverageBps: 8_000,
        maximumMissingGapSlots: 1,
        missingSlotIndexes: [2],
        accepted: true,
      },
    });
  });

  test("rejects nonmonotonic timestamps and two observations compressed into one slot", () => {
    expect(
      evaluateDanceTimelineEvidence(policy, [
        { timestampMs: 1_040, usable: true },
        { timestampMs: 1_000, usable: true },
      ]),
    ).toEqual({ kind: "rejected", reason: "malformed_timeline" });
    expect(
      evaluateDanceTimelineEvidence(policy, [
        { timestampMs: 1_000, usable: true },
        { timestampMs: 1_020, usable: true },
      ]),
    ).toEqual({ kind: "rejected", reason: "malformed_timeline" });
  });
});

describe("Dance visibility evidence", () => {
  test("uses visibility only for usability and never scales error", () => {
    expect(
      reduceDanceFeatureEvidence({
        errorUnits: 700,
        visibilityBps: 9_000,
        minimumUsableVisibilityBps: 5_000,
      }),
    ).toEqual({ kind: "accepted", value: { kind: "usable", errorUnits: 700 } });
    expect(
      reduceDanceFeatureEvidence({
        errorUnits: 700,
        visibilityBps: 5_000,
        minimumUsableVisibilityBps: 5_000,
      }),
    ).toEqual({ kind: "accepted", value: { kind: "usable", errorUnits: 700 } });
    expect(
      reduceDanceFeatureEvidence({
        errorUnits: 700,
        visibilityBps: 4_999,
        minimumUsableVisibilityBps: 5_000,
      }),
    ).toEqual({ kind: "accepted", value: { kind: "excluded" } });
  });

  test("forbids a score increase when otherwise identical visibility is reduced", () => {
    const baseline = {
      kind: "scored",
      scoreBps: 7_200,
      usableEvidenceUnits: 100,
      confidenceEvidenceBps: 9_000,
    } as const;
    expect(
      validateDanceVisibilityMonotonicity({
        baseline,
        affectedEvidenceWasAlreadyExcluded: false,
        reducedVisibility: {
          kind: "scored",
          scoreBps: 7_201,
          usableEvidenceUnits: 90,
          confidenceEvidenceBps: 8_000,
        },
      }),
    ).toEqual({ kind: "rejected", reason: "visibility_cannot_improve_score" });
    expect(
      validateDanceVisibilityMonotonicity({
        baseline,
        affectedEvidenceWasAlreadyExcluded: false,
        reducedVisibility: {
          kind: "scored",
          scoreBps: 7_100,
          usableEvidenceUnits: 90,
          confidenceEvidenceBps: 8_000,
        },
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(
      validateDanceVisibilityMonotonicity({
        baseline,
        affectedEvidenceWasAlreadyExcluded: false,
        reducedVisibility: { kind: "rejected", reason: "insufficient_evidence" },
      }),
    ).toMatchObject({ kind: "accepted" });
  });

  test("allows unchanged scoring only when the evidence was already excluded", () => {
    const unchanged = {
      kind: "scored",
      scoreBps: 7_200,
      usableEvidenceUnits: 100,
      confidenceEvidenceBps: 9_000,
    } as const;
    expect(
      validateDanceVisibilityMonotonicity({
        baseline: unchanged,
        reducedVisibility: unchanged,
        affectedEvidenceWasAlreadyExcluded: true,
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(
      validateDanceVisibilityMonotonicity({
        baseline: unchanged,
        reducedVisibility: unchanged,
        affectedEvidenceWasAlreadyExcluded: false,
      }),
    ).toEqual({ kind: "rejected", reason: "visibility_outcome_invalid" });
  });
});

describe("Dance principal-subject continuity", () => {
  test("allows only one stable principal body to reach similarity scoring", () => {
    expect(
      evaluateDanceSubjectContinuity([
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a"],
          continuityAmbiguous: false,
        },
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a"],
          continuityAmbiguous: false,
        },
      ]),
    ).toEqual({
      kind: "accepted",
      value: { principalTrackId: "body-a", evaluatedFrameCount: 2 },
    });
  });

  test("fails closed for a second body, ambiguity, or identity swap", () => {
    expect(
      evaluateDanceSubjectContinuity([
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a", "body-b"],
          continuityAmbiguous: false,
        },
      ]),
    ).toEqual({ kind: "rejected", reason: "multiple_people" });
    expect(
      evaluateDanceSubjectContinuity([
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a"],
          continuityAmbiguous: true,
        },
      ]),
    ).toEqual({ kind: "rejected", reason: "ambiguous_subject_continuity" });
    expect(
      evaluateDanceSubjectContinuity([
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a"],
          continuityAmbiguous: false,
        },
        {
          principalTrackId: "body-b",
          visibleTrackIds: ["body-b"],
          continuityAmbiguous: false,
        },
      ]),
    ).toEqual({ kind: "rejected", reason: "subject_identity_swap" });
  });
});

describe("Dance replay fingerprint decisions", () => {
  const policy: DanceFingerprintPolicy = {
    policyVersion: "fingerprint-v1",
    keyVersion: "key-v3",
    matchScope: "platform_wide",
    segmentMatching: "required",
  };
  const claim: DanceFingerprintClaimEvidence = {
    policyVersion: "fingerprint-v1",
    keyVersion: "key-v3",
    matchScope: "platform_wide",
    wholeSequenceFingerprint: HASH_A,
    segmentFingerprints: [HASH_B],
    claimMethod: "atomic_claimed",
    claimedWithTerminalEvidence: true,
  };

  test("accepts atomic unique and duplicate outcomes joined to terminal evidence", () => {
    expect(decideDanceFingerprintClaim(policy, claim)).toEqual({
      kind: "accepted",
      value: {
        outcome: "unique",
        wholeSequenceFingerprint: HASH_A,
        segmentFingerprints: [HASH_B],
      },
    });
    expect(
      decideDanceFingerprintClaim(policy, { ...claim, claimMethod: "atomic_matched" }),
    ).toMatchObject({ kind: "accepted", value: { outcome: "duplicate" } });
  });

  test("rejects read-then-insert, detached claims, and empty required segments", () => {
    expect(
      decideDanceFingerprintClaim(policy, { ...claim, claimMethod: "read_then_insert" }),
    ).toEqual({ kind: "rejected", reason: "fingerprint_claim_not_atomic" });
    expect(
      decideDanceFingerprintClaim(policy, { ...claim, claimedWithTerminalEvidence: false }),
    ).toEqual({ kind: "rejected", reason: "fingerprint_claim_not_atomic" });
    expect(decideDanceFingerprintClaim(policy, { ...claim, segmentFingerprints: [] })).toEqual({
      kind: "rejected",
      reason: "fingerprint_material_malformed",
    });
  });

  test("permits an empty segment set only when policy explicitly disables matching", () => {
    expect(
      decideDanceFingerprintClaim(
        { ...policy, segmentMatching: "disabled" },
        { ...claim, segmentFingerprints: [] },
      ),
    ).toMatchObject({ kind: "accepted", value: { segmentFingerprints: [] } });
    expect(
      decideDanceFingerprintClaim(
        { ...policy, segmentMatching: "disabled" },
        { ...claim, segmentFingerprints: [HASH_B] },
      ),
    ).toEqual({ kind: "rejected", reason: "fingerprint_material_malformed" });
  });

  test("rejects policy, key, and scope mismatches before a terminal decision", () => {
    expect(
      decideDanceFingerprintClaim(policy, { ...claim, policyVersion: "fingerprint-v2" }),
    ).toEqual({ kind: "rejected", reason: "fingerprint_policy_mismatch" });
    expect(decideDanceFingerprintClaim(policy, { ...claim, keyVersion: "key-v4" })).toEqual({
      kind: "rejected",
      reason: "fingerprint_key_mismatch",
    });
    expect(decideDanceFingerprintClaim(policy, { ...claim, matchScope: "same_account" })).toEqual({
      kind: "rejected",
      reason: "fingerprint_scope_mismatch",
    });
  });

  test("composes all four checks from raw evidence without adapter pass flags", () => {
    const input = {
      timelinePolicy: {
        scoredStartMs: 0,
        scoredEndMs: 120,
        scoringGridStepMs: 40,
        minimumUsableCoverageBps: 10_000,
        maximumMissingGapSlots: 0,
      },
      decodedFrames: [
        { timestampMs: 0, usable: true },
        { timestampMs: 40, usable: true },
        { timestampMs: 80, usable: true },
      ],
      visibilityComparisons: [
        {
          baseline: {
            kind: "scored",
            scoreBps: 7_000,
            usableEvidenceUnits: 20,
            confidenceEvidenceBps: 9_000,
          },
          reducedVisibility: {
            kind: "scored",
            scoreBps: 6_900,
            usableEvidenceUnits: 18,
            confidenceEvidenceBps: 8_000,
          },
          affectedEvidenceWasAlreadyExcluded: false,
        },
      ],
      subjectFrames: [
        {
          principalTrackId: "body-a",
          visibleTrackIds: ["body-a"],
          continuityAmbiguous: false,
        },
      ],
      fingerprintPolicy: policy,
      fingerprintClaim: claim,
    } as const;
    expect(evaluateDanceGradingIntegrity(input)).toMatchObject({
      kind: "accepted",
      value: {
        timeline: { accepted: true, missingSlotIndexes: [] },
        subject: { principalTrackId: "body-a" },
        fingerprint: { outcome: "unique" },
        visibilityComparisonCount: 1,
      },
    });
    expect(
      evaluateDanceGradingIntegrity({
        ...input,
        decodedFrames: input.decodedFrames.filter((frame) => frame.timestampMs !== 40),
      }),
    ).toEqual({ kind: "rejected", reason: "timeline_evidence_insufficient" });
    expect(
      evaluateDanceGradingIntegrity({
        ...input,
        fingerprintClaim: { ...claim, claimMethod: "read_then_insert" },
      }),
    ).toEqual({ kind: "rejected", reason: "fingerprint_claim_not_atomic" });
  });
});
