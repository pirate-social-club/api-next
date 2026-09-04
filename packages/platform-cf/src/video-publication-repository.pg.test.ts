import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  attachVideoDecision,
  createOriginalVideoSubmission,
  decideOriginalAudioVideo,
  publishOriginalVideo,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

const actor = "video_publication_actor";
const persona = "video_publication_persona";
const community = "video_publication_community";
const reservationId = "media-reservation-00000000-0000-4000-8000-000000000010";
const submissionId = "media-submission-video-publication";
const operationId = "media-operation-video-publication";
const responseBytes = new TextEncoder().encode('{"track":"video"}');
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const responseSha256 = sha256(responseBytes);
const videoSha256 = "a".repeat(64);
const audioSha256 = "b".repeat(64);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  return `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function fixture<A>(use: (admin: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_video_publication_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = scopedConnection(connectionString, schema);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
      await admin.query(
        `INSERT INTO communities
          (community_id,display_name,status,created_by_user_id,created_at,updated_at)
         VALUES ($1,'Video publication','active',$2,clock_timestamp(),clock_timestamp())`,
        [community, actor],
      );
      await admin.query(
        `INSERT INTO community_memberships
          (community_id,membership_id,user_id,status,joined_at,created_at,updated_at)
         VALUES ($1,'video-publication-membership',$2,'member',
                 clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [community, actor],
      );
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
      return use(admin, connection);
    },
  });
}

function trustedAnalysis(): VideoTrustedAnalysis {
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

suite("video publication PostgreSQL", () => {
  test("commits original-video publication effects atomically and replay creates no duplicate", async () => {
    await fixture(async (admin, connection) => {
      const store = makeControlPlaneVideoPublicationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
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
      expect(finalized?.state.phase).toBe("analysis");
      if (finalized === null) throw new Error("finalized fixture missing");
      const analysis = trustedAnalysis();
      const decision = decideOriginalAudioVideo({
        state: finalized.state,
        analysis,
        canonicalCaptionSha256: null,
        decidedAt: "2026-09-04T00:02:00.000Z",
      });
      const decided = attachVideoDecision(finalized.state, analysis, decision);
      const ready = await store.commitAnalysisDecision({
        submission: finalized.state,
        analysis,
        decision,
        nextState: decided,
      });
      const publication = publishOriginalVideo(ready.state, "post-video-publication");
      const bundle = {
        state: publication.state,
        decision,
        originalSound: publication.originalSound,
        poster: {
          artifactRef: analysis.frames.extracted[0].artifactRef,
          canonicalSha256: analysis.frames.extracted[0].sha256,
        },
        derivedArtifacts: [
          {
            artifactRef: analysis.audio.soundtrack.extractedAudioRef,
            artifactKind: "extracted_audio" as const,
            canonicalSha256: analysis.audio.soundtrack.extractedAudioSha256,
          },
          ...analysis.frames.extracted.map((frame) => ({
            artifactRef: frame.artifactRef,
            artifactKind: frame.role,
            canonicalSha256: frame.sha256,
          })),
        ],
      };
      await store.publish(bundle);
      await store.publish(bundle);

      const counts = await admin.query<{
        posts: number;
        rights: number;
        sounds: number;
        data_operations: number;
        data_outbox: number;
        enrichments: number;
        song_edges: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM posts WHERE post_id='post-video-publication') AS posts,
          (SELECT count(*)::int FROM media_video_rights WHERE submission_id=$1) AS rights,
          (SELECT count(*)::int FROM media_video_original_sounds WHERE submission_id=$1) AS sounds,
          (SELECT count(*)::int FROM data_registration_operations WHERE submission_id=$1
             AND media_kind='video' AND rights_basis='original') AS data_operations,
          (SELECT count(*)::int FROM data_registration_outbox o
             JOIN data_registration_operations d USING (registration_operation_id)
            WHERE d.submission_id=$1) AS data_outbox,
          (SELECT count(*)::int FROM media_video_enrichment_outbox WHERE submission_id=$1) AS enrichments,
          (SELECT count(*)::int FROM media_reference_evidence WHERE submission_id=$1) AS song_edges`,
        [submissionId],
      );
      expect(counts.rows[0]).toEqual({
        posts: 1,
        rights: 1,
        sounds: 1,
        data_operations: 1,
        data_outbox: 1,
        enrichments: 2,
        song_edges: 0,
      });
      const rights = await admin.query(
        `SELECT rights_basis,offered_license,royalty_allocations
           FROM media_video_rights WHERE submission_id=$1`,
        [submissionId],
      );
      expect(rights.rows[0]).toMatchObject({ rights_basis: "original", offered_license: null });
      expect(rights.rows[0]?.royalty_allocations).toEqual([
        { recipient_id: persona, share_bps: 10_000 },
      ]);
    });
  });
});
