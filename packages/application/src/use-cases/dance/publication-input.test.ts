import { describe, expect, test } from "bun:test";
import { transitionModeratorReview } from "../../../../domain/src/dance/moderator-review.ts";
import { moderatedDanceFixture } from "../../../../testing/src/moderated-dance-fixture.ts";
import { prepareDancePublicationInput } from "./publication-input.ts";

function input() {
  const f = moderatedDanceFixture(),
    facts = {
      ...f.facts,
      submissionDay: {
        atMs: 2000,
        day: "1970-01-01",
        timezone: "UTC",
        timezoneVersion: "tz-v1",
      },
    };
  let review = transitionModeratorReview(
    f.state,
    {
      kind: "submit",
      receiptId: "submit",
      showPublicly: true,
      disclosureVersion: f.state.capture.policy.disclosureVersion,
    },
    { kind: "account", accountId: "dancer" },
    f.state.revision,
    2000,
    facts,
  ).state;
  review = transitionModeratorReview(
    review,
    { kind: "screen" },
    { kind: "worker", accountId: "worker" },
    review.revision,
    3000,
    facts,
  ).state;
  review = transitionModeratorReview(
    review,
    { kind: "verdict", version: "dance-owner-verdict-attestation-v1", verdict: "passed" },
    { kind: "account", accountId: "owner" },
    review.revision,
    4000,
    facts,
  ).state;
  expect(review.publication).toBe("pending");
  return {
    handoffId: "review",
    token: "original",
    generation: review.generation,
    nowMs: 4001,
    review,
    facts,
    reservationId: "dance-reservation",
    submissionId: "dance-submission",
    operationId: "dance-operation",
    authorPersona: {
      persona_id: "persona",
      object: "persona",
      display_name: null,
      avatar_ref: null,
      primary_public_handle: null,
    },
    song: {
      postId: "song",
      audioRevision: 1,
      assetId: "song-asset",
      sha256: "a".repeat(64),
      durationSamples: 8640000,
      clipStartSamples: 480000,
      clipDurationSamples: 480000,
      intervalPolicyRevision: 1,
    },
    body: {
      key: "immutable/dance-operation/video/1",
      version: "v1",
      etag: "etag",
      sha256: "9".repeat(64),
      size: 1000,
      durationMs: 10000,
      sourceSha256: review.capture.sourceDigest,
      bodyStartMs: 2000,
      bodyEndMs: 12000,
      transformRevision: "dance-publication-body-v1",
    },
    postGatesAccepted: true,
  };
}
describe("private approved Dance input into ordinary Post reducers", () => {
  test("only the body becomes an ordinary analysis input; the verdict and qualification are unchanged", () => {
    const w = input(),
      p = prepareDancePublicationInput(w);
    expect(p.review).toEqual({
      ...w.review,
      publication: "transferred",
      publicationRevision: w.review.publicationRevision + 1,
    });
    expect(p.initial.phase).toBe("awaiting_upload");
    expect(p.sealed.phase).toBe("analysis");
    expect(p.sealed.status).toBe("processing");
    expect(p.sealed.postId).toBeNull();
    expect(p.sealed.video?.canonicalSha256).toBe(w.body.sha256);
    expect(p.sealed.video?.immutableRef).toBe("media://immutable/dance-operation/video/1");
    expect(p.sealed.songPlan?.clipStartSamples).toBe(480000);
    expect(JSON.stringify(p.sealedResponse)).not.toContain(w.review.capture.uploadId);
    expect(JSON.stringify(p.sealedResponse)).not.toContain("verdict");
  });
  test("expired, revoked, mismatched or unbound inputs cannot become Posts", () => {
    const w = input();
    for (const changed of [
      { nowMs: w.review.transferDeadlineMs },
      { generation: w.generation + 1 },
      { postGatesAccepted: false },
      { review: { ...w.review, showPublicly: false } },
      { review: { ...w.review, verdict: "not_passed" } },
      { review: { ...w.review, publication: "transferred" } },
      { facts: { ...w.facts, accountActive: false } },
      { facts: { ...w.facts, accountFenceRevision: 2 } },
      { body: { ...w.body, sourceSha256: "8".repeat(64) } },
      { body: { ...w.body, bodyStartMs: 0 } },
      { body: { ...w.body, durationMs: 12000 } },
      { body: { ...w.body, key: "private/original" } },
      { song: { ...w.song, audioRevision: 2 } },
      { song: { ...w.song, clipDurationSamples: 576000 } },
      { authorPersona: { ...w.authorPersona, persona_id: "foreign" } },
    ])
      expect(() => prepareDancePublicationInput({ ...w, ...changed })).toThrow();
  });
});
