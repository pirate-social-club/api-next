import { describe, expect, test } from "bun:test";
import {
  DANCE_ATTEMPT_FEATURE_FIXTURES,
  makeDanceAttemptFeatureFixtures,
} from "./attempt-feature-fixtures.ts";

const byId = (id: string) => {
  const found = DANCE_ATTEMPT_FEATURE_FIXTURES.find((fixture) => fixture.id === id);
  if (found === undefined) throw new Error(`Missing Dance feature fixture: ${id}`);
  return found;
};

describe("Dance attempt synthetic feature fixtures", () => {
  test("freezes the complete first-tranche case inventory without biometric material", () => {
    expect(DANCE_ATTEMPT_FEATURE_FIXTURES.map((fixture) => fixture.id)).toEqual([
      "identical",
      "bounded_honest_variation",
      "first_second_truncation",
      "reverse",
      "shuffle",
      "unrelated_movement",
      "exact_reference_replay",
      "transcoded_reference_replay",
      "near_reference_replay",
      "visibility_reduction",
      "omitted_timestamps",
      "stillness",
      "trivial_motion",
      "multiple_people",
      "ambiguous_subject_continuity",
      "subject_identity_swap",
      "malformed_timeline",
      "non_finite_input",
      "repeat_agreement_a",
      "repeat_agreement_b",
    ]);
    const encoded = JSON.stringify(DANCE_ATTEMPT_FEATURE_FIXTURES);
    for (const forbidden of [
      "landmark",
      "recording",
      "participant",
      "provider",
      "credential",
      "scoreBps",
      "platformFloor",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  test("keeps truncation and decoder holes on their original timeline", () => {
    expect(byId("first_second_truncation").frames[0]?.timestampMs).toBe(1_000);
    const timestamps = byId("omitted_timestamps").frames.map((frame) => frame.timestampMs);
    expect(timestamps).toContain(2_360);
    expect(timestamps).toContain(3_400);
    expect(timestamps).not.toContain(2_400);
    expect(timestamps).not.toContain(3_360);
  });

  test("reduces visibility without changing normalized error evidence", () => {
    const identical = byId("identical").frames;
    const reduced = byId("visibility_reduction").frames;
    expect(reduced.map((frame) => frame.normalizedFeatures)).toEqual(
      identical.map((frame) => frame.normalizedFeatures),
    );
    expect(reduced.every((frame) => frame.visibilityBps < 5_000)).toBe(true);
  });

  test("makes subject-continuity failures explicit and keeps one stable-body control", () => {
    expect(
      byId("identical").frames.every(
        (frame) =>
          frame.principalTrackId === "synthetic-body-a" &&
          frame.visibleTrackIds.length === 1 &&
          !frame.continuityAmbiguous,
      ),
    ).toBe(true);
    expect(byId("multiple_people").frames.some((frame) => frame.visibleTrackIds.length > 1)).toBe(
      true,
    );
    expect(
      byId("ambiguous_subject_continuity").frames.some((frame) => frame.continuityAmbiguous),
    ).toBe(true);
    expect(
      new Set(byId("subject_identity_swap").frames.map((frame) => frame.principalTrackId)).size,
    ).toBe(2);
  });

  test("distinguishes motion and ordering attacks without assigning synthetic scores", () => {
    expect(byId("stillness").frames.every((frame) => frame.motionUnits === 0)).toBe(true);
    expect(Math.max(...byId("trivial_motion").frames.map((frame) => frame.motionUnits))).toBe(1);
    expect(byId("reverse").frames[0]?.normalizedFeatures).toEqual(
      byId("identical").frames.at(-1)?.normalizedFeatures,
    );
    expect(byId("shuffle").frames.map((frame) => frame.normalizedFeatures)).not.toEqual(
      byId("identical").frames.map((frame) => frame.normalizedFeatures),
    );
  });

  test("is deterministic across generation and repeated-agreement controls", () => {
    expect(makeDanceAttemptFeatureFixtures()).toEqual(makeDanceAttemptFeatureFixtures());
    expect(byId("repeat_agreement_a").frames).toEqual(byId("repeat_agreement_b").frames);
  });
});
