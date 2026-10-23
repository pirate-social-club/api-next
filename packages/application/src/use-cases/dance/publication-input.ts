import { Schema } from "effect";
import { PublicPersonaV1 } from "../../../../contracts/src/personas.ts";
import { transferModeratorPublication } from "../../../../domain/src/dance/moderator-review.ts";
import {
  ModeratorReviewFactsSchema,
  ModeratorReviewSchema,
} from "../../../../domain/src/dance/moderator-review-schema.ts";
import {
  attachImmutableVideo,
  createSongReferenceVideoSubmission,
  VIDEO_INGEST_POLICY_V1,
} from "../../../../domain/src/video-submission.ts";
import {
  projectVideoSubmission,
  songVideoPlanId,
  videoImmutableRef,
} from "../../video/publication.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const N = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
/** Private server-owned input. No endpoint accepts this packet from a browser,
 * and it never calls the public multipart finalize operation. */
const DancePublicationInput = Schema.Struct({
  handoffId: Id,
  token: Id,
  generation: Positive,
  nowMs: N,
  review: ModeratorReviewSchema,
  facts: ModeratorReviewFactsSchema,
  reservationId: Id,
  submissionId: Id,
  operationId: Id,
  authorPersona: PublicPersonaV1,
  song: Schema.Struct({
    postId: Id,
    audioRevision: Positive,
    assetId: Id,
    sha256: Hash,
    durationSamples: Positive,
    clipStartSamples: N,
    clipDurationSamples: Positive,
    intervalPolicyRevision: Positive,
  }),
  body: Schema.Struct({
    key: Id,
    version: Id,
    etag: Id,
    sha256: Hash,
    size: Positive,
    durationMs: Positive,
    sourceSha256: Hash,
    bodyStartMs: N,
    bodyEndMs: Positive,
    transformRevision: Schema.Literal("dance-publication-body-v1"),
  }),
  postGatesAccepted: Schema.Boolean,
});

/** Reuse the actual normal video reducers and response projection. The store
 * must recheck every fence and commit these states with the independent input,
 * ordinary analysis outbox and private handoff receipt in ONE transaction. */
export function prepareDancePublicationInput(value: unknown) {
  const w = Schema.decodeUnknownSync(DancePublicationInput, { onExcessProperty: "error" })(value);
  const c = w.review.capture,
    b = w.body;
  if (
    w.handoffId !== c.reviewId ||
    w.authorPersona.persona_id !== c.personaId ||
    w.song.postId !== c.songPostId ||
    w.song.audioRevision !== c.audioRevision ||
    b.key !== `immutable/${w.operationId}/video/1` ||
    b.size > Math.min(16777216, VIDEO_INGEST_POLICY_V1.maxBytes) ||
    b.durationMs !== c.bodyEndMs - c.bodyStartMs ||
    w.song.clipDurationSamples !== b.durationMs * 48
  )
    throw new Error("Dance publication input binding changed");
  const review = transferModeratorPublication(w.review, w.generation, w.nowMs, w.facts, {
    accepted: true,
    sourceDigest: b.sourceSha256,
    outputDigest: b.sha256,
    bodyStartMs: b.bodyStartMs,
    bodyEndMs: b.bodyEndMs,
    postGatesAccepted: w.postGatesAccepted,
  });
  if (review === null) throw new Error("Dance publication release unavailable");
  const initial = createSongReferenceVideoSubmission({
    submissionId: w.submissionId,
    operationId: w.operationId,
    communityId: c.communityId,
    actorAccountId: c.accountId,
    authorPersonaId: c.personaId,
    reservationId: w.reservationId,
    caption: null,
    authorDeclaredRating: "general",
    songPlan: {
      planId: songVideoPlanId(w.submissionId),
      songPostId: w.song.postId,
      songAssetId: w.song.assetId,
      audioRevision: w.song.audioRevision,
      canonicalAudioSha256: w.song.sha256,
      songDurationSamples: w.song.durationSamples,
      clipStartSamples: w.song.clipStartSamples,
      clipDurationSamples: w.song.clipDurationSamples,
      intervalPolicyRevision: w.song.intervalPolicyRevision,
    },
  });
  const sealed = attachImmutableVideo(initial, {
    videoRevision: 1,
    immutableRef: videoImmutableRef(w.operationId),
    canonicalSha256: b.sha256,
    contentType: "video/mp4",
    sizeBytes: b.size,
  });
  const updatedAt = new Date(w.nowMs).toISOString();
  return {
    handoffId: w.handoffId,
    token: w.token,
    generation: w.generation,
    before: w.review,
    review,
    initial,
    sealed,
    initialResponse: projectVideoSubmission({
      state: initial,
      eventSequence: 1,
      authorPersona: w.authorPersona,
      updatedAt,
    }),
    sealedResponse: projectVideoSubmission({
      state: sealed,
      eventSequence: 2,
      authorPersona: w.authorPersona,
      updatedAt,
    }),
  };
}
