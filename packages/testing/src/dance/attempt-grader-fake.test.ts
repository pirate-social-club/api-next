import { describe, expect, test } from "bun:test";
import type {
  DanceAttemptProcessingBinding,
  FrozenDanceAttemptInput,
} from "@pirate/application/dance/attempt-processing";
import { Effect } from "effect";
import {
  DANCE_ATTEMPT_FEATURE_FIXTURES,
  type DanceAttemptFeatureFixture,
} from "./attempt-feature-fixtures.ts";
import {
  evaluateDanceSyntheticFeatureFixture,
  makeDanceAttemptFeatureFixtureGrader,
} from "./attempt-grader-fake.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const input: FrozenDanceAttemptInput = {
  version: "frozen-dance-attempt-input-v1",
  attemptId: "fixture-attempt-1",
  sessionId: "fixture-session-1",
  inputDigest: HASH_A,
  privateMediaRef: "private/fixture-attempt-1",
  sealedMediaSha256: HASH_B,
  segmentId: "fixture-segment-1",
  choreographyId: "fixture-choreography-1",
  choreographyRevision: 1,
  referenceArtifactRef: "private/fixture-reference-1",
  referenceArtifactSha256: HASH_C,
  scoredWindowStartMs: 2_000,
  scoredWindowEndMs: 8_000,
  expectedScoredDurationMs: 6_000,
  policy: {
    capturedAdmissionState: "shadow",
    poseModelVersion: "synthetic-pose-v1",
    featureSchemaVersion: "synthetic-features-v1",
    scorerContractVersion: "synthetic-scorer-v1",
    mirrorPolicyVersion: "synthetic-mirror-v1",
    fingerprintPolicyVersion: "synthetic-fingerprint-v1",
    fingerprintKeyVersion: "synthetic-fingerprint-key-v1",
    integrityPolicyVersion: "synthetic-integrity-v1",
    graderAdapterVersion: "synthetic-fixture-grader-v1",
  },
};

const binding: DanceAttemptProcessingBinding = {
  version: "dance-attempt-processing-binding-v1",
  effectIdentity: "dance-attempt:fixture-attempt-1",
  attemptId: "fixture-attempt-1",
  inputDigest: HASH_A,
  attemptNumber: 1,
  claimOwner: "fixture-worker-1",
  claimFence: 1,
};

function fixture(id: string): DanceAttemptFeatureFixture {
  const found = DANCE_ATTEMPT_FEATURE_FIXTURES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing Dance feature fixture: ${id}`);
  return found;
}

const gateCases = [
  ["identical", "similarity_candidate"],
  ["bounded_honest_variation", "similarity_candidate"],
  ["first_second_truncation", "integrity_reject"],
  ["reverse", "integrity_reject"],
  ["shuffle", "integrity_reject"],
  ["unrelated_movement", "integrity_reject"],
  ["exact_reference_replay", "replay_reject"],
  ["transcoded_reference_replay", "replay_reject"],
  ["near_reference_replay", "replay_reject"],
  ["visibility_reduction", "integrity_reject"],
  ["omitted_timestamps", "integrity_reject"],
  ["stillness", "integrity_reject"],
  ["trivial_motion", "integrity_reject"],
  ["multiple_people", "integrity_reject"],
  ["ambiguous_subject_continuity", "integrity_reject"],
  ["subject_identity_swap", "integrity_reject"],
  ["malformed_timeline", "integrity_reject"],
  ["non_finite_input", "integrity_reject"],
  ["repeat_agreement_a", "similarity_candidate"],
  ["repeat_agreement_b", "similarity_candidate"],
] as const;

describe("test-only Dance feature fixture grader", () => {
  test.each(gateCases)("evaluates %s as %s", (fixtureId, expectedGate) => {
    const selected = fixture(fixtureId);
    expect(evaluateDanceSyntheticFeatureFixture(selected).gate).toBe(expectedGate);
    expect(selected.expectedGate).toBe(expectedGate);
  });

  test("rejects each attack through its actual synthetic evidence", () => {
    expect(evaluateDanceSyntheticFeatureFixture(fixture("first_second_truncation"))).toMatchObject({
      rejectionCode: "timeline_evidence_insufficient",
    });
    for (const id of ["reverse", "shuffle", "unrelated_movement"]) {
      expect(evaluateDanceSyntheticFeatureFixture(fixture(id))).toMatchObject({
        rejectionCode: "synthetic_ordering_mismatch",
      });
    }
    expect(evaluateDanceSyntheticFeatureFixture(fixture("visibility_reduction"))).toMatchObject({
      rejectionCode: "timeline_evidence_insufficient",
      usableCoverageBps: 0,
    });
    expect(evaluateDanceSyntheticFeatureFixture(fixture("omitted_timestamps"))).toMatchObject({
      rejectionCode: "timeline_evidence_insufficient",
    });
    for (const id of ["stillness", "trivial_motion"]) {
      expect(evaluateDanceSyntheticFeatureFixture(fixture(id))).toMatchObject({
        rejectionCode: "meaningful_motion_insufficient",
      });
    }
    expect(evaluateDanceSyntheticFeatureFixture(fixture("multiple_people"))).toMatchObject({
      rejectionCode: "multiple_people",
    });
    expect(
      evaluateDanceSyntheticFeatureFixture(fixture("ambiguous_subject_continuity")),
    ).toMatchObject({ rejectionCode: "ambiguous_subject_continuity" });
    expect(evaluateDanceSyntheticFeatureFixture(fixture("subject_identity_swap"))).toMatchObject({
      rejectionCode: "subject_identity_swap",
    });
    for (const id of ["malformed_timeline", "non_finite_input"]) {
      expect(evaluateDanceSyntheticFeatureFixture(fixture(id)).gate).toBe("integrity_reject");
    }
  });

  test("emits only rejected shadow evidence and never invents a synthetic score", async () => {
    for (const selected of DANCE_ATTEMPT_FEATURE_FIXTURES) {
      const outcome = await Effect.runPromise(
        makeDanceAttemptFeatureFixtureGrader(selected).grade(input, binding),
      );
      expect(outcome.binding).toEqual(binding);
      expect(outcome.gradeOutcome).toBe("rejected");
      expect(outcome.qualificationOutcome).toBe("suppressed_shadow");
      expect(outcome.scoreBps).toBeNull();
      if (selected.expectedGate === "integrity_reject") {
        expect(outcome.evidenceSummary).toBeNull();
        expect(outcome.fingerprint).toBeNull();
      } else {
        expect(outcome.evidenceSummary).not.toBeNull();
        expect(outcome.fingerprint).not.toBeNull();
      }
    }
  });

  test("keeps repeat controls deterministic and replay fingerprints comparable", async () => {
    const repeatA = await Effect.runPromise(
      makeDanceAttemptFeatureFixtureGrader(fixture("repeat_agreement_a")).grade(input, binding),
    );
    const repeatB = await Effect.runPromise(
      makeDanceAttemptFeatureFixtureGrader(fixture("repeat_agreement_b")).grade(input, binding),
    );
    expect(repeatA).toEqual(repeatB);

    const identical = await Effect.runPromise(
      makeDanceAttemptFeatureFixtureGrader(fixture("identical")).grade(input, binding),
    );
    const replay = await Effect.runPromise(
      makeDanceAttemptFeatureFixtureGrader(fixture("exact_reference_replay")).grade(input, binding),
    );
    expect(replay.rejectionCode).toBe("synthetic_reference_replay");
    expect(replay.fingerprint?.wholeSequenceFingerprint).toBe(
      identical.fingerprint?.wholeSequenceFingerprint,
    );
  });
});
