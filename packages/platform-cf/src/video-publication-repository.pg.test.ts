import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  createVideoSubmission,
  renewVideoUploadParts,
  reserveVideoUpload,
  VIDEO_MULTIPART_PART_SIZE_BYTES,
  type VideoPublicationServices,
} from "../../application/src/video/publication.ts";
import {
  attachVideoDecision,
  createOriginalVideoSubmission,
  decideOriginalAudioVideo,
  publishOriginalVideo,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { makeControlPlaneContentStore } from "./content-repository.ts";
import { makePostgresDataRegistrationArtifactAuthorityReader } from "./data/registration-artifact-pipeline.ts";
import { makeDataRegistrationStore } from "./data-registration-repository.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "./video-analysis-outbox-repository.ts";
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
  test("renews one expired part after claim without changing other parts or the reservation deadline", async () => {
    await fixture(async (admin, connection) => {
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlaneVideoPublicationStore(layer);
      let now = new Date().toISOString();
      const deadline = new Date(Date.parse(now) + 3_600_000).toISOString();
      let renewals = 0;
      const unused = async (): Promise<never> => {
        throw new Error("unexpected upload effect");
      };
      const services: VideoPublicationServices = {
        store,
        personaServices: { personaStore: makeControlPlanePersonaStore(layer) },
        nowIso: () => now,
        randomUuid: () => crypto.randomUUID(),
        sealer: { inspect: unused, seal: unused },
        multipart: {
          create: async ({ partCount, partSizeBytes }) => ({
            uploadId: "renew-upload",
            partCount,
            partSizeBytes,
            expiresAt: deadline,
            parts: [1, 2].map((partNumber) => ({
              partNumber,
              url: `https://upload.invalid/original/${partNumber}`,
              expiresAt: deadline,
            })),
          }),
          renew: async ({ partNumbers, expiresInSeconds }) => {
            renewals++;
            expect(partNumbers).toEqual([2]);
            expect(expiresInSeconds).toBe(1_800);
            return [
              { partNumber: 2, url: "https://upload.invalid/renewed/2", expiresAt: deadline },
            ];
          },
          completeOrInspect: unused,
          abort: unused,
        },
      };
      const author = { kind: "user" as const, userId: actor };
      const reserved = await reserveVideoUpload(
        {
          communityId: community,
          actor: author,
          body: {
            track: "video",
            slot: "primary_video",
            intent: "original_audio",
            persona_id: persona,
            idempotency_key: "reserve-renew",
            expected_content_type: "video/mp4",
            expected_size_bytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
          },
        },
        services,
      );
      const id = reserved.reservation_id;
      await createVideoSubmission(
        {
          communityId: community,
          actor: author,
          body: {
            version: "video-start-input-v1",
            persona_id: persona,
            video_reservation_id: id,
            idempotency_key: "start-renew",
          },
        },
        services,
      );
      await admin.query(
        "UPDATE media_video_upload_parts SET expires_at=clock_timestamp()-interval '1 second' WHERE reservation_id=$1 AND part_number=2",
        [id],
      );
      now = new Date(Date.parse(deadline) - 1_800_000).toISOString();
      const input = {
        reservationId: id,
        actor: author,
        body: {
          persona_id: persona,
          reservation_id: id,
          part_numbers: [2],
          idempotency_key: "renew-part-two",
        },
      };
      const renewed = await renewVideoUploadParts(input, services);
      expect(renewed.upload.parts.map((part) => part.part_number)).toEqual([2]);
      expect(await renewVideoUploadParts(input, services)).toEqual(renewed);
      expect(renewals).toBe(1);
      await expect(
        renewVideoUploadParts({ ...input, body: { ...input.body, part_numbers: [1] } }, services),
      ).rejects.toMatchObject({ _tag: "IdempotencyConflict" });
      const parts = await admin.query(
        "SELECT part_number,presigned_url FROM media_video_upload_parts WHERE reservation_id=$1 ORDER BY part_number",
        [id],
      );
      expect(parts.rows).toEqual([
        { part_number: 1, presigned_url: "https://upload.invalid/original/1" },
        { part_number: 2, presigned_url: "https://upload.invalid/renewed/2" },
      ]);
      expect(
        await store.getReservationForAccount({ reservationId: id, actorAccountId: actor }),
      ).toMatchObject({ state: "claimed", expiresAt: deadline });
      now = deadline;
      await expect(
        renewVideoUploadParts(
          { ...input, body: { ...input.body, idempotency_key: "renew-expired" } },
          services,
        ),
      ).rejects.toMatchObject({ details: { reason_code: "action_expired" } });
      expect(renewals).toBe(1);
      now = new Date(Date.parse(deadline) - 1_800_000).toISOString();
      const reservation = await store.getReservationForAccount({
        reservationId: id,
        actorAccountId: actor,
      });
      if (reservation?.submissionId == null || reservation.operationId == null)
        throw new Error("missing claimed reservation");
      const submission = await store.getSubmissionByOperation({
        submissionId: reservation.submissionId,
        operationId: reservation.operationId,
      });
      if (submission === null) throw new Error("missing submission");
      await store.beginFinalize({
        submission: submission.state,
        expectedCreationRevision: 1,
        posterTimestampMs: 0,
        manifest: [
          { partNumber: 1, etag: "retained-etag" },
          { partNumber: 2, etag: "renewed-etag" },
        ],
      });
      await expect(
        renewVideoUploadParts(
          { ...input, body: { ...input.body, idempotency_key: "renew-after-finalize" } },
          services,
        ),
      ).rejects.toMatchObject({ details: { reason_code: "action_expired" } });
      await expect(
        store.renewParts({
          reservation,
          endpointTemplate: "/media-upload-reservations/:reservationId/parts/renew",
          idempotencyKey: "stale-renewal",
          requestHash: "f".repeat(64),
          responseBytes,
          responseSha256,
          parts: [{ partNumber: 2, url: "https://upload.invalid/stale", expiresAt: deadline }],
        }),
      ).rejects.toThrow("video reservation action expired");
      expect(renewals).toBe(1);
    });
  });

  test("commits original-video publication effects atomically and replay creates no duplicate", async () => {
    await fixture(async (admin, connection) => {
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
      expect(finalized?.state.phase).toBe("analysis");
      if (finalized === null) throw new Error("finalized fixture missing");
      const analysisOutbox = makeControlPlaneVideoAnalysisOutboxRepository(layer, {
        leaseSeconds: 60,
        retryBaseMs: 1,
        now: () => Date.parse("2026-09-04T00:00:00.000Z"),
      });
      const transformBinding = {
        operationId,
        videoRevision: 1,
        analysisRevision: 1,
        canonicalVideoSha256: videoSha256,
        requestId: `${operationId}:probe:v1:a1`,
      } as const;
      const initialTransformAttempt = {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 1_801_000 },
      } as const;
      expect(
        await analysisOutbox.loadOrCreate({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          initialAttempt: initialTransformAttempt,
        }),
      ).toEqual(initialTransformAttempt);
      const allocatedTransformAttempt = {
        ...initialTransformAttempt,
        providerJobId: "qencode-task-probe",
        providerJobPhase: "allocated" as const,
      };
      expect(
        await analysisOutbox.advance({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          attempt: allocatedTransformAttempt,
        }),
      ).toEqual(allocatedTransformAttempt);
      expect(
        await analysisOutbox.advance({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          attempt: allocatedTransformAttempt,
        }),
      ).toEqual(allocatedTransformAttempt);
      const startedTransformAttempt = {
        ...allocatedTransformAttempt,
        providerJobPhase: "started" as const,
      };
      expect(
        await analysisOutbox.advance({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          attempt: startedTransformAttempt,
        }),
      ).toEqual(startedTransformAttempt);
      await expect(
        analysisOutbox.advance({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          attempt: { ...startedTransformAttempt, providerJobId: "different-qencode-task" },
        }),
      ).rejects.toMatchObject({
        _tag: "VideoAnalysisOutboxRepositoryError",
        operation: "advance-transform-attempt",
        reason: "invalid-row",
      });
      expect(
        await analysisOutbox.loadOrCreate({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          initialAttempt: initialTransformAttempt,
        }),
      ).toEqual(startedTransformAttempt);
      expect((await analysisOutbox.listEligible(10)).map((row) => row.effectIdentity)).toEqual([
        `video-analysis:${operationId}:v1:c1`,
      ]);
      const firstClaim = await analysisOutbox.claim(
        `video-analysis:${operationId}:v1:c1`,
        "video-analysis-worker-1",
      );
      if (firstClaim === null) throw new Error("video analysis claim missing");
      expect(firstClaim).toMatchObject({ state: "running", deliveryAttempts: 1, claimFence: 1 });
      expect(
        await analysisOutbox.claim(firstClaim.effectIdentity, "video-analysis-worker-2"),
      ).toBeNull();
      expect(await analysisOutbox.defer(firstClaim, 1)).toBe(true);
      await admin.query(
        `UPDATE media_video_analysis_outbox
            SET next_eligible_at=clock_timestamp()-interval '1 second'
          WHERE effect_identity=$1`,
        [firstClaim.effectIdentity],
      );
      const polledClaim = await analysisOutbox.claim(
        firstClaim.effectIdentity,
        "video-analysis-worker-2",
      );
      if (polledClaim === null) throw new Error("deferred video analysis was not reclaimed");
      expect(polledClaim).toMatchObject({
        state: "running",
        deliveryAttempts: 1,
        claimFence: 2,
        claimOwner: "video-analysis-worker-2",
      });
      await admin.query(
        `UPDATE media_video_analysis_outbox
            SET lease_expires_at=clock_timestamp()-interval '1 second'
          WHERE effect_identity=$1`,
        [firstClaim.effectIdentity],
      );
      expect((await analysisOutbox.listEligible(10)).map((row) => row.effectIdentity)).toEqual([
        firstClaim.effectIdentity,
      ]);
      const recoveredClaim = await analysisOutbox.claim(
        firstClaim.effectIdentity,
        "video-analysis-worker-2",
      );
      if (recoveredClaim === null)
        throw new Error("expired video analysis lease was not recovered");
      expect(recoveredClaim).toMatchObject({
        state: "running",
        deliveryAttempts: 2,
        claimFence: 3,
        claimOwner: "video-analysis-worker-2",
      });
      expect(await analysisOutbox.complete(firstClaim)).toBe(false);
      expect(await analysisOutbox.fail(recoveredClaim, "provider_timeout")).toBe(true);
      await admin.query(
        `UPDATE media_video_analysis_outbox
            SET next_eligible_at=clock_timestamp()-interval '1 second'
          WHERE effect_identity=$1`,
        [firstClaim.effectIdentity],
      );
      const finalClaim = await analysisOutbox.claim(
        firstClaim.effectIdentity,
        "video-analysis-worker-3",
      );
      if (finalClaim === null) throw new Error("failed video analysis was not replayed");
      expect(finalClaim.deliveryAttempts).toBe(3);
      expect(await analysisOutbox.fail(finalClaim, "provider_unavailable")).toBe(true);
      expect(await analysisOutbox.get(firstClaim.effectIdentity)).toMatchObject({
        state: "exhausted",
        deliveryAttempts: 3,
      });
      expect(await analysisOutbox.listEligible(10)).toEqual([]);
      const baseAnalysis = trustedAnalysis();
      const analysis: VideoTrustedAnalysis = {
        ...baseAnalysis,
        mediaSafety: "review_required",
        audio: {
          intent: "original_audio",
          soundtrack: {
            extractedAudioRef: baseAnalysis.audio.soundtrack.extractedAudioRef,
            extractedAudioSha256: baseAnalysis.audio.soundtrack.extractedAudioSha256,
            verification: null,
            exhaustion: "acr_exhausted",
            evidenceRef: "acr:exhausted",
            policyRevision: baseAnalysis.audio.soundtrack.policyRevision,
          },
        },
      };
      const decision = decideOriginalAudioVideo({
        state: finalized.state,
        analysis,
        canonicalCaptionSha256: null,
        decidedAt: "2026-09-04T00:02:00.000Z",
      });
      const decided = attachVideoDecision(finalized.state, analysis, decision);
      let ready = await store.commitAnalysisDecision({
        submission: finalized.state,
        analysis,
        decision,
        nextState: decided,
      });
      expect(ready.state.status).toBe("manual_review");
      await store.moderate({
        submission: ready.state,
        actor: { kind: "user", userId: actor },
        expectedCreationRevision: ready.state.creationRevision,
        action: { kind: "approve", hold: "safety", evidenceRef: null },
        endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
        idempotencyKey: "approve-video-safety",
        requestHash: "8".repeat(64),
        responseBytes,
        responseSha256,
      });
      const safetyApproved = await store.getSubmissionByOperation({ submissionId, operationId });
      if (safetyApproved === null) throw new Error("safety-approved video missing");
      ready = safetyApproved;
      expect(ready.state.status).toBe("manual_review");
      await store.moderate({
        submission: ready.state,
        actor: { kind: "user", userId: actor },
        expectedCreationRevision: ready.state.creationRevision,
        action: {
          kind: "approve",
          hold: "soundtrack",
          evidenceRef: "rights-evidence:fixture",
        },
        endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
        idempotencyKey: "approve-video-soundtrack",
        requestHash: "9".repeat(64),
        responseBytes,
        responseSha256,
      });
      const soundtrackApproved = await store.getSubmissionByOperation({
        submissionId,
        operationId,
      });
      if (soundtrackApproved === null) throw new Error("soundtrack-approved video missing");
      ready = soundtrackApproved;
      expect(ready.state).toMatchObject({ status: "processing", phase: "publish" });
      const publication = publishOriginalVideo(ready.state, "post-video-publication");
      if (ready.state.decision === null) throw new Error("approved video decision missing");
      const bundle = {
        state: publication.state,
        decision: ready.state.decision,
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

      await admin.query(
        `INSERT INTO home_feed_projection
          (community_id,feed_item_id,post_id,rank_score,projected_at)
         VALUES ($1,'feed-video-publication','post-video-publication',1,clock_timestamp())`,
        [community],
      );
      const contentStore = makeControlPlaneContentStore(layer);
      const feedStore = makeControlPlaneFeedStore(layer);
      const projectedPost = await Effect.runPromise(
        Effect.scoped(
          contentStore.getPost({
            communityId: community,
            postId: "post-video-publication",
            viewerUserId: actor,
          }),
        ),
      );
      const projectedFeed = await Effect.runPromise(
        Effect.scoped(feedStore.listHome({ query: {}, viewerUserId: actor })),
      );
      const publicVideo = {
        soundtrack: {
          kind: "original_audio",
          origin_video_post_id: "post-video-publication",
          origin_author_persona_id: persona,
        },
        playback: { status: "pending" },
        thumbnail: { status: "pending" },
        data_registration: "registration_pending",
      };
      expect(projectedPost).toMatchObject({
        post: { post_type: "video", body: null },
        video: publicVideo,
      });
      expect(projectedFeed.items[0]).toMatchObject({
        post: {
          post: { id: "post-video-publication", post_type: "video", body: null },
          video: publicVideo,
        },
      });
      const publicProjection = JSON.stringify({ projectedPost, projectedFeed });
      for (const privateEvidence of [
        videoSha256,
        audioSha256,
        "rights-evidence:fixture",
        analysis.audio.soundtrack.extractedAudioRef,
        analysis.probe.evidenceRef,
      ]) {
        expect(publicProjection).not.toContain(privateEvidence);
      }

      const counts = await admin.query<{
        posts: number;
        rights: number;
        sounds: number;
        data_operations: number;
        data_outbox: number;
        enrichments: number;
        derived_artifacts: number;
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
          (SELECT count(*)::int FROM media_video_derived_artifacts WHERE submission_id=$1
             AND retention_policy_revision=1 AND retained_until_source_disposition) AS derived_artifacts,
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
        derived_artifacts: 4,
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
      const registrationOperationId = "data-registration:1315:post-video-publication:1";
      const operation =
        await makeDataRegistrationStore(layer).getOperation(registrationOperationId);
      if (operation === null) throw new Error("video DATA operation fixture missing");
      expect(operation).toMatchObject({ mediaKind: "video", rightsBasis: "original" });
      const authority =
        await makePostgresDataRegistrationArtifactAuthorityReader(layer).read(operation);
      expect(authority).toMatchObject({
        mediaKind: "video",
        rightsBasis: "original",
        licensePreset: null,
        videoAssetRef: analysis.finalizedVideoRef,
        canonicalVideoSha256: videoSha256,
        posterArtifactRef: analysis.frames.extracted[0].artifactRef,
        posterSha256: analysis.frames.extracted[0].sha256,
        originalSoundId: publication.originalSound.originalSoundId,
      });
    });
  });
});
