import { createHash } from "node:crypto";
import { Client } from "pg";
import {
  createOriginalVideoSubmission,
  createSongReferenceVideoSubmission,
  type OriginalAudioTrustedAnalysis,
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

export async function finalizedFixture(
  connection: string,
  caption: string | null = null,
  identity = { reservationId, submissionId, operationId },
) {
  const { reservationId, submissionId, operationId } = identity;
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneVideoPublicationStore(layer);
  const reservationResponse = new TextEncoder().encode('{"reservation_id":"fixture"}');
  const reservationResponseSha = sha256(reservationResponse);
  await store.createReservation({
    record: {
      reservationId,
      communityId: community,
      intent: "original_audio",
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
    idempotencyKey: `reserve-fixture-${reservationId}`,
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
    caption,
    authorDeclaredRating: "general",
  });
  await store.createSubmission({
    state: initial,
    idempotencyKey: `create-fixture-${submissionId}`,
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
    idempotencyKey: `finalize-fixture-${submissionId}`,
    requestHash: "e".repeat(64),
  });
  const finalized = await store.getSubmissionByOperation({ submissionId, operationId });
  if (finalized?.state.phase !== "analysis") throw new Error("fixture is not in analysis");
  if (finalized === null) throw new Error("finalized fixture missing");
  return { layer, store, finalized };
}

export function trustedAnalysis(): OriginalAudioTrustedAnalysis {
  const frames = ["poster", "first", "midpoint"].map((role, index) => ({
    role: role as "poster" | "first" | "midpoint",
    requestedTimestampMs: index === 0 ? 1_000 : null,
    timestampMs: index === 0 ? 1_000 : index === 1 ? 0 : 5_000,
    sha256: String(index + 1).repeat(64),
    artifactRef: `media://derived/${operationId}/${role}`,
  })) as unknown as OriginalAudioTrustedAnalysis["frames"]["extracted"];
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

/** The account that owns the referenced song, distinct from the video's author. */
export const songOwner = "video_song_owner";
export const songOwnerPersona = "video_song_owner_persona";

export type PublishedSongFixture = Readonly<{
  songPostId: string;
  communityId: string;
  audioAssetRef: string;
  canonicalAudioSha256: string;
  /** Null leaves the song unmeasured; a count records a ready canonical timing. */
  durationSamples: number | null;
  title: string;
  contentRating: "general" | "adult_18";
  derivativeVideo: "allowed" | "owner_only" | "blocked";
  licensePreset: "non-commercial" | "commercial-use" | "commercial-remix";
  commercialRemixShareBps: number;
}>;

export async function seedSongOwner(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [songOwner]);
  await createActivePersonaFixture(admin, {
    accountId: songOwner,
    personaId: songOwnerPersona,
    profile: { displayName: "Song Owner", preferredLocale: "en" },
  });
}

/**
 * A published song, as the song pipeline leaves one: its submission, Post,
 * projection, license terms and owner policy head. Seeded past the song
 * pipeline's own triggers, the way the Karaoke suite seeds one; everything a
 * video suite asserts afterwards runs with every trigger live.
 */
export async function seedPublishedSongFixture(
  admin: Client,
  song: PublishedSongFixture,
): Promise<void> {
  const submissionId = `media-submission-${song.songPostId}`;
  const operationId = `media-operation-${song.songPostId}`;
  const snapshot = new TextEncoder().encode('{"track":"song"}');
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO posts
         (community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,
          title,body,created_at,updated_at,idempotency_key,author_declared_rating,content_rating)
       VALUES ($1,$2,$3,$4,'song','published','public',$5,NULL,
               clock_timestamp(),clock_timestamp(),$6,$7,$7)`,
      [
        song.communityId,
        song.songPostId,
        songOwner,
        songOwnerPersona,
        song.title,
        `song-fixture:${song.songPostId}`,
        song.contentRating,
      ],
    );
    await admin.query(
      `INSERT INTO media_post_submissions
         (submission_id,community_id,actor_user_id,author_persona_id,operation_id,
          idempotency_key,request_hash,title,song_type,start_input,audio_reservation_id,
          creation_revision,audio_revision,analysis_revision,event_sequence,status,phase,
          response_snapshot_bytes,response_snapshot_sha256,current_immutable_ref,post_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'original','{}'::jsonb,$9,2,1,1,9,'published',NULL,
               $10,$11,$12,$13)`,
      [
        submissionId,
        song.communityId,
        songOwner,
        songOwnerPersona,
        operationId,
        `song-fixture-create:${song.songPostId}`,
        "c".repeat(64),
        song.title,
        `media-reservation-${song.songPostId}`,
        snapshot,
        sha256(snapshot),
        song.audioAssetRef,
        song.songPostId,
      ],
    );
    await admin.query(
      `INSERT INTO media_submission_terms
         (submission_id,community_id,actor_user_id,operation_id,creation_revision,
          license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot,
          author_persona_id)
       VALUES ($1,$2,$3,$4,2,$5,$6,$7::jsonb,'public',$8::jsonb,$9)`,
      [
        submissionId,
        song.communityId,
        songOwner,
        operationId,
        song.licensePreset,
        song.commercialRemixShareBps,
        JSON.stringify([{ recipient_id: songOwnerPersona, share_bps: 10_000 }]),
        JSON.stringify({ licensePreset: song.licensePreset }),
        songOwnerPersona,
      ],
    );
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
         locked_delivery, projected_at, author_persona_id, lyrics_status)
       VALUES ($1,$2,$3,$4,$5,2,1,1,2,$6,$7,$8,'ready','en','not_explicit',
         'ready','registered','not_required',clock_timestamp(),$9,'no_lyrics')`,
      [
        submissionId,
        song.communityId,
        songOwner,
        operationId,
        song.songPostId,
        song.canonicalAudioSha256,
        song.title,
        song.audioAssetRef,
        songOwnerPersona,
      ],
    );
    await admin.query(
      `INSERT INTO song_owner_policy_revisions
         (community_id,post_id,audio_revision,owner_account_id,policy_revision,
          third_party_reward_legs,pool_leg,derivative_video,policy_hash)
       VALUES ($1,$2,1,$3,1,'allowed','allowed',$4,
         song_owner_policy_hash_v1($1,$2,1,$3,1,'allowed','allowed',$4))`,
      [song.communityId, song.songPostId, songOwner, song.derivativeVideo],
    );
    await admin.query(
      `INSERT INTO song_owner_policies
         (community_id,post_id,audio_revision,owner_account_id,current_policy_revision,
          current_policy_hash)
       SELECT community_id,post_id,audio_revision,owner_account_id,policy_revision,policy_hash
         FROM song_owner_policy_revisions WHERE community_id=$1 AND post_id=$2`,
      [song.communityId, song.songPostId],
    );
    if (song.durationSamples !== null) {
      await admin.query(
        `INSERT INTO media_song_canonical_timings
           (song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state,
            duration_samples,prober_identity,prober_policy_revision,measured_at)
         VALUES ($1,1,$2,$3,'ready',$4,'fixture-prober',1,clock_timestamp())`,
        [song.songPostId, song.communityId, song.canonicalAudioSha256, song.durationSamples],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

/**
 * A finalized song-reference submission, produced by the real publication store
 * from a reservation that froze `plan`. The submission's render plan is created
 * with it, under `planId`.
 */
export async function songReferenceFinalizedFixture(
  connection: string,
  input: Readonly<{
    identity: Readonly<{ reservationId: string; submissionId: string; operationId: string }>;
    planId: string;
    song: PublishedSongFixture;
    clipStartSamples: number;
    clipDurationSamples: number;
    source: Readonly<{ sha256: string; sizeBytes: number }>;
    posterTimestampMs?: number;
  }>,
) {
  const { reservationId, submissionId, operationId } = input.identity;
  if (input.song.durationSamples === null) throw new Error("the song must be measured");
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneVideoPublicationStore(layer);
  const reservationResponse = new TextEncoder().encode(`{"reservation_id":"${reservationId}"}`);
  const frozen = {
    songPostId: input.song.songPostId,
    audioRevision: 1,
    canonicalAudioSha256: input.song.canonicalAudioSha256,
    songDurationSamples: input.song.durationSamples,
    songAssetId: input.song.audioAssetRef,
    clipStartSamples: input.clipStartSamples,
    clipDurationSamples: input.clipDurationSamples,
    intervalPolicyRevision: 1,
    ownerPolicyRevision: 1,
    ownerPolicyHash: "0".repeat(64),
    derivativeVideo: "allowed" as const,
    selectedFrom: { kind: "library" as const },
    originVerified: false,
    observedAt: "2026-09-10T00:00:00.000Z",
  };
  const policy = await (async () => {
    const client = new Client({ connectionString: connection });
    await client.connect();
    try {
      const result = await client.query<{ policy_hash: string }>(
        `SELECT policy_hash FROM song_owner_policy_revisions
          WHERE post_id=$1 AND policy_revision=1`,
        [input.song.songPostId],
      );
      return result.rows[0]?.policy_hash ?? "0".repeat(64);
    } finally {
      await client.end();
    }
  })();
  await store.createReservation({
    record: {
      reservationId,
      communityId: community,
      intent: "song_reference",
      actorAccountId: actor,
      authorPersonaId: persona,
      requestHash: "c".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: input.source.sizeBytes,
      expectedSha256: input.source.sha256,
      ingestPolicyRevision: 1,
      uploadId: `multipart-${reservationId}`,
      partSizeBytes: 10 * 1024 * 1024,
      partCount: 1,
      expiresAt: "2099-09-10T01:00:00.000Z",
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: reservationResponse,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    idempotencyKey: `reserve-fixture-${reservationId}`,
    responseSha256: sha256(reservationResponse),
    parts: [
      {
        partNumber: 1,
        url: "https://upload.invalid/part-one",
        expiresAt: "2099-09-10T01:00:00.000Z",
      },
    ],
    songPlan: { ...frozen, ownerPolicyHash: policy },
  });
  const initial = createSongReferenceVideoSubmission({
    submissionId,
    operationId,
    communityId: community,
    actorAccountId: actor,
    authorPersonaId: persona,
    reservationId,
    caption: null,
    authorDeclaredRating: "general",
    songPlan: {
      planId: input.planId,
      songPostId: frozen.songPostId,
      songAssetId: frozen.songAssetId,
      audioRevision: frozen.audioRevision,
      canonicalAudioSha256: frozen.canonicalAudioSha256,
      songDurationSamples: frozen.songDurationSamples,
      clipStartSamples: frozen.clipStartSamples,
      clipDurationSamples: frozen.clipDurationSamples,
    },
  });
  await store.createSubmission({
    state: initial,
    idempotencyKey: `create-fixture-${submissionId}`,
    requestHash: "d".repeat(64),
    startInput: { version: "video-start-input-v1", video_reservation_id: reservationId },
    responseBytes,
    responseSha256,
  });
  const manifest = [{ partNumber: 1, etag: `etag-${submissionId}` }];
  await store.beginFinalize({
    submission: initial,
    expectedCreationRevision: 1,
    posterTimestampMs: input.posterTimestampMs ?? 1_000,
    manifest,
  });
  await store.recordMultipartCompleted({ submission: initial, manifest });
  await store.finalizeSealed({
    submission: initial,
    expectedCreationRevision: 1,
    immutable: {
      immutableRef: `media://immutable/${operationId}/video/1`,
      destinationRef: `r2://immutable/${operationId}/video/1`,
      etag: `immutable-etag-${submissionId}`,
      objectVersion: `immutable-version-${submissionId}`,
      sizeBytes: input.source.sizeBytes,
      contentType: "video/mp4",
      canonicalSha256: input.source.sha256,
    },
    responseBytes,
    responseSha256,
    endpointTemplate: "/media-post-submissions/:submissionId/finalize",
    idempotencyKey: `finalize-fixture-${submissionId}`,
    requestHash: "e".repeat(64),
  });
  const finalized = await store.getSubmissionByOperation({ submissionId, operationId });
  if (finalized?.state.phase !== "analysis") throw new Error("fixture is not in analysis");
  return { layer, store, finalized };
}
