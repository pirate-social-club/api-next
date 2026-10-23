import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptTrustedVideoAnalysis,
  attachSongVideoMasterAndPublish,
} from "@pirate/application/video/publication";
import { Effect } from "effect";
import type { Client } from "pg";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { videoPublicationPostId } from "../../application/src/video/publication-identity.ts";
import type { seedModeratedDanceIntake } from "./moderated-dance-intake.pg-fixture.ts";
import { moderatedDanceReplayDigests } from "./moderated-dance-normalization.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import {
  acceptMaster,
  startRenderAttempt,
  verifyAndSealMaster,
} from "./song-video-render-repository.ts";
import {
  actor,
  community,
  operationId as originalOperationId,
  submissionId as originalSubmissionId,
  persona,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songReferenceFinalizedFixture,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";

/** Song history is explicit bootstrap; the ordinary video, rendered master,
 * acceptance and publication use real stores with guards enabled. Codec,
 * storage and soundtrack observations are synthetic ports, never phone proof. */
export async function publishedModeratedDanceVideo(
  admin: Client,
  connection: string,
  songCommunity: string,
  durationMs = 10000,
  successorSuffix = "",
) {
  const submissionId = originalSubmissionId + successorSuffix,
    operationId = originalOperationId + successorSuffix;
  if (successorSuffix === "") {
    await seedVideoActors(admin);
    await seedSongOwner(admin);
  }
  const songPersona = songCommunity === community ? persona : "dance-reference-song-persona";
  if (songCommunity !== community && successorSuffix === "") {
    await createActivePersonaFixture(admin, { accountId: actor, personaId: songPersona });
    await admin.query(
      "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,$3,'activity_participation')",
      [songPersona, actor, songCommunity],
    );
  }
  const song = {
    songPostId: `cross-community-song${successorSuffix}`,
    communityId: songCommunity,
    audioAssetRef: `media://song/cross-community-audio${successorSuffix}`,
    canonicalAudioSha256: "e".repeat(64),
    durationSamples: 60 * 48000,
    title: "Cross-community reference",
    contentRating: "general" as const,
    derivativeVideo: "allowed" as const,
    licensePreset: "commercial-remix" as const,
    commercialRemixShareBps: 1000,
  };
  await seedPublishedSongFixture(admin, song);
  const durationSamples = durationMs * 48;
  const planId = `song-video-plan:${submissionId}`;
  const { store, finalized } = await songReferenceFinalizedFixture(connection, {
    identity: {
      reservationId:
        successorSuffix === ""
          ? "media-reservation-00000000-0000-4000-8000-000000000099"
          : `media-reservation-${crypto.randomUUID()}`,
      submissionId,
      operationId,
    },
    planId,
    song,
    clipStartSamples: 0,
    clipDurationSamples: durationSamples,
    source: { sha256: videoSha256, sizeBytes: 1024 },
  });
  const base = trustedAnalysis();
  const successorFrame = (index: 0 | 1 | 2) => ({
    ...base.frames.extracted[index],
    artifactRef: base.frames.extracted[index].artifactRef.replace(originalOperationId, operationId),
  });
  const analysis = {
    ...base,
    operationId,
    finalizedVideoRef: finalized.state.video?.immutableRef ?? "missing-capture",
    frames: {
      ...base.frames,
      extracted: [successorFrame(0), successorFrame(1), successorFrame(2)] as const,
    },
    safetyRequest: {
      ...base.safetyRequest,
      requestId: base.safetyRequest.requestId + successorSuffix,
    },
    probe: { ...base.probe, durationMs },
    audio: { intent: "song_reference" as const },
  };
  const services = { store, nowIso: () => new Date().toISOString() };
  expect(await acceptTrustedVideoAnalysis({ submissionId, analysis }, services)).toMatchObject({
    status: "processing",
  });
  const attempt = { planId, attemptId: `dance-reference-render${successorSuffix}`, generation: 1 };
  const outputKey = `media://immutable/song-video/dance-reference-render${successorSuffix}/master`;
  const bytes = new TextEncoder().encode(`distinct-rendered-Dance-reference${successorSuffix}`);
  const masterSha256 = createHash("sha256").update(bytes).digest("hex");
  const soundtrackSha256 = "d".repeat(64);
  const masterRevisionId = `dance-reference-master${successorSuffix}`;
  await startRenderAttempt(admin, attempt, {
    outputObjectKey: outputKey,
    rendererIdentity: "fixture-renderer",
    rendererPolicyRevision: 1,
  });
  expect(
    await verifyAndSealMaster(
      admin,
      {
        store: {
          read: async (key) =>
            key === outputKey ? { bytes, objectVersion: "fixture-v1", etag: "fixture-etag" } : null,
          readVersion: async (key, version) =>
            key === outputKey && version === "fixture-v1" ? bytes : null,
        },
        prober: {
          probe: async () => ({
            videoDurationSamples: durationSamples,
            audioDurationSamples: durationSamples,
            audioSampleRateHz: 48000,
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
        decisionClipDurationSamples: durationSamples,
      },
    ),
  ).toEqual({ sealed: true, masterRevisionId });
  expect(await acceptMaster(admin, { ...attempt, masterRevisionId })).toMatchObject({
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
  const postId = await videoPublicationPostId(finalized.state);
  expect(
    await attachSongVideoMasterAndPublish({ submissionId, operationId, master }, services),
  ).toMatchObject({ status: "published" });
  // Explicit admitted canonical PCM history, not a live object or codec claim.
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query(
      `INSERT INTO media_song_video_pcm_references(song_post_id,audio_revision,canonical_audio_sha256,duration_samples,pcm_object_key,pcm_object_version,pcm_object_etag,pcm_sha256,pcm_byte_length,decoder_recipe)
      VALUES($1,1,$2,$3,$5,'pcm-v1','pcm-etag',repeat('f',64),$4,'canonical-pcm-s16le-48000-stereo-v1')`,
      [
        song.songPostId,
        song.canonicalAudioSha256,
        song.durationSamples,
        song.durationSamples * 4,
        `song-video-pcm/fixture/song${successorSuffix}.pcm`,
      ],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  return {
    actor,
    persona: songPersona,
    community,
    postId,
    masterRevisionId,
    masterSha256,
    planId,
    song,
    durationMs,
  };
}

type Intake = Awaited<ReturnType<typeof seedModeratedDanceIntake>>;
type Video = Awaited<ReturnType<typeof publishedModeratedDanceVideo>>;
export async function moderatedReferenceCommand(video: Video, idempotencyKey = "new-reference") {
  const body = {
    version: "dance-moderated-reference-create-v1" as const,
    idempotency_key: idempotencyKey,
    community_id: video.song.communityId,
    song_post_id: video.song.songPostId,
    persona_id: video.persona,
    reference_post_id: video.postId,
  };
  const hash = await Effect.runPromise(
    canonicalBodyHash(["moderated-dance-reference-command-v1", video.actor, body]),
  );
  return { body, hash };
}

/** Real reference command/worker transitions. Canonical WAV and normalized
 * public-frame observations are explicit synthetic port results. */
export async function preparePublishedModeratedReference(admin: Client, f: Intake, video: Video) {
  const command = await moderatedReferenceCommand(video);
  const choreography = "published-choreography";
  const create = async () =>
    (
      await admin.query(
        "SELECT create_moderated_dance_reference_v1($1,$2::jsonb,$3,$4,'pending-segment') packet",
        [video.actor, JSON.stringify(command.body), command.hash, choreography],
      )
    ).rows[0]?.packet;
  const receipt = await create();
  expect(receipt).toMatchObject({ choreography_id: choreography, status: "pending" });
  const work = (
    await admin.query(
      "SELECT claim_moderated_dance_reference_media_v1('observer',$1,$2::jsonb) packet",
      [
        f.facts.profile.mediaRuntimeRevision,
        JSON.stringify(f.facts.profile.replayCompatibleEpochs),
      ],
    )
  ).rows[0]?.packet;
  expect(work).toMatchObject({
    choreographyId: choreography,
    communityId: video.song.communityId,
    referencePostId: video.postId,
  });
  const segmentTermsHash = "9".repeat(64);
  const segment = {
    segmentId: `seg-${segmentTermsHash}`,
    segmentTermsHash,
    key: `moderated-dance/segments/${segmentTermsHash}/canonical.wav`,
    sha256: "e".repeat(64),
    version: "v1",
    etag: "etag",
    size: 100,
  };
  await admin.query(
    "SELECT persist_moderated_dance_reference_segment_v1($1,'observer',$2::jsonb)",
    [choreography, JSON.stringify(segment)],
  );
  expect(
    (
      await admin.query(
        "SELECT claim_moderated_dance_reference_normalization_v1($1,'observer') claimed",
        [choreography],
      )
    ).rows[0]?.claimed,
  ).toBe(true);
  await admin.query(
    "SELECT attach_moderated_dance_reference_provider_v1($1,'observer','fixture-provider-job',$2)",
    [choreography, work.providerTag],
  );
  const frames = Array.from(
    { length: (video.durationMs * f.facts.profile.normalizationFps) / 1000 },
    () => "f".repeat(64),
  );
  const computed = await moderatedDanceReplayDigests({
    scope: f.facts.profile.replayScope,
    sourceSha256: video.masterSha256,
    frames,
    keys: f.replayKeys,
  });
  const referenceTermsHash = await Effect.runPromise(
    canonicalBodyHash([
      "moderated-canonical-reference-v1",
      choreography,
      1,
      video.masterRevisionId,
      video.postId,
      video.masterSha256,
      segmentTermsHash,
      f.publication.policy.normalizationHash,
    ]),
  );
  const publication = {
    text: "SELECT publish_moderated_dance_reference_v1($1,'observer',$2::jsonb,$3::jsonb)",
    values: [
      choreography,
      JSON.stringify({ referenceTermsHash, segmentTermsHash, publicFrames: frames }),
      JSON.stringify(computed.claims),
    ],
  };
  const publish = () => admin.query(publication.text, publication.values);
  return {
    choreography,
    receipt,
    create,
    work,
    publication,
    publish,
    frames,
    computed,
    referenceTermsHash,
  };
}
