import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  createOriginalVideoSubmission,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";
export const actor = "video_publication_actor";
export const persona = "video_publication_persona";
export const community = "video_publication_community";
const reservationId = "media-reservation-00000000-0000-4000-8000-000000000010";
export const submissionId = "media-submission-video-publication";
export const operationId = "media-operation-video-publication";
export const responseBytes = new TextEncoder().encode('{"track":"video"}');
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const responseSha256 = sha256(responseBytes);
export const videoSha256 = "a".repeat(64);
export const audioSha256 = "b".repeat(64);

export async function seedVideoActors(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
  await admin.query(
    `INSERT INTO communities
          (community_id,display_name,status,created_by_user_id,created_at,updated_at)
         VALUES ($1,'Video publication','active',$2,clock_timestamp(),clock_timestamp())`,
    [community, actor],
  );
  await insertActiveCommunityMembershipFixture(admin, {
    communityId: community,
    membershipId: "video-publication-membership",
    userId: actor,
  });
  await createActivePersonaFixture(admin, {
    accountId: actor,
    personaId: persona,
    profile: { displayName: "Video Fixture", preferredLocale: "en" },
  });
  await admin.query(
    `INSERT INTO persona_community_bindings
          (persona_id,account_id,community_id,binding_source)
         VALUES ($1,$2,$3,'persona_creation')`,
    [persona, actor, community],
  );
}

export async function finalizedFixture(connection: string) {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneVideoPublicationStore(layer);
  const reservationResponse = new TextEncoder().encode('{"reservation_id":"fixture"}');
  const reservationResponseSha = sha256(reservationResponse);
  await store.createReservation({
    record: {
      reservationId,
      communityId: community,
      actorAccountId: actor,
      authorPersonaId: persona,
      requestHash: "c".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: 1_024,
      expectedSha256: videoSha256,
      ingestPolicyRevision: 1,
      uploadId: "multipart-upload-fixture",
      partSizeBytes: 10 * 1024 * 1024,
      partCount: 1,
      expiresAt: "2099-09-04T01:00:00.000Z",
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: reservationResponse,
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
    idempotencyKey: "reserve-fixture",
    responseSha256: reservationResponseSha,
    parts: [
      {
        partNumber: 1,
        url: "https://upload.invalid/part-one",
        expiresAt: "2099-09-04T01:00:00.000Z",
      },
    ],
  });
  const initial = createOriginalVideoSubmission({
    submissionId,
    operationId,
    communityId: community,
    actorAccountId: actor,
    authorPersonaId: persona,
    reservationId,
    caption: null,
    authorDeclaredRating: "general",
  });
  await store.createSubmission({
    state: initial,
    idempotencyKey: "create-fixture",
    requestHash: "d".repeat(64),
    startInput: { version: "video-start-input-v1", video_reservation_id: reservationId },
    responseBytes,
    responseSha256,
  });
  await store.beginFinalize({
    submission: initial,
    expectedCreationRevision: 1,
    posterTimestampMs: 1_000,
    manifest: [{ partNumber: 1, etag: "etag-one" }],
  });
  await store.recordMultipartCompleted({
    submission: initial,
    manifest: [{ partNumber: 1, etag: "etag-one" }],
  });
  await store.finalizeSealed({
    submission: initial,
    expectedCreationRevision: 1,
    immutable: {
      immutableRef: `media://immutable/${operationId}/video/1`,
      destinationRef: `r2://immutable/${operationId}/video/1`,
      etag: "immutable-etag",
      objectVersion: "immutable-version",
      sizeBytes: 1_024,
      contentType: "video/mp4",
      canonicalSha256: videoSha256,
    },
    responseBytes,
    responseSha256,
    endpointTemplate: "/media-post-submissions/:submissionId/finalize",
    idempotencyKey: "finalize-fixture",
    requestHash: "e".repeat(64),
  });
  const finalized = await store.getSubmissionByOperation({ submissionId, operationId });
  if (finalized?.state.phase !== "analysis") throw new Error("fixture is not in analysis");
  if (finalized === null) throw new Error("finalized fixture missing");
  return { layer, store, finalized };
}

export function trustedAnalysis(): VideoTrustedAnalysis {
  const frames = ["poster", "first", "midpoint"].map((role, index) => ({
    role: role as "poster" | "first" | "midpoint",
    requestedTimestampMs: index === 0 ? 1_000 : null,
    timestampMs: index === 0 ? 1_000 : index === 1 ? 0 : 5_000,
    sha256: String(index + 1).repeat(64),
    artifactRef: `media://derived/${operationId}/${role}`,
  })) as unknown as VideoTrustedAnalysis["frames"]["extracted"];
  return {
    version: "video-trusted-analysis-v1",
    operationId,
    videoRevision: 1,
    analysisRevision: 1,
    finalizedVideoRef: `media://immutable/${operationId}/video/1`,
    canonicalVideoSha256: videoSha256,
    byteLength: 1_024,
    mediaType: "video/mp4",
    probe: {
      evidenceRef: "probe:fixture",
      ingestPolicyRevision: 1,
      durationMs: 10_000,
      width: 1_080,
      height: 1_920,
      frameRateMillihertz: 30_000,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
    },
    audio: {
      intent: "original_audio",
      soundtrack: {
        extractedAudioRef: `media://derived/${operationId}/audio`,
        extractedAudioSha256: audioSha256,
        verification: {
          status: "no_match",
          evidenceRef: "acr:no-match",
          adapterRevision: "acr-v1",
        },
        policyRevision: "extract-audio-v1",
      },
    },
    frames: {
      posterPolicyRevision: 1,
      evidenceRef: "frames:fixture",
      adapterRevision: "frames-v1",
      extracted: frames,
    },
    safetyRequest: {
      requestId: "safety-request-fixture",
      frameSha256s: frames.map(({ sha256: hash }) => hash),
      captionSha256: null,
      evidenceRef: "safety:fixture",
      minorSafetyEvidenceRef: "minor-safety:fixture",
    },
    mediaSafety: "allow",
    captionSafety: "not_applicable",
    automatedRating: "general",
    safetyPolicyRevision: "safety-v1",
    adapterRevisions: {
      probe: "probe-v1",
      acr: "acr-v1",
      frames: "frames-v1",
      safety: "safety-v1",
    },
  };
}
