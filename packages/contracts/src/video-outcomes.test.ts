import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ClaimVideoOutcome, VideoOutcomeClaimV1 } from "./video-outcomes.ts";

const decode = Schema.decodeUnknownSync(VideoOutcomeClaimV1, { onExcessProperty: "error" });
test("claim is a session-only unsafe write with no replay input", () => {
  expect(ClaimVideoOutcome.method).toBe("POST");
  expect(ClaimVideoOutcome.auth).toEqual({ policy: { kind: "user" }, browserSessionOnly: true });
  const body = ClaimVideoOutcome.request?.body;
  if (body === undefined) throw new Error("claim request body missing");
  expect(() =>
    Schema.decodeUnknownSync(body, { onExcessProperty: "error" })({ account_id: "other" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(body, { onExcessProperty: "error" })({ idempotency_key: "replay" }),
  ).toThrow();
});

test("display permission and a safe payload must agree", () => {
  const outcome = {
    submission_id: "video-one",
    kind: "processing_failure" as const,
    song: { community_id: "song-community", post_id: "song-one" },
  };
  expect(
    decode({ object: "video_outcome_claim", display_permission: true, outcome }).outcome,
  ).toEqual(outcome);
  expect(() =>
    decode({ object: "video_outcome_claim", display_permission: false, outcome }),
  ).toThrow();
  expect(() =>
    decode({ object: "video_outcome_claim", display_permission: true, outcome: null }),
  ).toThrow();
  expect(() =>
    decode({
      object: "video_outcome_claim",
      display_permission: true,
      outcome: { ...outcome, moderation_signal: "private" },
    }),
  ).toThrow();
});
