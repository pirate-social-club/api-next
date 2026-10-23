import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { projectPrivateDanceReview } from "../../application/src/use-cases/dance/moderator-review-services.ts";
import {
  initializeModeratorReview,
  MODERATED_DANCE_REPLAY_RETIRED,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import {
  ModeratorReviewSchema,
  SealedModeratorCaptureSchema,
} from "../../domain/src/dance/moderator-review-schema.ts";
import { moderatedDanceFixture } from "../../testing/src/moderated-dance-fixture.ts";

function passed() {
  const base = moderatedDanceFixture(),
    f = {
      ...base,
      facts: {
        ...base.facts,
        submissionDay: { atMs: 2000, day: "1970-01-01", timezone: "UTC", timezoneVersion: "tz-v1" },
      },
    },
    c = f.state.capture;
  const submit = transitionModeratorReview(
    f.state,
    {
      kind: "submit",
      receiptId: "original-submit",
      showPublicly: false,
      disclosureVersion: c.policy.disclosureVersion,
    },
    { kind: "account", accountId: c.accountId },
    f.state.revision,
    2000,
    f.facts,
  );
  const screen = transitionModeratorReview(
    submit.state,
    { kind: "screen" },
    { kind: "worker", accountId: "test-worker" },
    submit.state.revision,
    3000,
    f.facts,
  );
  expect(submit.refusal).toBeNull();
  expect(screen.refusal).toBeNull();
  const result = transitionModeratorReview(
    screen.state,
    { kind: "verdict", version: "dance-owner-verdict-attestation-v1", verdict: "passed" },
    { kind: "account", accountId: f.facts.owner?.accountId ?? "missing-owner" },
    screen.state.revision,
    4000,
    f.facts,
  );
  expect(result.refusal).toBeNull();
  return { ...f, result: result.state };
}
describe("private replay retirement keeps the result without a replacement digest", () => {
  test("terminal result projection, qualification and attestation remain byte-identical", () => {
    const f = passed(),
      retired = {
        ...f.result,
        capture: { ...f.result.capture, normalizedDigest: MODERATED_DANCE_REPLAY_RETIRED },
      };
    const parsed = Schema.decodeUnknownSync(ModeratorReviewSchema)(retired);
    expect(projectPrivateDanceReview(parsed)).toEqual(projectPrivateDanceReview(f.result));
    expect(parsed.attestation).toEqual(f.result.attestation);
    expect(parsed.qualificationRef).toEqual(f.result.qualificationRef);
    expect(() => Schema.decodeUnknownSync(SealedModeratorCaptureSchema)(parsed.capture)).toThrow();
    expect(initializeModeratorReview(parsed.capture, f.facts, 1000)).toBeNull();
    expect(
      transitionModeratorReview(
        parsed,
        {
          kind: "visibility",
          showPublicly: true,
          disclosureVersion: parsed.capture.policy.disclosureVersion,
        },
        { kind: "account", accountId: parsed.capture.accountId },
        parsed.revision,
        5000,
        f.facts,
      ),
    ).toMatchObject({ refusal: "publication_choice_closed", intents: [] });
  });
  test("a live review or pending handoff cannot parse as retired", () => {
    const f = passed();
    const decode = Schema.decodeUnknownSync(ModeratorReviewSchema);
    expect(() =>
      decode({
        ...f.state,
        capture: { ...f.state.capture, normalizedDigest: MODERATED_DANCE_REPLAY_RETIRED },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...f.result,
        publication: "pending",
        capture: { ...f.result.capture, normalizedDigest: MODERATED_DANCE_REPLAY_RETIRED },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...f.result,
        capture: { ...f.result.capture, normalizedDigest: "invented-retirement-marker" },
      }),
    ).toThrow();
  });
});
