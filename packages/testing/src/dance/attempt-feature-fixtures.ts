export type DanceSyntheticFeatureFrame = Readonly<{
  timestampMs: number;
  principalTrackId: string | null;
  visibleTrackIds: readonly string[];
  continuityAmbiguous: boolean;
  visibilityBps: number;
  motionUnits: number;
  normalizedFeatures: readonly number[];
}>;

export type DanceAttemptFeatureFixture = Readonly<{
  id: string;
  class:
    | "honest"
    | "ordering_attack"
    | "replay_attack"
    | "evidence_failure"
    | "continuity_failure"
    | "malformed"
    | "repeat_agreement";
  expectedGate: "similarity_candidate" | "integrity_reject" | "replay_reject";
  frames: readonly DanceSyntheticFeatureFrame[];
}>;

const FRAME_STEP_MS = 40;
const FRAME_COUNT = 150;

function baseFrames(): readonly DanceSyntheticFeatureFrame[] {
  return Array.from({ length: FRAME_COUNT }, (_, index) => ({
    timestampMs: index * FRAME_STEP_MS,
    principalTrackId: "synthetic-body-a",
    visibleTrackIds: ["synthetic-body-a"],
    continuityAmbiguous: false,
    visibilityBps: 9_000,
    motionUnits: index === 0 ? 0 : 120 + (index % 7),
    normalizedFeatures: [index * 3, (index % 17) * 5, (index % 11) * 7, index % 2],
  }));
}

function withFeatureOrder(
  frames: readonly DanceSyntheticFeatureFrame[],
  sourceIndex: (index: number) => number,
): readonly DanceSyntheticFeatureFrame[] {
  return frames.map((frame, index) => {
    const source = frames[sourceIndex(index)];
    if (source === undefined) throw new Error("Synthetic Dance fixture index is out of bounds");
    return {
      ...frame,
      motionUnits: source.motionUnits,
      normalizedFeatures: source.normalizedFeatures,
    };
  });
}

function fixture(
  id: string,
  fixtureClass: DanceAttemptFeatureFixture["class"],
  expectedGate: DanceAttemptFeatureFixture["expectedGate"],
  frames: readonly DanceSyntheticFeatureFrame[],
): DanceAttemptFeatureFixture {
  return { id, class: fixtureClass, expectedGate, frames };
}

/**
 * Checked-in policy fixtures, generated from integers only. They are not pose
 * landmarks, recordings, provider output, calibration data, or score floors.
 */
export function makeDanceAttemptFeatureFixtures(): readonly DanceAttemptFeatureFixture[] {
  const base = baseFrames();
  const boundedVariation = base.map((frame, index) => ({
    ...frame,
    normalizedFeatures: frame.normalizedFeatures.map((value) => value + (index % 3) - 1),
  }));
  const reversed = withFeatureOrder(base, (index) => FRAME_COUNT - index - 1);
  const shuffled = withFeatureOrder(base, (index) => (index * 37) % FRAME_COUNT);
  const unrelated = base.map((frame, index) => ({
    ...frame,
    normalizedFeatures: [2_000 - index * 2, 1_000 + index * 11, 500 - index * 3, 9],
  }));
  const visibilityReduced = base.map((frame) => ({ ...frame, visibilityBps: 4_000 }));
  const omittedTimestamps = base.filter((_, index) => index < 60 || index >= 85);
  const stillness = base.map((frame) => ({
    ...frame,
    motionUnits: 0,
    normalizedFeatures: [10, 10, 10, 0],
  }));
  const trivialMotion = base.map((frame, index) => ({
    ...frame,
    motionUnits: index === 0 ? 0 : 1,
    normalizedFeatures: [10 + (index % 2), 10, 10, 0],
  }));
  const multiplePeople = base.map((frame, index) =>
    index === 75 ? { ...frame, visibleTrackIds: ["synthetic-body-a", "synthetic-body-b"] } : frame,
  );
  const ambiguousContinuity = base.map((frame, index) =>
    index === 75 ? { ...frame, continuityAmbiguous: true } : frame,
  );
  const subjectSwap = base.map((frame, index) =>
    index < 75
      ? frame
      : {
          ...frame,
          principalTrackId: "synthetic-body-b",
          visibleTrackIds: ["synthetic-body-b"],
        },
  );
  const malformedTimeline = base.map((frame, index) =>
    index === 75 ? { ...frame, timestampMs: base[74]?.timestampMs ?? 0 } : frame,
  );
  const nonFiniteInput = base.map((frame, index) =>
    index === 75 ? { ...frame, normalizedFeatures: [Number.POSITIVE_INFINITY, 0, 0, 0] } : frame,
  );
  const transcodedReplay = base.map((frame, index) => ({
    ...frame,
    normalizedFeatures: frame.normalizedFeatures.map((value) => value + (index % 2)),
  }));
  const nearReplay = base.map((frame, index) => ({
    ...frame,
    normalizedFeatures: frame.normalizedFeatures.map((value) => value + (index % 5) - 2),
  }));

  return [
    fixture("identical", "honest", "similarity_candidate", base),
    fixture("bounded_honest_variation", "honest", "similarity_candidate", boundedVariation),
    fixture("first_second_truncation", "evidence_failure", "integrity_reject", base.slice(25)),
    fixture("reverse", "ordering_attack", "integrity_reject", reversed),
    fixture("shuffle", "ordering_attack", "integrity_reject", shuffled),
    fixture("unrelated_movement", "ordering_attack", "integrity_reject", unrelated),
    fixture("exact_reference_replay", "replay_attack", "replay_reject", base),
    fixture("transcoded_reference_replay", "replay_attack", "replay_reject", transcodedReplay),
    fixture("near_reference_replay", "replay_attack", "replay_reject", nearReplay),
    fixture("visibility_reduction", "evidence_failure", "integrity_reject", visibilityReduced),
    fixture("omitted_timestamps", "evidence_failure", "integrity_reject", omittedTimestamps),
    fixture("stillness", "evidence_failure", "integrity_reject", stillness),
    fixture("trivial_motion", "evidence_failure", "integrity_reject", trivialMotion),
    fixture("multiple_people", "continuity_failure", "integrity_reject", multiplePeople),
    fixture(
      "ambiguous_subject_continuity",
      "continuity_failure",
      "integrity_reject",
      ambiguousContinuity,
    ),
    fixture("subject_identity_swap", "continuity_failure", "integrity_reject", subjectSwap),
    fixture("malformed_timeline", "malformed", "integrity_reject", malformedTimeline),
    fixture("non_finite_input", "malformed", "integrity_reject", nonFiniteInput),
    fixture("repeat_agreement_a", "repeat_agreement", "similarity_candidate", base),
    fixture("repeat_agreement_b", "repeat_agreement", "similarity_candidate", baseFrames()),
  ];
}

export const DANCE_ATTEMPT_FEATURE_FIXTURES = makeDanceAttemptFeatureFixtures();
