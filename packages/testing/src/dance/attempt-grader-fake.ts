import {
  type DanceAttemptGraderAdapter,
  DanceAttemptProcessingInvalid,
  type DanceAttemptProcessingOutcome,
  type FrozenDanceAttemptInput,
} from "@pirate/application/dance/attempt-processing";
import {
  evaluateDanceSubjectContinuity,
  evaluateDanceTimelineEvidence,
} from "@pirate/domain/dance";
import { Effect } from "effect";
import {
  DANCE_ATTEMPT_FEATURE_FIXTURES,
  type DanceAttemptFeatureFixture,
} from "./attempt-feature-fixtures.ts";

const SYNTHETIC_FRAME_STEP_MS = 40;
const SYNTHETIC_WINDOW_END_MS = 6_000;
const MINIMUM_USABLE_VISIBILITY_BPS = 5_000;
const MINIMUM_USABLE_COVERAGE_BPS = 9_000;
const MAXIMUM_MISSING_GAP_SLOTS = 5;
const MINIMUM_MEANINGFUL_MOTION_UNITS = 100;
const MAXIMUM_SYNTHETIC_ERROR_UNITS_PER_FEATURE = 8;

export type DanceSyntheticFixtureGate = Readonly<{
  gate: "similarity_candidate" | "integrity_reject" | "replay_reject";
  rejectionCode: string | null;
  usableCoverageBps: number;
  meaningfulMotionAccepted: boolean;
}>;

const canonicalReference: DanceAttemptFeatureFixture = (() => {
  const found = DANCE_ATTEMPT_FEATURE_FIXTURES.find((fixture) => fixture.id === "identical");
  if (found === undefined) throw new Error("The synthetic Dance reference fixture is missing");
  return found;
})();

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function malformed(fixture: DanceAttemptFeatureFixture): boolean {
  const expectedFeatureCount = canonicalReference.frames[0]?.normalizedFeatures.length;
  if (expectedFeatureCount === undefined || fixture.frames.length === 0) return true;
  return fixture.frames.some(
    (frame) =>
      !isSafeInteger(frame.timestampMs) ||
      !isSafeInteger(frame.visibilityBps) ||
      frame.visibilityBps < 0 ||
      frame.visibilityBps > 10_000 ||
      !isSafeInteger(frame.motionUnits) ||
      frame.motionUnits < 0 ||
      frame.normalizedFeatures.length !== expectedFeatureCount ||
      frame.normalizedFeatures.some((value) => !isSafeInteger(value)),
  );
}

function integrityRejection(
  rejectionCode: string,
  usableCoverageBps = 0,
  meaningfulMotionAccepted = false,
): DanceSyntheticFixtureGate {
  return {
    gate: "integrity_reject",
    rejectionCode,
    usableCoverageBps,
    meaningfulMotionAccepted,
  };
}

/**
 * Test-only fixture policy. It proves ordering, evidence, and integrity
 * behavior without defining a production score, coefficient, or floor.
 */
