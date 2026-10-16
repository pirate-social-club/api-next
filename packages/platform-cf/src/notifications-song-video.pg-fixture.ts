/** Real persisted producer/acceptance paths; output/probe/PCM are deterministic
 * ports, not a codec/provider acceptance claim. This source is UNRUN by writer. */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptTrustedVideoAnalysis,
  attachSongVideoMasterAndPublish,
} from "@pirate/application/video/publication";
import { Client } from "pg";
import { videoPublicationPostId } from "../../application/src/video/publication-identity.ts";
import type { VideoTrustedAnalysis } from "../../domain/src/video-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import type { withInbox } from "./notifications.pg-fixture.ts";
import { seedNotificationsVideoActors } from "./notifications-video-proof.pg-fixture.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  acceptMaster,
  startRenderAttempt,
  verifyAndSealMaster,
} from "./song-video-render-repository.ts";
import {
  actor,
  community,
  operationId,
  responseBytes,
  responseSha256,
  seedPublishedSongFixture,
  seedSongOwner,
  songReferenceFinalizedFixture,
  submissionId,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

type Fixture = Parameters<Parameters<typeof withInbox>[0]>[0];
export async function prepareNotificationSongVideo(f: Fixture, approved: boolean) {
  await seedNotificationsVideoActors(f.admin);
  await seedSongOwner(f.admin);
  await createActivePersonaFixture(f.admin, {
    accountId: "inbox-author",
    personaId: "inbox-video-commenter",
  });
  await f.admin.query(
    "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES('inbox-video-commenter','inbox-author',$1,'persona_creation')",
    [community],
  );
  await insertActiveCommunityMembershipFixture(f.admin, {
    communityId: community,
    userId: "inbox-author",
    membershipId: "inbox-video-commenter-member",
  });
  const song = {
    songPostId: "notification-reference-song",
    communityId: community,
    audioAssetRef: "media://song/notification-reference-audio",
    canonicalAudioSha256: "e".repeat(64),
    durationSamples: 30 * 48_000,
    title: "Reference fixture",
    contentRating: "general" as const,
    derivativeVideo: "allowed" as const,
    licensePreset: "commercial-remix" as const,
    commercialRemixShareBps: 1_000,
  };
  // Existing historical-song fixture only. Video reservation, analysis,
  // moderation, render seal/acceptance, publication and notifications below
  // all run their real stores with guards enabled.
  await seedPublishedSongFixture(f.admin, song);
  const planId = `song-video-plan:${submissionId}`;
  const { store, finalized } = await songReferenceFinalizedFixture(f.url, {
    identity: {
      reservationId: "media-reservation-00000000-0000-4000-8000-000000000099",
      submissionId,
      operationId,
    },
    planId,
    song,
    clipStartSamples: 0,
    clipDurationSamples: 10 * 48_000,
    source: { sha256: videoSha256, sizeBytes: 1_024 },
  });
  const analysis: VideoTrustedAnalysis = {
    ...trustedAnalysis(),
    audio: { intent: "song_reference" },
    ...(approved ? { mediaSafety: "review_required" as const } : {}),
  };
  const services = { store, nowIso: () => new Date().toISOString() };
  expect(await acceptTrustedVideoAnalysis({ submissionId, analysis }, services)).toMatchObject({
    status: approved ? "manual_review" : "processing",
  });
  if (approved) {
    const held = await store.getSubmissionByOperation({ submissionId, operationId });
    if (!held) throw new Error("Held song video required");
    await store.moderate({
      submission: held.state,
      actor: { kind: "user", userId: actor },
      expectedCreationRevision: held.state.creationRevision,
      action: { kind: "approve", hold: "safety", evidenceRef: null },
      endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
      idempotencyKey: "notification-song-owner-approval",
      requestHash: "8".repeat(64),
      responseBytes,
      responseSha256,
    });
  }
  const attempt = { planId, attemptId: "notification-render-attempt", generation: 1 };
  const outputKey = "media://immutable/song-video/notification-render-attempt/master";
  const bytes = new TextEncoder().encode("distinct-rendered-notification-master");
  const masterSha256 = createHash("sha256").update(bytes).digest("hex");
  expect(masterSha256).not.toBe(videoSha256);
  const soundtrackSha256 = "d".repeat(64);
  const masterRevisionId = "notification-render-master";
  await startRenderAttempt(f.admin, attempt, {
    outputObjectKey: outputKey,
    rendererIdentity: "fixture-renderer",
    rendererPolicyRevision: 1,
  });
  expect(
    await verifyAndSealMaster(
      f.admin,
      {
        store: {
          read: async (key) =>
            key === outputKey ? { bytes, objectVersion: "fixture-v1", etag: "fixture-etag" } : null,
          readVersion: async (key, version) =>
            key === outputKey && version === "fixture-v1" ? bytes : null,
        },
        prober: {
          probe: async () => ({
            videoDurationSamples: 10 * 48_000,
            audioDurationSamples: 10 * 48_000,
            audioSampleRateHz: 48_000,
            audioChannels: 2,
            hasVideoTrack: true,
          }),
        },
        soundtrack: {
          canonicalIntervalDigest: async () => soundtrackSha256,
          decodedSoundtrackDigest: async () => soundtrackSha256,
        },
      },
      {
        masterRevisionId,
        attempt,
        sourceImmutableRef: finalized.state.video?.immutableRef ?? "missing-capture",
        claimedSourceSha256: videoSha256,
        decisionClipStartSamples: 0,
        decisionClipDurationSamples: 10 * 48_000,
      },
    ),
  ).toEqual({ sealed: true, masterRevisionId });
  expect(await acceptMaster(f.admin, { ...attempt, masterRevisionId })).toMatchObject({
    accepted: true,
  });
  const master = {
    masterRevisionId,
    attemptId: attempt.attemptId,
    masterRef: outputKey,
    masterSha256,
    masterByteLength: bytes.byteLength,
    soundtrackSha256,
  };
  const input = { submissionId, operationId, master };
  const postId = await videoPublicationPostId(finalized.state);
  const publish = () => attachSongVideoMasterAndPublish(input, services);
  const publishWithLostAck = async () => {
    let lost = false;
    const runtime = makeDirectPostgresControlPlaneLayer(f.url, {
      clientFactory: (url, config) => {
        const client = new Client({ ...config, connectionString: url });
        let publication = false;
        return {
          connect: () => client.connect(),
          end: () => client.end(),
          query: async (statement) => {
            if (statement.text.includes("INSERT INTO posts")) publication = true;
            const result = await client.query({
              ...statement,
              values: [...(statement.values ?? [])],
            });
            if (statement.text === "COMMIT" && publication && !lost) {
              lost = true; // actual PostgreSQL COMMIT succeeded; response is lost
              throw new Error("fixture lost publication COMMIT acknowledgement");
            }
            return result;
          },
        };
      },
    });
    await expect(
      attachSongVideoMasterAndPublish(input, {
        ...services,
        store: makeControlPlaneVideoPublicationStore(runtime),
      }),
    ).rejects.toThrow();
    expect(lost).toBe(true);
    const persisted = await store.getSubmissionByOperation({ submissionId, operationId });
    expect(persisted?.state).toMatchObject({ status: "published", postId });
    const effects = async () =>
      (
        await f.admin.query(
          `SELECT (SELECT jsonb_agg(to_jsonb(o) ORDER BY enrichment_kind) FROM media_video_enrichment_outbox o WHERE operation_id=$1) AS enrichments,
          (SELECT jsonb_agg(to_jsonb(o) ORDER BY outbox_id) FROM data_registration_outbox o WHERE registration_operation_id IN
            (SELECT registration_operation_id FROM data_registration_operations WHERE media_operation_id=$1)) AS registrations,
          (SELECT encode(response_snapshot_bytes,'hex') FROM media_post_submissions WHERE submission_id=$2) AS receipt`,
          [operationId, submissionId],
        )
      ).rows;
    const before = await effects();
    expect(await publish()).toMatchObject({ status: "published" });
    expect(await effects()).toEqual(before);
  };
  return { store, postId, publish, publishWithLostAck, songPostId: song.songPostId };
}