export function evaluateDanceSyntheticFeatureFixture(
  fixture: DanceAttemptFeatureFixture,
): DanceSyntheticFixtureGate {
  if (malformed(fixture)) return integrityRejection("malformed_feature_evidence");

  const timeline = evaluateDanceTimelineEvidence(
    {
      scoredStartMs: 0,
      scoredEndMs: SYNTHETIC_WINDOW_END_MS,
      scoringGridStepMs: SYNTHETIC_FRAME_STEP_MS,
      minimumUsableCoverageBps: MINIMUM_USABLE_COVERAGE_BPS,
      maximumMissingGapSlots: MAXIMUM_MISSING_GAP_SLOTS,
    },
    fixture.frames.map((frame) => ({
      timestampMs: frame.timestampMs,
      usable: frame.visibilityBps >= MINIMUM_USABLE_VISIBILITY_BPS,
    })),
  );
  if (timeline.kind === "rejected") return integrityRejection(timeline.reason);
  if (!timeline.value.accepted) {
    return integrityRejection("timeline_evidence_insufficient", timeline.value.usableCoverageBps);
  }

  const subject = evaluateDanceSubjectContinuity(fixture.frames);
  if (subject.kind === "rejected") {
    return integrityRejection(subject.reason, timeline.value.usableCoverageBps);
  }

  const meaningfulMotionAccepted = fixture.frames.some(
    (frame) => frame.motionUnits >= MINIMUM_MEANINGFUL_MOTION_UNITS,
  );
  if (!meaningfulMotionAccepted) {
    return integrityRejection("meaningful_motion_insufficient", timeline.value.usableCoverageBps);
  }

  const referenceByTimestamp = new Map(
    canonicalReference.frames.map((frame) => [frame.timestampMs, frame] as const),
  );
  let errorUnits = 0;
  let featureUnits = 0;
  for (const frame of fixture.frames) {
    const referenceFrame = referenceByTimestamp.get(frame.timestampMs);
    if (referenceFrame === undefined) {
      return integrityRejection(
        "malformed_timeline",
        timeline.value.usableCoverageBps,
        meaningfulMotionAccepted,
      );
    }
    for (let index = 0; index < frame.normalizedFeatures.length; index += 1) {
      const value = frame.normalizedFeatures[index];
      const referenceValue = referenceFrame.normalizedFeatures[index];
      if (value === undefined || referenceValue === undefined) {
        return integrityRejection(
          "malformed_feature_evidence",
          timeline.value.usableCoverageBps,
          meaningfulMotionAccepted,
        );
      }
      errorUnits += Math.abs(value - referenceValue);
      featureUnits += 1;
    }
  }
  if (featureUnits === 0 || errorUnits > featureUnits * MAXIMUM_SYNTHETIC_ERROR_UNITS_PER_FEATURE) {
    return integrityRejection(
      "synthetic_ordering_mismatch",
      timeline.value.usableCoverageBps,
      meaningfulMotionAccepted,
    );
  }

  if (fixture.class === "replay_attack") {
    // The fixture class is pre-labeled replay truth. It is not a production
    // perceptual detector and does not substitute for one.
    return {
      gate: "replay_reject",
      rejectionCode: "synthetic_reference_replay",
      usableCoverageBps: timeline.value.usableCoverageBps,
      meaningfulMotionAccepted,
    };
  }
  return {
    gate: "similarity_candidate",
    rejectionCode: null,
    usableCoverageBps: timeline.value.usableCoverageBps,
    meaningfulMotionAccepted,
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

async function outcomeFor(
  fixture: DanceAttemptFeatureFixture,
  input: FrozenDanceAttemptInput,
  binding: Parameters<DanceAttemptGraderAdapter["grade"]>[1],
): Promise<DanceAttemptProcessingOutcome> {
  const decision = evaluateDanceSyntheticFeatureFixture(fixture);
  const fingerprintMaterial = {
    version: "synthetic-dance-fingerprint-v1",
    frames: fixture.frames.map((frame) => ({
      timestampMs: frame.timestampMs,
      normalizedFeatures: frame.normalizedFeatures,
    })),
  };
  const fingerprint =
    decision.gate === "integrity_reject"
      ? null
      : {
          claimId: `synthetic-${binding.attemptId}-${binding.claimFence}`,
          policyVersion: input.policy.fingerprintPolicyVersion,
          keyVersion: input.policy.fingerprintKeyVersion,
          matchScope: "platform_wide" as const,
          accountScopeId: null,
          wholeSequenceFingerprint: await sha256(fingerprintMaterial),
          segmentFingerprints: [
            await sha256({ ...fingerprintMaterial, segmentId: input.segmentId }),
          ],
        };
  const rejectionCode =
    decision.gate === "similarity_candidate"
      ? "synthetic_similarity_candidate_only"
      : (decision.rejectionCode ?? "synthetic_integrity_reject");
  const evidenceDigest = await sha256({
    version: "synthetic-dance-evidence-v1",
    binding,
    inputDigest: input.inputDigest,
    decision,
    fingerprintMaterial,
  });
  return {
    version: "dance-attempt-processing-outcome-v1",
    binding,
    gradeOutcome: "rejected",
    qualificationOutcome: "suppressed_shadow",
    scoreBps: null,
    rejectionCode,
    scoredWindowStartMs: input.scoredWindowStartMs,
    scoredWindowEndMs: input.scoredWindowEndMs,
    scoredDurationMs: input.expectedScoredDurationMs,
    evidenceSummary:
      fingerprint === null
        ? null
        : {
            schema_version: 1,
            usable_coverage_bps: decision.usableCoverageBps,
            selected_mirror: "original",
            meaningful_motion_accepted: decision.meaningfulMotionAccepted,
            replay_outcome: decision.gate === "replay_reject" ? "rejected" : "unique",
            subject_continuity: "stable",
          },
    evidenceDigest,
    fingerprint,
  };
}

/** Explicit test injection only; production composition must never import this package. */
export function makeDanceAttemptFeatureFixtureGrader(
  fixture: DanceAttemptFeatureFixture,
): DanceAttemptGraderAdapter {
  return {
    grade: (input, binding) =>
      Effect.tryPromise({
        try: () => outcomeFor(fixture, input, binding),
        catch: () => new DanceAttemptProcessingInvalid({ phase: "adapter" }),
      }),
  };
}
