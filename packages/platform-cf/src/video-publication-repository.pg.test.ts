import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { VideoStageFact } from "@pirate/application/video/stage-facts";
import { Effect } from "effect";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { getVideoPlaybackAccess } from "../../application/src/video/playback-access.ts";
import {
  acceptTrustedVideoAnalysis,
  createVideoSubmission,
  projectVideoSubmission,
  renewVideoUploadParts,
  reserveVideoUpload,
  VIDEO_MULTIPART_PART_SIZE_BYTES,
  type VideoPublicationServices,
  type VideoPublicationStore,
} from "../../application/src/video/publication.ts";
import { dispatchVideoPublicationWakeups } from "../../application/src/video/publication-wakeup.ts";
import { consumeVideoStreamIngest } from "../../application/src/video/stream-ingest.ts";
import { consumeVideoThumbnail } from "../../application/src/video/thumbnail-enrichment.ts";
import { recoverVideoWorkflowLaunches } from "../../application/src/video/workflow-recovery.ts";
import {
  attachVideoDecision,
  createOriginalVideoSubmission,
  decideOriginalAudioVideo,
  type OriginalAudioTrustedAnalysis,
  publishOriginalVideo,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import { makeControlPlaneContentStore } from "./content-repository.ts";
import { makePostgresDataRegistrationArtifactAuthorityReader } from "./data/registration-artifact-pipeline.ts";
import { makeDataRegistrationStore } from "./data-registration-repository.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSongVideoIntervalStore } from "./song-video-interval-repository.ts";
import { makeVideoPublicationAuthorization } from "./video-access-authorization.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "./video-analysis-outbox-repository.ts";
import { makeVideoPlaybackAuthority } from "./video-playback-authority.ts";
import { makeVideoPosterAuthority } from "./video-poster-authority.ts";
import { streamVideoPoster } from "./video-poster-stream.ts";
import {
  actor,
  audioSha256,
  community,
  finalizedFixture,
  operationId,
  persona,
  responseBytes,
  responseSha256,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songReferenceFinalizedFixture,
  submissionId,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";
import { makeVideoPublicationWakeupStore } from "./video-publication-wakeup-repository.ts";
import { makeVideoSealedSourceVerifier } from "./video-sealed-source-verifier.ts";
import { makeControlPlaneVideoStageFactStore } from "./video-stage-fact-repository.ts";
import { makeVideoStreamIngestStore } from "./video-stream-ingest-repository.ts";
import { makeVideoThumbnailStore } from "./video-thumbnail-repository.ts";
import { makeVideoThumbnailVerifier } from "./video-thumbnail-verifier.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

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
      await seedVideoActors(admin);
      return use(admin, connection);
    },
  });
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A measured, published song and an issued song-reference reservation for
 * it, with application services over the real stores. Every upload and seal
 * effect throws, so any second upload effect fails the test.
 */
async function songStartFixture(admin: Client, connection: string, label: string) {
  await seedSongOwner(admin);
  const song = {
    songPostId: `post-start-replay-${label}`,
    communityId: community,
    audioAssetRef: `media://song/start-replay-${label}`,
    canonicalAudioSha256: "a".repeat(64),
    durationSamples: 30 * 48_000,
    title: "Start replay fixture",
    contentRating: "general" as const,
    derivativeVideo: "allowed" as const,
    licensePreset: "commercial-remix" as const,
    commercialRemixShareBps: 1_000,
  };
  await seedPublishedSongFixture(admin, song);
  const policy = await admin.query<{ policy_hash: string }>(
    "SELECT policy_hash FROM song_owner_policy_revisions WHERE post_id=$1 AND policy_revision=1",
    [song.songPostId],
  );
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneVideoPublicationStore(layer);
  const reservationId = `media-reservation-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const reservationResponse = new TextEncoder().encode(`{"reservation_id":"${reservationId}"}`);
  await store.createReservation({
    record: {
      reservationId,
      communityId: community,
      intent: "song_reference",
      actorAccountId: actor,
      authorPersonaId: persona,
      requestHash: "c".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: 1_024,
      expectedSha256: videoSha256,
      ingestPolicyRevision: 1,
      uploadId: `multipart-${reservationId}`,
      partSizeBytes: 10 * 1024 * 1024,
      partCount: 1,
      expiresAt,
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: reservationResponse,
      updatedAt: new Date().toISOString(),
    },
    idempotencyKey: `reserve-start-replay-${label}`,
    responseSha256: sha256Hex(reservationResponse),
    parts: [{ partNumber: 1, url: "https://upload.invalid/part-one", expiresAt }],
    songPlan: {
      songPostId: song.songPostId,
      audioRevision: 1,
      canonicalAudioSha256: song.canonicalAudioSha256,
      songDurationSamples: song.durationSamples,
      songAssetId: song.audioAssetRef,
      clipStartSamples: 0,
      clipDurationSamples: 10 * 48_000,
      intervalPolicyRevision: 1,
      ownerPolicyRevision: 1,
      ownerPolicyHash: policy.rows[0]?.policy_hash ?? "0".repeat(64),
      derivativeVideo: "allowed",
      selectedFrom: { kind: "library" },
      originVerified: false,
      observedAt: new Date().toISOString(),
    },
  });
  const effect = async (): Promise<never> => {
    throw new Error("a start must not cause an upload or seal effect");
  };
  const services = (overrides: Partial<VideoPublicationStore> = {}): VideoPublicationServices => ({
    store: { ...store, ...overrides },
    personaServices: {
      personaStore: makeControlPlanePersonaStore(layer),
      runEffect: (program, signal) =>
        Effect.runPromise(program, signal === undefined ? undefined : { signal }),
    },
    songInterval: {
      store: makeControlPlaneSongVideoIntervalStore(layer),
      contentStore: makeControlPlaneContentStore(layer),
    },
    nowIso: () => new Date().toISOString(),
    randomUuid: () => crypto.randomUUID(),
    sealer: { inspect: effect, seal: effect },
    multipart: { create: effect, renew: effect, completeOrInspect: effect, abort: effect },
  });
  const body = {
    persona_id: persona,
    version: "video-start-input-v1",
    video_reservation_id: reservationId,
    idempotency_key: `start-replay-${label}`,
  };
  const start = (withServices: VideoPublicationServices, startBody: unknown = body) =>
    createVideoSubmission(
      { communityId: community, actor: { kind: "user", userId: actor }, body: startBody },
      withServices,
    );
  const submissions = async () =>
    (
      await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM media_post_submissions WHERE actor_user_id=$1 AND media_kind='video'",
        [actor],
      )
    ).rows[0]?.n ?? -1;
  const reservationState = async () =>
    (
      await admin.query<{ state: string }>(
        "SELECT state FROM media_upload_reservations WHERE reservation_id=$1",
        [reservationId],
      )
    ).rows[0]?.state;
  return { services, body, start, submissions, reservationState };
}

/** Holds the render-plan table so a start pauses inside its transaction,
 * after its submission row is written and before the reservation is claimed. */
async function pauseStartsInsideTheirTransaction(connection: string) {
  const holder = new Client({ connectionString: connection });
  await holder.connect();
  await holder.query("BEGIN");
  await holder.query("LOCK TABLE media_song_video_render_plans IN SHARE MODE");
  return {
    /** The statements now waiting on the held table, read from a fresh
     * statistics snapshot (a transaction otherwise keeps its first one). */
    waiting: async (): Promise<string[]> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        await holder.query("SELECT pg_stat_clear_snapshot()");
        const blocked = await holder.query<{ q: string }>(
          `SELECT regexp_replace(query,'\\s+',' ','g') AS q FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND pid<>pg_backend_pid()`,
        );
        if (blocked.rows.length > 0) return blocked.rows.map((row) => row.q);
        await Bun.sleep(10);
      }
      throw new Error("the start never reached the paused boundary");
    },
    release: async () => {
      await holder.query("ROLLBACK");
      await holder.end();
    },
  };
}

suite("video publication PostgreSQL", () => {
  test("approved song-reference review wakes render without publishing an unsealed capture", async () => {
    await fixture(async (admin, connection) => {
      await seedSongOwner(admin);
      const song = {
        songPostId: "post-video-review-song",
        communityId: community,
        audioAssetRef: "media://song/video-review-audio",
        canonicalAudioSha256: "f".repeat(64),
        durationSamples: 30 * 48_000,
        title: "Review render fixture",
        contentRating: "general" as const,
        derivativeVideo: "allowed" as const,
        licensePreset: "commercial-remix" as const,
        commercialRemixShareBps: 1_000,
      };
      await seedPublishedSongFixture(admin, song);
      const { store, finalized } = await songReferenceFinalizedFixture(connection, {
        identity: {
          reservationId: "media-reservation-00000000-0000-4000-8000-000000000099",
          submissionId,
          operationId,
        },
        planId: `song-video-plan:${submissionId}`,
        song,
        clipStartSamples: 0,
        clipDurationSamples: 10 * 48_000,
        source: { sha256: videoSha256, sizeBytes: 1_024 },
      });
      const base = trustedAnalysis();
      const analysis: VideoTrustedAnalysis = {
        ...base,
        audio: { intent: "song_reference" },
        mediaSafety: "review_required",
      };
      const services = {
        store,
        nowIso: () => new Date().toISOString(),
        randomUuid: () => crypto.randomUUID(),
      };
      expect(await acceptTrustedVideoAnalysis({ submissionId, analysis }, services)).toMatchObject({
        status: "manual_review",
      });
      const held = await store.getSubmissionByOperation({ submissionId, operationId });
      if (held === null) throw new Error("held song video missing");
      expect(held.state).toMatchObject({ status: "manual_review", phase: null, master: null });
      expect(
        await store.moderate({
          submission: held.state,
          actor: { kind: "user", userId: actor },
          expectedCreationRevision: held.state.creationRevision,
          action: { kind: "approve", hold: "safety", evidenceRef: null },
          endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
          idempotencyKey: "approve-song-review-render",
          requestHash: "8".repeat(64),
          responseBytes,
          responseSha256,
        }),
      ).toEqual({ kind: "none" });
      const approved = await store.getSubmissionByOperation({ submissionId, operationId });
      if (approved === null) throw new Error("approved song video missing");
      expect(approved.state).toMatchObject({
        status: "processing",
        phase: "render",
        master: null,
        decision: { outcome: { kind: "publish" } },
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM media_video_publication_wakeups WHERE action_id=$1",
            [`video-moderation:${actor}:approve-song-review-render`],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(await acceptTrustedVideoAnalysis({ submissionId, analysis }, services)).toMatchObject({
        status: "processing",
        phase: "publish",
      });
      expect(
        (
          await admin.query(
            "SELECT status,phase FROM media_post_submissions WHERE submission_id=$1",
            [submissionId],
          )
        ).rows[0],
      ).toEqual({ status: "processing", phase: "render" });
      const outbox = makeControlPlaneVideoAnalysisOutboxRepository(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const effectIdentity = `video-analysis:${operationId}:v1:c1`;
      const claim = await outbox.claim(effectIdentity, "render-recovery-fixture");
      if (claim === null) throw new Error("render recovery outbox claim missing");
      expect(await outbox.markLaunched(claim, `vaw-${"a".repeat(64)}`)).toBe(true);
      expect(
        await recoverVideoWorkflowLaunches({
          outbox,
          store,
          launcher: {
            inspect: async () => ({ state: "terminal", status: "errored" }),
            instanceId: async () => `vaw-${"a".repeat(64)}`,
          },
        }),
      ).toMatchObject({ inspected: 1, recovered: 1, terminal: 0 });
      expect((await outbox.get(effectIdentity))?.continuation).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM posts WHERE post_type='video'")).rows[0]
          ?.n,
      ).toBe(0);
      expect(finalized.state.master).toBeNull();
    });
  });

  test("persisted JSONB multipart manifest replays by ordered part identity, not object key order", async () => {
    await fixture(async (admin, connection) => {
      const store = makeControlPlaneVideoPublicationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const reservationId = "media-reservation-00000000-0000-4000-8000-000000000020";
      const replaySubmissionId = "media-submission-video-manifest-replay";
      const replayOperationId = "media-operation-video-manifest-replay";
      const expiresAt = "2099-09-04T01:00:00.000Z";
      await store.createReservation({
        record: {
          reservationId,
          communityId: community,
          intent: "original_audio",
          actorAccountId: actor,
          authorPersonaId: persona,
          requestHash: "c".repeat(64),
          expectedContentType: "video/mp4",
          expectedSizeBytes: 6 * 1024 * 1024,
          expectedSha256: videoSha256,
          ingestPolicyRevision: 1,
          uploadId: "multipart-upload-replay-fixture",
          partSizeBytes: 5 * 1024 * 1024,
          partCount: 2,
          expiresAt,
          state: "issued",
          submissionId: null,
          operationId: null,
          manifest: null,
          responseBytes,
          updatedAt: "2026-09-04T00:00:00.000Z",
        },
        idempotencyKey: "reserve-manifest-replay",
        responseSha256,
        parts: [1, 2].map((partNumber) => ({
          partNumber,
          url: `https://upload.invalid/${partNumber}`,
          expiresAt,
        })),
      });
      const initial = createOriginalVideoSubmission({
        submissionId: replaySubmissionId,
        operationId: replayOperationId,
        communityId: community,
        actorAccountId: actor,
        authorPersonaId: persona,
        reservationId,
        caption: null,
        authorDeclaredRating: "general",
      });
      await store.createSubmission({
        state: initial,
        idempotencyKey: "create-manifest-replay",
        requestHash: "d".repeat(64),
        startInput: { version: "video-start-input-v1", video_reservation_id: reservationId },
        responseBytes,
        responseSha256,
      });
      const manifest = [
        { partNumber: 1, etag: "etag-one" },
        { partNumber: 2, etag: "etag-two" },
      ] as const;
      const input = {
        submission: initial,
        expectedCreationRevision: 1,
        posterTimestampMs: 1_000,
        manifest,
      };
      expect((await store.beginFinalize(input)).alreadyCompleted).toBe(false);
      const persisted = await admin.query(
        "SELECT multipart_manifest::text AS manifest FROM media_upload_reservations WHERE reservation_id=$1",
        [reservationId],
      );
      expect(JSON.parse(persisted.rows[0]?.manifest)).toEqual(manifest);
      expect((await store.beginFinalize(input)).alreadyCompleted).toBe(false);
      await expect(
        store.beginFinalize({ ...input, manifest: [...manifest].reverse() }),
      ).rejects.toThrow("video finalize manifest conflict");
      await expect(
        store.beginFinalize({
          ...input,
          manifest: [{ partNumber: 1, etag: "changed" }, manifest[1]],
        }),
      ).rejects.toThrow("video finalize manifest conflict");
      await expect(store.beginFinalize({ ...input, manifest: [manifest[0]] })).rejects.toThrow(
        "video finalize manifest conflict",
      );
      await store.recordMultipartCompleted({ submission: initial, manifest });
      expect((await store.beginFinalize(input)).alreadyCompleted).toBe(true);
      const completed = await store.getSubmissionByOperation({
        submissionId: replaySubmissionId,
        operationId: replayOperationId,
      });
      expect(completed?.state.phase).toBe("finalize");
      if (!completed) throw new Error("completed-source fixture missing");
      const mismatch = {
        submission: completed.state,
        evidenceRef: `video-upload-expectation:${reservationId}`,
        responseBytes,
        responseSha256,
        endpointTemplate: "/media-post-submissions/:submissionId/finalize",
        idempotencyKey: "finalize-manifest-replay",
        requestHash: "e".repeat(64),
      };
      const concurrent = await Promise.all([
        store.abandonExpectationMismatch(mismatch),
        store.abandonExpectationMismatch(mismatch),
      ]);
      expect(concurrent.map((result) => result.kind).sort()).toEqual(["none", "replay"]);
      const terminal = await store.getSubmissionByOperation({
        submissionId: replaySubmissionId,
        operationId: replayOperationId,
      });
      expect(terminal?.state.status).toBe("abandoned");
      expect(terminal?.state.phase).toBeNull();
      expect(terminal?.state.abandonmentReason).toBe("upload_expectation_mismatch");
      if (terminal) {
        expect(projectVideoSubmission(terminal)).toMatchObject({
          status: "abandoned",
          reason_code: "upload_expectation_mismatch",
        });
      }
      const terminalRow = await admin.query(
        "SELECT state,terminal_reason FROM media_upload_reservations WHERE reservation_id=$1",
        [reservationId],
      );
      expect(terminalRow.rows[0]).toEqual({
        state: "rejected",
        terminal_reason: "expectation_mismatch",
      });
      const submissionRow = await admin.query(
        `SELECT abandonment_reason,retention_disposition,response_snapshot_bytes IS NOT NULL AS has_response
         FROM media_post_submissions WHERE submission_id=$1`,
        [replaySubmissionId],
      );
      expect(submissionRow.rows[0]).toEqual({
        abandonment_reason: "upload_expectation_mismatch",
        retention_disposition: "retain_for_reconciliation",
        has_response: true,
      });
      const outbox = await admin.query(
        "SELECT count(*)::int AS count FROM media_video_analysis_outbox WHERE submission_id=$1",
        [replaySubmissionId],
      );
      expect(outbox.rows[0]?.count).toBe(0);
      const replay = await store.replayCommand({
        submission: terminal?.state ?? initial,
        actorAccountId: actor,
        actorPersonaId: persona,
        endpointTemplate: "/media-post-submissions/:submissionId/finalize",
        idempotencyKey: "finalize-manifest-replay",
        requestHash: "e".repeat(64),
      });
      expect(replay.kind).toBe("replay");
      await expect(
        store.abandonExpectationMismatch({ ...mismatch, idempotencyKey: "other-finalize-key" }),
      ).rejects.toThrow("video finalization mismatch fence rejected");
      const afterStale = await store.getSubmissionByOperation({
        submissionId: replaySubmissionId,
        operationId: replayOperationId,
      });
      expect(afterStale?.eventSequence).toBe(terminal?.eventSequence);
    });
  });

  test("invalid multipart manifest persists a terminal, non-publishable upload mismatch", async () => {
    await fixture(async (admin, connection) => {
      const store = makeControlPlaneVideoPublicationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const reservationId = "media-reservation-00000000-0000-4000-8000-000000000021";
      const invalidSubmissionId = "media-submission-video-invalid-manifest";
      const invalidOperationId = "media-operation-video-invalid-manifest";
      const expiresAt = "2099-09-04T01:00:00.000Z";
      await store.createReservation({
        record: {
          reservationId,
          communityId: community,
          intent: "original_audio",
          actorAccountId: actor,
          authorPersonaId: persona,
          requestHash: "c".repeat(64),
          expectedContentType: "video/mp4",
          expectedSizeBytes: 6 * 1024 * 1024,
          expectedSha256: videoSha256,
          ingestPolicyRevision: 1,
          uploadId: "multipart-upload-invalid-manifest",
          partSizeBytes: 5 * 1024 * 1024,
          partCount: 2,
          expiresAt,
          state: "issued",
          submissionId: null,
          operationId: null,
          manifest: null,
          responseBytes,
          updatedAt: "2026-09-04T00:00:00.000Z",
        },
        idempotencyKey: "reserve-invalid-manifest",
        responseSha256,
        parts: [1, 2].map((partNumber) => ({
          partNumber,
          url: `https://upload.invalid/${partNumber}`,
          expiresAt,
        })),
      });
      const initial = createOriginalVideoSubmission({
        submissionId: invalidSubmissionId,
        operationId: invalidOperationId,
        communityId: community,
        actorAccountId: actor,
        authorPersonaId: persona,
        reservationId,
        caption: null,
        authorDeclaredRating: "general",
      });
      await store.createSubmission({
        state: initial,
        idempotencyKey: "create-invalid-manifest",
        requestHash: "d".repeat(64),
        startInput: { version: "video-start-input-v1", video_reservation_id: reservationId },
        responseBytes,
        responseSha256,
      });
      const reservation = await store.getReservationForAuthor({
        reservationId,
        actorAccountId: actor,
        authorPersonaId: persona,
      });
      if (!reservation) throw new Error("invalid-manifest fixture reservation missing");
      await store.abandonInvalidManifest({
        submission: initial,
        reservation,
        evidenceRef: `video-invalid-manifest:${reservationId}`,
      });
      const terminal = await store.getSubmissionByOperation({
        submissionId: invalidSubmissionId,
        operationId: invalidOperationId,
      });
      expect(terminal?.state.status).toBe("abandoned");
      expect(terminal?.state.abandonmentReason).toBe("upload_expectation_mismatch");
      const rows = await admin.query(
        `SELECT s.abandonment_reason,s.retention_disposition,r.state AS reservation_state,
                r.terminal_reason,r.multipart_aborted_at IS NOT NULL AS multipart_aborted
         FROM media_post_submissions s JOIN media_upload_reservations r
           ON r.reservation_id=s.audio_reservation_id WHERE s.submission_id=$1`,
        [invalidSubmissionId],
      );
      expect(rows.rows[0]).toEqual({
        abandonment_reason: "upload_expectation_mismatch",
        retention_disposition: "retain_for_reconciliation",
        reservation_state: "rejected",
        terminal_reason: "expectation_mismatch",
        multipart_aborted: true,
      });
      const outbox = await admin.query(
        "SELECT count(*)::int AS count FROM media_video_analysis_outbox WHERE submission_id=$1",
        [invalidSubmissionId],
      );
      expect(outbox.rows[0]?.count).toBe(0);
    });
  });

  test("unresolved moderation abandonment is fenced, concurrent, and idempotent", async () => {
    await fixture(async (admin, connection) => {
      const { store, finalized } = await finalizedFixture(connection);
      await store.recordProcessingFailure({
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        failureCode: "provider_submission_unconfirmed",
        evidenceRef: "video-safety:request-unconfirmed",
        reconciliationRequired: true,
      });
      const unresolved = await store.getSubmissionByOperation({ submissionId, operationId });
      if (unresolved === null) throw new Error("missing unresolved submission");
      const command = {
        submission: unresolved.state,
        expectedCreationRevision: unresolved.state.creationRevision,
        endpointTemplate: "/media-post-submissions/:submissionId/cancel",
        idempotencyKey: "abandon-unresolved-moderation",
        requestHash: "9".repeat(64),
        responseBytes,
        responseSha256,
      };

      await expect(
        store.cancel({
          ...command,
          expectedCreationRevision: command.expectedCreationRevision + 1,
          idempotencyKey: "stale-abandonment",
        }),
      ).rejects.toThrow("video cancel rejected");

      const concurrent = await Promise.all([store.cancel(command), store.cancel(command)]);
      expect(concurrent.filter((result) => result.kind === "none")).toHaveLength(1);
      expect(concurrent.filter((result) => result.kind === "replay")).toHaveLength(1);
      expect(await store.cancel({ ...command, requestHash: "8".repeat(64) })).toEqual({
        kind: "conflict",
        entityId: submissionId,
      });

      expect(
        (await store.getSubmissionByOperation({ submissionId, operationId }))?.state,
      ).toMatchObject({
        status: "abandoned",
        failureCode: null,
        reconciliationRequired: false,
        abandonmentReason: "author_abandoned_unresolved_provider",
      });
      expect(
        (
          await admin.query(
            `SELECT abandonment_reason,retention_disposition,failure_code,retryable
             FROM media_post_submissions WHERE submission_id=$1`,
            [submissionId],
          )
        ).rows,
      ).toEqual([
        {
          abandonment_reason: "author_abandoned_unresolved_provider",
          retention_disposition: "retain_for_reconciliation",
          failure_code: null,
          retryable: null,
        },
      ]);
    });
  });

  test("drill 5: membership loss retains analysis, refuses ineligible retry, and publishes after rejoin", async () => {
    await fixture(async (admin, connection) => {
      const { store } = await finalizedFixture(connection);
      await admin.query(
        "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id=$2",
        [community, actor],
      );
      const services = {
        store,
        nowIso: () => new Date().toISOString(),
        randomUuid: () => crypto.randomUUID(),
      };
      expect(
        await acceptTrustedVideoAnalysis({ submissionId, analysis: trustedAnalysis() }, services),
      ).toMatchObject({
        status: "processing_failed",
        reason_code: "membership_required",
        retryable: true,
      });
      const failed = await store.getSubmissionByOperation({ submissionId, operationId });
      if (!failed) throw new Error("missing failed submission");
      expect(failed.state.reconciliationRequired).toBe(false);
      expect(failed.state.analysis).not.toBeNull();
      expect(failed.state.decision?.outcome.kind).toBe("publish");
      const retry = {
        submission: failed.state,
        endpointTemplate: "/media-post-submissions/:submissionId/retry",
        idempotencyKey: "membership-retry",
        requestHash: "a".repeat(64),
        responseBytes,
        responseSha256,
      };
      expect(await store.retryTechnical(retry)).toEqual({ kind: "membership_required" });
      expect(await store.getSubmissionByOperation({ submissionId, operationId })).toEqual(failed);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM posts WHERE post_type='video'")).rows[0]
          .n,
      ).toBe(0);
      await admin.query(
        "UPDATE community_memberships SET status='member',left_at=NULL WHERE community_id=$1 AND user_id=$2",
        [community, actor],
      );
      expect(await store.retryTechnical(retry)).toEqual({ kind: "none" });
      const resumed = await store.getSubmissionByOperation({ submissionId, operationId });
      expect(resumed?.state).toMatchObject({
        status: "processing",
        phase: "publish",
        creationRevision: failed.state.creationRevision + 1,
        retryCount: 1,
        analysis: failed.state.analysis,
      });
      expect(resumed?.state.decision?.effectiveContentRating).toBe("general");
      await admin.query(
        "UPDATE media_post_submissions SET resulting_content_rating='adult_18' WHERE submission_id=$1",
        [submissionId],
      );
      expect(
        await acceptTrustedVideoAnalysis({ submissionId, analysis: trustedAnalysis() }, services),
      ).toMatchObject({ status: "published" });
      expect(
        await acceptTrustedVideoAnalysis({ submissionId, analysis: trustedAnalysis() }, services),
      ).toMatchObject({ status: "published" });
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM posts WHERE post_type='video'")).rows[0]
          .n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT p.content_rating,projection.content_rating AS projection_rating,s.resulting_content_rating FROM posts p JOIN media_publication_projections projection USING(community_id,post_id) JOIN media_post_submissions s USING(submission_id) WHERE s.submission_id=$1",
            [submissionId],
          )
        ).rows[0],
      ).toEqual({
        content_rating: "adult_18",
        projection_rating: "adult_18",
        resulting_content_rating: "adult_18",
      });
      expect(
        (await store.getSubmissionByOperation({ submissionId, operationId }))?.state.decision
          ?.effectiveContentRating,
      ).toBe("general");
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM media_video_transform_attempts")).rows[0]
          .n,
      ).toBe(0);
    });
  });
  test("drill 3 launch fence: sweep converges an accepted instance after the launch lease expires", async () => {
    await fixture(async (admin, connection) => {
      const { layer, store } = await finalizedFixture(connection);
      const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
      const [pending] = await outbox.listEligible(10);
      if (!pending) throw new Error("missing intent");
      const claimed = await outbox.claim(pending.effectIdentity, "lost-worker");
      if (!claimed) throw new Error("missing claim");
      await admin.query(
        `UPDATE media_video_analysis_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE effect_identity=$1`,
        [pending.effectIdentity],
      );
      expect(await outbox.claim(pending.effectIdentity, "queue-redelivery")).toBeNull();
      const instanceId = `vaw-${"a".repeat(64)}`;
      expect(
        await recoverVideoWorkflowLaunches({
          outbox,
          store,
          launcher: {
            inspect: async () => ({ state: "present", status: "running" }),
            instanceId: async () => instanceId,
          },
        }),
      ).toMatchObject({ recovered: 1, failed: 0 });
      expect(await outbox.get(pending.effectIdentity)).toMatchObject({
        state: "launched",
        launchAttempts: 1,
        claimFence: 2,
      });
      expect(await outbox.markLaunched(claimed, instanceId)).toBe(false);
    });
  });

  test("drill 3 recovery: missing Workflow marks the launch for Queue redispatch without spending an attempt", async () => {
    await fixture(async (_admin, connection) => {
      const { layer, store } = await finalizedFixture(connection);
      const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
      const [pending] = await outbox.listEligible(10);
      if (!pending) throw new Error("missing intent");
      const claimed = await outbox.claim(pending.effectIdentity, "launch-worker");
      if (!claimed) throw new Error("missing claim");
      const instanceId = `vaw-${"a".repeat(64)}`;
      await outbox.markLaunched(claimed, instanceId);
      const result = await recoverVideoWorkflowLaunches({
        outbox,
        store,
        launcher: {
          inspect: async () => ({ state: "missing", status: null }),
          instanceId: async () => instanceId,
        },
      });
      expect(result).toMatchObject({ missing: 1, failed: 0 });
      expect(await outbox.get(pending.effectIdentity)).toMatchObject({
        state: "launched",
        instanceMissing: true,
        launchAttempts: 1,
      });
      expect((await outbox.listEligible(10)).map((row) => row.effectIdentity)).toEqual([
        pending.effectIdentity,
      ]);
    });
  });

  test("drill 3 recovery: terminal Workflow without a PostgreSQL outcome records a typed failure", async () => {
    await fixture(async (_admin, connection) => {
      const { layer, store } = await finalizedFixture(connection);
      const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
      const [pending] = await outbox.listEligible(10);
      if (!pending) throw new Error("missing intent");
      const claimed = await outbox.claim(pending.effectIdentity, "launch-worker");
      if (!claimed) throw new Error("missing claim");
      const instanceId = `vaw-${"a".repeat(64)}`;
      await outbox.markLaunched(claimed, instanceId);
      expect(
        await recoverVideoWorkflowLaunches({
          outbox,
          store,
          launcher: {
            inspect: async () => ({ state: "terminal", status: "errored" }),
            instanceId: async () => instanceId,
          },
        }),
      ).toMatchObject({ terminal: 1, failed: 0 });
      expect(
        (await store.getSubmissionByOperation({ submissionId, operationId }))?.state,
      ).toMatchObject({ status: "processing_failed", failureCode: "transform_failed" });
      await expect(
        outbox.loadOrCreate({
          submissionId,
          capability: "probe",
          binding: {
            requestId: "too-late",
            operationId,
            creationRevision: 1,
            videoRevision: 1,
            analysisRevision: 1,
            canonicalVideoSha256: videoSha256,
          },
          initialAttempt: {
            version: "media-transform-attempt-v1",
            runtimeFence: { submittedAtMs: 0, runtimeDeadlineMs: 10000 },
          },
        }),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      expect(await outbox.listForReconciliation(10)).toEqual([]);
    });
  });

  for (const { accepted, phase } of [
    { accepted: false, phase: "started" },
    { accepted: false, phase: "submitting" },
    { accepted: true, phase: "started" },
    { accepted: false, phase: "allocated" },
  ]) {
    test(`terminal sweep ${phase}: ${phase === "submitting" && !accepted ? "requires reconciliation for ambiguous submission" : "continues safely from durable work"}`, async () => {
      await fixture(async (admin, connection) => {
        const { layer, store, finalized } = await finalizedFixture(connection);
        const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
        const [pending] = await outbox.listEligible(10);
        if (!pending) throw new Error("missing intent");
        const claimed = await outbox.claim(pending.effectIdentity, "sweep-fixture");
        if (!claimed) throw new Error("missing claim");
        const instanceId = `vaw-${"a".repeat(64)}`;
        await outbox.markLaunched(claimed, instanceId);
        await admin.query(
          `INSERT INTO media_video_transform_attempts
          (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
           canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
          VALUES ('sweep-task',$1,$2,1,1,1,$3,'probe',0,10000,'provider-task',$4)`,
          [submissionId, operationId, videoSha256, phase],
        );
        if (accepted) {
          const analysis = trustedAnalysis();
          const soundtrack = analysis.audio.soundtrack;
          if (soundtrack.verification === null) throw new Error("fixture requires recognition");
          const facts: VideoStageFact[] = [
            {
              stage: "probe",
              adapterRevision: "qencode-v1",
              snapshot: analysis.probe,
              artifacts: [],
            },
            {
              stage: "audio",
              adapterRevision: "qencode-v1",
              snapshot: {
                sizeBytes: 42,
                offsetMs: 0,
                durationMs: 10000,
                clips: [
                  {
                    variant: "primary",
                    artifactRef: `${soundtrack.extractedAudioRef}.primary.mp3`,
                    canonicalSha256: soundtrack.extractedAudioSha256,
                    sizeBytes: 42,
                    mediaType: "audio/mpeg",
                    offsetMs: 0,
                    durationMs: 10000,
                  },
                  {
                    variant: "alternate",
                    artifactRef: `${soundtrack.extractedAudioRef}.alternate.mp3`,
                    canonicalSha256: soundtrack.extractedAudioSha256,
                    sizeBytes: 42,
                    mediaType: "audio/mpeg",
                    offsetMs: 0,
                    durationMs: 10000,
                  },
                ],
                artifactRef: soundtrack.extractedAudioRef,
                canonicalSha256: soundtrack.extractedAudioSha256,
                sourceSha256: videoSha256,
                videoRevision: 1,
                mediaType: "audio/mp4",
                policyRevision: soundtrack.policyRevision,
                adapterRevision: "qencode-v1",
              },
              artifacts: [
                ...(["primary", "alternate"] as const).map((variant) => ({
                  artifactRef: `${soundtrack.extractedAudioRef}.${variant}.mp3`,
                  canonicalSha256: soundtrack.extractedAudioSha256,
                  sizeBytes: 42,
                  contentType: "audio/mpeg" as const,
                })),
                {
                  artifactRef: soundtrack.extractedAudioRef,
                  canonicalSha256: soundtrack.extractedAudioSha256,
                  sizeBytes: 42,
                  contentType: "audio/mp4",
                },
              ],
            },
            {
              stage: "frames",
              adapterRevision: "frames-v1",
              snapshot: {
                evidenceRef: analysis.frames.evidenceRef,
                adapterRevision: "frames-v1",
                sourceSha256: videoSha256,
                videoRevision: 1,
                posterPolicyRevision: 1,
                frames: analysis.frames.extracted,
              },
              artifacts: analysis.frames.extracted.map((frame) => ({
                artifactRef: frame.artifactRef,
                canonicalSha256: frame.sha256,
                sizeBytes: 42,
                contentType: "image/jpeg",
              })),
            },
            {
              stage: "recognition",
              adapterRevision: "acr-v1",
              snapshot: {
                verification: soundtrack.verification,
                evidenceRef: "acr:fixture",
                adapterRevision: "acr-v1",
              },
              artifacts: [],
            },
            {
              stage: "safety",
              adapterRevision: "safety-v1",
              snapshot: {
                requestId: analysis.safetyRequest.requestId,
                evidenceRef: analysis.safetyRequest.evidenceRef,
                minorSafetyEvidenceRef: analysis.safetyRequest.minorSafetyEvidenceRef,
                mediaSafety: analysis.mediaSafety,
                captionSafety: analysis.captionSafety,
                automatedRating: analysis.automatedRating,
                policyRevision: analysis.safetyPolicyRevision,
                adapterRevision: "safety-v1",
              },
              artifacts: [],
            },
          ];
          const factStore = makeControlPlaneVideoStageFactStore(layer);
          for (const fact of facts)
            await factStore.write({
              submission: finalized.state,
              observedEventSequence: finalized.eventSequence,
              fact,
            });
          expect(
            await factStore.read({ submissionId, videoRevision: 1, creationRevision: 1 }),
          ).toHaveLength(5);
        }

        const result = await recoverVideoWorkflowLaunches({
          outbox,
          store,
          launcher: {
            inspect: async () => ({ state: "terminal", status: "errored" }),
            instanceId: async () => instanceId,
          },
        });
        const required = !accepted && phase === "submitting";
        expect(result).toMatchObject({
          terminal: required ? 1 : 0,
          failed: 0,
          recovered: required ? 0 : 1,
        });
        const current = await store.getSubmissionByOperation({ submissionId, operationId });
        expect(current?.state.status).toBe(required ? "processing_failed" : "processing");
        expect(current?.state.reconciliationRequired).toBe(required);
        if (!required) expect(current?.eventSequence).toBe(finalized.eventSequence);
        else if (current)
          expect(projectVideoSubmission(current)).toMatchObject({ retryable: false });
        const continued = await outbox.get(pending.effectIdentity);
        expect(continued?.continuation).toBe(required ? 0 : 1);
        if (!required) {
          expect(continued?.state).toBe("pending");
          expect(continued?.workflowInstanceId).toBeNull();
          const nextClaim = await outbox.claim(pending.effectIdentity, "continuation-launcher");
          if (!nextClaim) throw new Error("missing continuation claim");
          const nextId = `vaw-${"b".repeat(64)}`;
          expect(await outbox.markLaunched(nextClaim, nextId)).toBe(true);
          expect((await outbox.get(pending.effectIdentity))?.workflowInstanceId).toBe(nextId);
          expect(await outbox.scheduleContinuation(claimed, finalized.eventSequence)).toBe(false);
        }
        const attempt = await admin.query(
          "SELECT reconciliation_state,last_observation FROM media_video_transform_attempts WHERE request_id='sweep-task'",
        );
        expect(attempt.rows[0]?.reconciliation_state).toBe(required ? "required" : "none");
        if (required) expect(attempt.rows[0]?.last_observation.status).toBe("workflow_terminal");
      });
    });
  }

  for (const phase of ["allocated", "started"] as const) {
    test(`continuation cap requires reconciliation on third terminal ${phase}`, async () => {
      await fixture(async (admin, connection) => {
        const { layer, store, finalized } = await finalizedFixture(connection);
        const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
        const [pending] = await outbox.listEligible(10);
        if (!pending) throw new Error("missing intent");
        await admin.query(
          `INSERT INTO media_video_transform_attempts
          (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
           canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
          VALUES ('capped-task',$1,$2,1,1,1,$3,'probe',0,10000,'provider-task',$4)`,
          [submissionId, operationId, videoSha256, phase],
        );
        for (let continuation = 0; continuation <= 2; continuation++) {
          const claim = await outbox.claim(pending.effectIdentity, "cap-fixture");
          if (!claim) throw new Error("missing claim");
          expect(claim.continuation).toBe(continuation);
          await outbox.markLaunched(claim, `vaw-${String(continuation + 1).repeat(64)}`);
          const result = await recoverVideoWorkflowLaunches({
            outbox,
            store,
            launcher: {
              inspect: async () => ({ state: "terminal", status: "errored" }),
              instanceId: async () => `vaw-${String(continuation + 1).repeat(64)}`,
            },
          });
          expect(result).toMatchObject({
            failed: 0,
            recovered: continuation < 2 ? 1 : 0,
            terminal: continuation === 2 ? 1 : 0,
          });
        }
        const current = await store.getSubmissionByOperation({ submissionId, operationId });
        expect(current?.state.reconciliationRequired).toBe(true);
        expect(current?.state.creationRevision).toBe(finalized.state.creationRevision);
        if (current) expect(projectVideoSubmission(current)).toMatchObject({ retryable: false });
        expect((await outbox.get(pending.effectIdentity))?.continuation).toBe(2);
        expect(await outbox.listEligible(10)).toEqual([]);
      });
    });
  }

  test("drill 3 recovery: a transition during status inspection fences the stale terminal failure", async () => {
    await fixture(async (admin, connection) => {
      const { layer, store } = await finalizedFixture(connection);
      const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
      const [pending] = await outbox.listEligible(10);
      if (!pending) throw new Error("missing intent");
      const claimed = await outbox.claim(pending.effectIdentity, "launch-worker");
      if (!claimed) throw new Error("missing claim");
      const instanceId = `vaw-${"a".repeat(64)}`;
      await outbox.markLaunched(claimed, instanceId);
      const before = await store.getSubmissionByOperation({ submissionId, operationId });
      if (!before) throw new Error("missing submission");
      const result = await recoverVideoWorkflowLaunches({
        outbox,
        store,
        launcher: {
          inspect: async () => {
            // Same creation/video/analysis revisions: only the committed event
            // fence distinguishes the newer publication phase from the read.
            await admin.query(
              `UPDATE media_post_submissions SET event_sequence=event_sequence+1,updated_at=clock_timestamp(),
                 phase='publish',video_state_snapshot=jsonb_set(video_state_snapshot,'{phase}','"publish"')
               WHERE submission_id=$1`,
              [submissionId],
            );
            return { state: "terminal", status: "complete" };
          },
          instanceId: async () => instanceId,
        },
      });
      expect(result).toMatchObject({ terminal: 0, failed: 1 });
      const after = await store.getSubmissionByOperation({ submissionId, operationId });
      expect(after?.state).toMatchObject({
        status: "processing",
        phase: "publish",
        failureCode: null,
      });
      expect(after?.eventSequence).toBe(before.eventSequence + 1);
      await expect(
        store.recordProcessingFailure({
          submission: before.state,
          observedEventSequence: before.eventSequence,
          failureCode: "transform_failed",
          evidenceRef: "stale-launch-exhaustion",
        }),
      ).rejects.toThrow();
    });
  });

  test("renews one expired part after claim without changing other parts or the reservation deadline", async () => {
    await fixture(async (admin, connection) => {
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlaneVideoPublicationStore(layer);
      let now = new Date().toISOString();
      const deadline = new Date(Date.parse(now) + 3_921_000).toISOString();
      const partDeadline = new Date(Date.parse(now) + 3_600_000).toISOString();
      let renewals = 0;
      const unused = async (): Promise<never> => {
        throw new Error("unexpected upload effect");
      };
      const services: VideoPublicationServices = {
        store,
        personaServices: {
          personaStore: makeControlPlanePersonaStore(layer),
          runEffect: (effect, signal) =>
            Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
        },
        nowIso: () => now,
        randomUuid: () => crypto.randomUUID(),
        sealer: { inspect: unused, seal: unused },
        multipart: {
          create: async ({ partCount, partSizeBytes }) => ({
            uploadId: "renew-upload",
            partCount,
            partSizeBytes,
            expiresAt: partDeadline,
            parts: [1, 2].map((partNumber) => ({
              partNumber,
              url: `https://upload.invalid/original/${partNumber}`,
              expiresAt: partDeadline,
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
      // New original-audio videos are refused before any row or upload exists.
      await expect(
        reserveVideoUpload(
          {
            communityId: community,
            actor: author,
            body: {
              track: "video",
              slot: "primary_video",
              intent: "original_audio",
              persona_id: persona,
              idempotency_key: "reserve-renew-refused",
              expected_content_type: "video/mp4",
              expected_size_bytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
            },
          },
          services,
        ),
      ).rejects.toMatchObject({ details: { reason_code: "song_reference_required" } });
      const refused = await admin.query(
        "SELECT count(*)::int AS n FROM media_upload_reservations WHERE actor_user_id=$1 AND media_kind='video'",
        [actor],
      );
      expect(refused.rows[0]?.n).toBe(0);
      // An original-audio submission started before the rule keeps renewing.
      const id = `media-reservation-${crypto.randomUUID()}`;
      await store.createReservation({
        record: {
          reservationId: id,
          communityId: community,
          intent: "original_audio",
          actorAccountId: actor,
          authorPersonaId: persona,
          requestHash: "e".repeat(64),
          expectedContentType: "video/mp4",
          expectedSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
          expectedSha256: null,
          ingestPolicyRevision: 1,
          uploadId: "renew-upload",
          partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
          partCount: 2,
          expiresAt: deadline,
          state: "issued",
          submissionId: null,
          operationId: null,
          manifest: null,
          responseBytes,
          updatedAt: now,
        },
        idempotencyKey: "reserve-renew",
        responseSha256,
        parts: [1, 2].map((partNumber) => ({
          partNumber,
          url: `https://upload.invalid/original/${partNumber}`,
          expiresAt: partDeadline,
        })),
      });
      await store.createSubmission({
        state: createOriginalVideoSubmission({
          submissionId: `media-submission-${crypto.randomUUID()}`,
          operationId: `media-operation-${crypto.randomUUID()}`,
          communityId: community,
          actorAccountId: actor,
          authorPersonaId: persona,
          reservationId: id,
          caption: null,
          authorDeclaredRating: "general",
        }),
        idempotencyKey: "start-renew",
        requestHash: "f".repeat(64),
        startInput: { version: "video-start-input-v1", video_reservation_id: id },
        responseBytes,
        responseSha256,
      });
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
      ).rejects.toMatchObject({ details: { reason_code: "action_expired" } });
      expect(renewals).toBe(1);
    });
  });

  test("commits original-video publication effects atomically and replay creates no duplicate", async () => {
    await fixture(async (admin, connection) => {
      const { layer, store, finalized } = await finalizedFixture(connection);
      await expect(
        store.recordProcessingFailure({
          submission: { ...finalized.state, creationRevision: 0 },
          observedEventSequence: finalized.eventSequence,
          failureCode: "transform_failed",
          evidenceRef: "workflow:stale-creation",
        }),
      ).rejects.toThrow("video processing failure fence rejected");
      const analysisOutbox = makeControlPlaneVideoAnalysisOutboxRepository(layer, {
        leaseSeconds: 60,
        retryBaseMs: 1,
        now: () => Date.parse("2026-09-04T00:00:00.000Z"),
      });
      const transformBinding = {
        operationId,
        videoRevision: 1,
        creationRevision: 1,
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
      await expect(
        analysisOutbox.advance({
          submissionId,
          binding: transformBinding,
          capability: "probe",
          attempt: startedTransformAttempt,
        }),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      await analysisOutbox.advance({
        submissionId,
        binding: transformBinding,
        capability: "probe",
        attempt: { ...allocatedTransformAttempt, providerJobPhase: "submitting" },
      });
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
      expect(firstClaim).toMatchObject({ state: "launching", launchAttempts: 1, claimFence: 1 });
      expect(await analysisOutbox.claim(firstClaim.effectIdentity, "other-worker")).toBeNull();
      const instanceId = `vaw-${"a".repeat(64)}`;
      expect(await analysisOutbox.markLaunched(firstClaim, instanceId)).toBe(true);
      expect(await analysisOutbox.markLaunched(firstClaim, instanceId)).toBe(false);
      expect(await analysisOutbox.listEligible(10)).toEqual([]);
      const launched = await analysisOutbox.get(firstClaim.effectIdentity);
      if (launched === null) throw new Error("launch record missing");
      expect(await analysisOutbox.markInstanceMissing(launched)).toBe(true);
      expect((await analysisOutbox.get(firstClaim.effectIdentity))?.launchAttempts).toBe(1);
      const recovered = await analysisOutbox.claim(firstClaim.effectIdentity, "recovery-worker");
      if (recovered === null) throw new Error("missing instance not eligible");
      expect(recovered.launchAttempts).toBe(2);
      expect(await analysisOutbox.markRetryWait(recovered, "provider_timeout")).toBe(true);
      const finalClaim = await analysisOutbox.claim(firstClaim.effectIdentity, "final-worker");
      if (finalClaim === null) throw new Error("retry not eligible");
      expect(finalClaim.launchAttempts).toBe(3);
      expect(await analysisOutbox.markRetryWait(finalClaim, "provider_unavailable")).toBe(false);
      expect(await analysisOutbox.markExhausted(finalClaim)).toBe(true);
      expect(await analysisOutbox.get(firstClaim.effectIdentity)).toMatchObject({
        state: "exhausted",
        launchAttempts: 3,
      });
      expect(await analysisOutbox.listEligible(10)).toEqual([]);
      const fixtureAnalysis = trustedAnalysis();
      const posterFrames = fixtureAnalysis.frames.extracted.map((frame) => ({
        ...frame,
        artifactRef: `media://derived/video-analysis/${operationId}/v1/c${finalized.state.creationRevision}/a1/${frame.role}.jpg`,
      })) as unknown as VideoTrustedAnalysis["frames"]["extracted"];
      const baseAnalysis = {
        ...fixtureAnalysis,
        frames: { ...fixtureAnalysis.frames, extracted: posterFrames },
      };
      const analysis: OriginalAudioTrustedAnalysis = {
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
        observedEventSequence: ready.eventSequence,
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
      await expect(
        store.publish({ ...bundle, observedEventSequence: ready.eventSequence - 1 }),
      ).rejects.toThrow("video publication fence rejected");
      await store.publish(bundle);
      await store.publish(bundle);
      const resolvePoster = makeVideoPosterAuthority(layer);
      const posterIdentity = {
        postId: "post-video-publication",
        communityId: community,
        artifactRef: analysis.frames.extracted[0].artifactRef,
      };
      expect(await Effect.runPromise(resolvePoster(posterIdentity))).toEqual({
        artifactRef: posterIdentity.artifactRef,
        key: `video-analysis/${operationId}/v1/c${finalized.state.creationRevision}/a1/poster.jpg`,
        sha256: analysis.frames.extracted[0].sha256,
        sourceSha256: videoSha256,
        policyRevision: "1",
      });
      for (const override of [
        { postId: "absent-video" },
        { communityId: "another-community" },
        { artifactRef: analysis.frames.extracted[1].artifactRef },
        { artifactRef: analysis.frames.extracted[2].artifactRef },
        { artifactRef: `media://derived/video-analysis/${operationId}/v2/a1/poster.jpg` },
        { artifactRef: `media://derived/video-analysis/${operationId}/v1/a2/poster.jpg` },
        { artifactRef: `media://derived/video-analysis/${operationId}/v1/c2/a1/poster.jpg` },
        { artifactRef: `media://derived/video-analysis/${operationId}/v1/a1/poster.jpg` },
        { artifactRef: "media://derived/private/secret" },
      ]) {
        expect(
          await Effect.runPromise(resolvePoster({ ...posterIdentity, ...override })),
        ).toBeNull();
      }
      const authorize = makeVideoPublicationAuthorization(layer);
      const access = () =>
        Effect.runPromise(authorize({ postId: "post-video-publication", communityId: community }));
      expect(await access()).toBe(true);
      expect(
        await Effect.runPromise(authorize({ postId: "absent-video", communityId: community })),
      ).toBe(false);
      await admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
        "post-video-publication",
      ]);
      expect(await access()).toBe(false);
      expect(
        await Effect.runPromise(
          authorize({
            postId: "post-video-publication",
            communityId: community,
            viewerUserId: actor,
          }),
        ),
      ).toBe(true);
      await admin.query("UPDATE posts SET visibility='public',status='hidden' WHERE post_id=$1", [
        "post-video-publication",
      ]);
      expect(await access()).toBe(false);
      await admin.query("UPDATE posts SET status='published' WHERE post_id=$1", [
        "post-video-publication",
      ]);
      const approvedHold = await admin.query(
        "SELECT action_id,evidence_ref FROM media_video_review_holds WHERE submission_id=$1 AND creation_revision=1 AND hold_kind='safety'",
        [submissionId],
      );
      await admin.query(
        "UPDATE media_video_review_holds SET status='open',action_id=NULL,evidence_ref=NULL WHERE submission_id=$1 AND creation_revision=1 AND hold_kind='safety'",
        [submissionId],
      );
      expect(await access()).toBe(false);
      await admin.query(
        "UPDATE media_video_review_holds SET status='approved',action_id=$2,evidence_ref=$3 WHERE submission_id=$1 AND creation_revision=1 AND hold_kind='safety'",
        [submissionId, approvedHold.rows[0].action_id, approvedHold.rows[0].evidence_ref],
      );
      expect(await access()).toBe(true);

      const safetyRef = `evidence_${"a".repeat(64)}`;
      await admin.query(
        `INSERT INTO media_video_safety_evidence
          (submission_id,video_revision,creation_revision,request_id,input_sha256,evidence_ref,evidence_snapshot,platform_held)
         VALUES ($1,1,1,'delivery-platform-hold',$2,$3,$4::jsonb,true)`,
        [
          submissionId,
          "b".repeat(64),
          safetyRef,
          JSON.stringify({
            requestId: "delivery-platform-hold",
            inputDigest: "b".repeat(64),
            platformHeld: true,
            fact: { evidenceRef: safetyRef, mediaSafety: "blocked", minorSafetyEvidenceRef: null },
          }),
        ],
      );
      expect(await access()).toBe(false);

      // Publication itself projects the video into Home.
      const projection = await admin.query(
        `SELECT feed_item_id FROM home_feed_projection
          WHERE community_id=$1 AND post_id='post-video-publication'`,
        [community],
      );
      expect(projection.rows).toHaveLength(1);
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
      // Home lists a video only once Stream can play it.
      const feedIds = (feed: typeof projectedFeed) =>
        feed.items.map((item) => (item as { post?: { post?: { id?: string } } }).post?.post?.id);
      expect(feedIds(projectedFeed)).not.toContain("post-video-publication");
      await admin.query(
        `UPDATE media_video_stream_ingests
            SET state='ready',creator_marker=$2,source_sha256=$3,provider_video_id=$4,
                acceptance_deadline_ms=1000,encoding_deadline_ms=2000
          WHERE operation_id=(SELECT operation_id FROM media_publication_projections
                               WHERE community_id=$1 AND post_id='post-video-publication')`,
        [community, "c".repeat(64), "d".repeat(64), "e".repeat(32)],
      );
      const readyFeed = await Effect.runPromise(
        Effect.scoped(feedStore.listHome({ query: {}, viewerUserId: actor })),
      );
      expect(feedIds(readyFeed)).toContain("post-video-publication");
      const readyItem = readyFeed.items.find(
        (item) =>
          (item as { post?: { post?: { id?: string } } }).post?.post?.id ===
          "post-video-publication",
      );
      expect(readyItem).toMatchObject({
        post: {
          post: { id: "post-video-publication", post_type: "video", body: null },
          video: {
            playback: { status: "ready", provider: "stream", playback_ref: "e".repeat(32) },
          },
        },
      });
      // Replayed publication must not add a second Home row.
      await admin.query(
        `INSERT INTO home_feed_projection (community_id,feed_item_id,post_id,rank_score,projected_at)
         SELECT community_id, feed_item_id, post_id, 0, clock_timestamp() FROM home_feed_projection
          WHERE community_id=$1 AND post_id='post-video-publication'
         ON CONFLICT (community_id,post_id) DO NOTHING`,
        [community],
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM home_feed_projection WHERE community_id=$1 AND post_id='post-video-publication'",
            [community],
          )
        ).rows[0],
      ).toEqual({ n: 1 });
      const publicProjection = JSON.stringify({ projectedPost, projectedFeed, readyFeed });
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
      await admin.query("UPDATE posts SET content_rating='adult_18' WHERE post_id=$1", [
        "post-video-publication",
      ]);
      expect(await access()).toBe(false);
      expect(
        await makePostgresDataRegistrationArtifactAuthorityReader(layer).read(operation),
      ).toMatchObject({ contentRating: "adult_18" });
      await expect(
        admin.query("UPDATE posts SET content_rating='general' WHERE post_id=$1", [
          "post-video-publication",
        ]),
      ).rejects.toThrow("current content rating cannot be lowered");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            contentStore.getPost({
              communityId: community,
              postId: "post-video-publication",
              viewerUserId: actor,
            }),
          ),
        ),
      ).toMatchObject({ kind: "age_locked" });
    });
  });
  test("a publication-only retry plays and serves its poster on the decision, approvals and safety evidence it rests on", async () => {
    await fixture(async (admin, connection) => {
      const { store, layer, finalized } = await finalizedFixture(connection);
      const services = {
        store,
        nowIso: () => new Date().toISOString(),
        randomUuid: () => crypto.randomUUID(),
      };
      // Decided at creation revision 1, held for safety review, approved by a
      // moderator: the approval belongs to revision 1.
      const fixtureAnalysis = trustedAnalysis();
      const frames = fixtureAnalysis.frames.extracted.map((frame) => ({
        ...frame,
        artifactRef: `media://derived/video-analysis/${operationId}/v1/c1/a1/${frame.role}.jpg`,
      })) as unknown as VideoTrustedAnalysis["frames"]["extracted"];
      const analysis: OriginalAudioTrustedAnalysis = {
        ...fixtureAnalysis,
        frames: { ...fixtureAnalysis.frames, extracted: frames },
        mediaSafety: "review_required",
      };
      const decision = decideOriginalAudioVideo({
        state: finalized.state,
        analysis,
        canonicalCaptionSha256: null,
        decidedAt: "2026-09-10T00:02:00.000Z",
      });
      const held = await store.commitAnalysisDecision({
        submission: finalized.state,
        analysis,
        decision,
        nextState: attachVideoDecision(finalized.state, analysis, decision),
      });
      expect(held.state.status).toBe("manual_review");
      await store.moderate({
        submission: held.state,
        actor: { kind: "user", userId: actor },
        expectedCreationRevision: 1,
        action: { kind: "approve", hold: "safety", evidenceRef: null },
        endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
        idempotencyKey: "retry-approve-safety",
        requestHash: "8".repeat(64),
        responseBytes,
        responseSha256,
      });
      // Membership lapses before the commit, so nothing publishes.
      await admin.query(
        "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id=$2",
        [community, actor],
      );
      expect(await acceptTrustedVideoAnalysis({ submissionId, analysis }, services)).toMatchObject({
        status: "processing_failed",
        reason_code: "membership_required",
      });
      await admin.query(
        "UPDATE community_memberships SET status='member',left_at=NULL WHERE community_id=$1 AND user_id=$2",
        [community, actor],
      );
      const failed = await store.getSubmissionByOperation({ submissionId, operationId });
      if (failed === null) throw new Error("missing failed submission");
      expect(
        await store.retryTechnical({
          submission: failed.state,
          endpointTemplate: "/media-post-submissions/:submissionId/retry",
          idempotencyKey: "publication-retry",
          requestHash: "a".repeat(64),
          responseBytes,
          responseSha256,
        }),
      ).toEqual({ kind: "none" });
      const published = await acceptTrustedVideoAnalysis({ submissionId, analysis }, services);
      if (published.status !== "published") throw new Error("retry did not publish");
      const postId = published.published_resource.post_id;
      // Published at revision 2, on the decision of revision 1.
      const anchor = await admin.query(
        "SELECT creation_revision::int AS created, decision_revision::int AS decided FROM media_publication_projections WHERE post_id=$1",
        [postId],
      );
      expect(anchor.rows[0]).toEqual({ created: 2, decided: 1 });
      const contentStore = makeControlPlaneContentStore(layer);
      const authorizePublication = makeVideoPublicationAuthorization(layer);
      const access = () =>
        Effect.runPromise(authorizePublication({ postId, communityId: community }));
      // The moderator's approval at revision 1 still authorizes the video.
      expect(await access()).toBe(true);

      // Playback: Stream encodes the sealed original, then a viewer is signed in.
      const providerVideoId = "0123456789abcdef0123456789abcdef";
      expect(
        await consumeVideoStreamIngest(`video-enrichment:${operationId}:stream`, {
          store: makeVideoStreamIngestStore(layer, { leaseOwner: "retry-test", leaseMs: 60_000 }),
          transport: {
            copy: async (input) => {
              expect(input.sealedSourceRef).toBe(`media://immutable/${operationId}/video/1`);
              expect(input.identity.sourceSha256).toBe(videoSha256);
            },
            observe: async (identity) => [
              {
                providerVideoId,
                creator: identity.creator,
                sourceSha256: identity.sourceSha256,
                encoding: "ready",
                requireSignedURLs: true,
                downloadsEnabled: false,
              },
            ],
          },
          nowMs: () => Date.now(),
          deadlines: (now) => ({
            acceptanceDeadlineMs: now + 600_000,
            encodingDeadlineMs: now + 3_600_000,
          }),
        }),
      ).toBe("ready");
      const playback = await Effect.runPromise(
        getVideoPlaybackAccess(
          { postId, trustedSource: "retry-test" },
          {
            contentStore,
            authorizePublication,
            resolveApprovedPlayback: makeVideoPlaybackAuthority(layer),
            customerHost: "customer-retry123.cloudflarestream.com",
            nowMs: Effect.sync(() => Date.now()),
            limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
            sign: () => Effect.succeed("header.payload.signature"),
          },
        ),
      );
      expect(playback.playback_url).toBe(
        "https://customer-retry123.cloudflarestream.com/header.payload.signature/manifest/video.m3u8",
      );

      // Poster: sealed under revision 1's analysis, verified, then served.
      const posterKey = `video-analysis/${operationId}/v1/c1/a1/poster.jpg`;
      const posterBytes = new TextEncoder().encode("sealed poster jpeg");
      const posterObject = {
        key: posterKey,
        size: posterBytes.byteLength,
        httpEtag: '"poster-etag"',
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {
          sha256: frames[0].sha256,
          sourceSha256: videoSha256,
          policyRevision: "1",
        },
      };
      const resolveArtifact = makeVideoPosterAuthority(layer);
      expect(
        await consumeVideoThumbnail(`video-enrichment:${operationId}:thumbnail`, {
          store: makeVideoThumbnailStore(layer, { leaseMs: 60_000 }),
          verify: makeVideoThumbnailVerifier({
            resolveArtifact,
            bucket: { head: async (key) => (key === posterKey ? posterObject : null) },
          }),
        }),
      ).toBe("ready");
      const poster = await Effect.runPromise(
        streamVideoPoster(
          { postId },
          {
            contentStore,
            authorizePublication,
            resolveArtifact,
            bucket: {
              get: async (key) =>
                key === posterKey
                  ? { ...posterObject, body: new Response(posterBytes).body as ReadableStream }
                  : null,
            },
          },
        ),
      );
      expect(poster.status).toBe(200);
      expect(poster.headers.get("ETag")).toBe('"poster-etag"');
      expect(new Uint8Array(await poster.arrayBuffer())).toEqual(posterBytes);

      // Safety evidence and holds are read from the decision's revision up to
      // the publication's: a platform hold or open hold at either denies.
      for (const revision of [1, 2]) {
        const safetyRef = `evidence_${String(revision).repeat(64)}`;
        const requestId = `retry-platform-hold-${revision}`;
        await admin.query(
          `INSERT INTO media_video_safety_evidence
            (submission_id,video_revision,creation_revision,request_id,input_sha256,evidence_ref,evidence_snapshot,platform_held)
           VALUES ($1,1,$2,$3,$4,$5,$6::jsonb,true)`,
          [
            submissionId,
            revision,
            requestId,
            "b".repeat(64),
            safetyRef,
            JSON.stringify({
              requestId,
              inputDigest: "b".repeat(64),
              platformHeld: true,
              fact: {
                evidenceRef: safetyRef,
                mediaSafety: "blocked",
                minorSafetyEvidenceRef: null,
              },
            }),
          ],
        );
        expect(await access()).toBe(false);
        await admin.query(
          "DELETE FROM media_video_safety_evidence WHERE submission_id=$1 AND creation_revision=$2",
          [submissionId, revision],
        );
        expect(await access()).toBe(true);
      }
      await admin.query(
        `INSERT INTO media_video_review_holds (submission_id,creation_revision,hold_kind,reason_codes)
         VALUES ($1,2,'safety','["media_review_required"]'::jsonb)`,
        [submissionId],
      );
      expect(await access()).toBe(false);
    });
  }, 120_000);

  test("attempt reconciliation atomically fences technical and poster retries and their projection", async () => {
    await fixture(async (admin, connection) => {
      const { store, finalized } = await finalizedFixture(connection);
      await admin.query(
        `INSERT INTO media_video_transform_attempts
        (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
         canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
        VALUES ('uncertain-task',$1,$2,1,1,1,$3,'frames',0,10000,'provider-task','submitting')`,
        [submissionId, operationId, videoSha256],
      );
      const pending = await store.enterAttemptReconciliation({
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        requestId: "uncertain-task",
        state: "pending",
        observation: { status: "not_found", observedAt: "2026-09-05T00:00:00Z" },
      });
      expect(pending).toEqual(finalized);
      expect(await store.getSubmissionByOperation({ submissionId, operationId })).toEqual(
        finalized,
      );
      const pendingAttempt = await admin.query(
        "SELECT reconciliation_state FROM media_video_transform_attempts WHERE request_id='uncertain-task'",
      );
      expect(pendingAttempt.rows[0]?.reconciliation_state).toBe("pending");
      const reconciled = await store.enterAttemptReconciliation({
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        requestId: "uncertain-task",
        state: "required",
        observation: { status: "not_found", observedAt: "2026-09-05T00:00:00Z" },
      });
      expect(reconciled.state.reconciliationRequired).toBe(true);
      const projection = projectVideoSubmission(reconciled);
      expect(projection.status).toBe("processing_failed");
      expect(projection).toMatchObject({
        reason_code: "provider_submission_unconfirmed",
        retryable: false,
      });
      const attempt = await admin.query(
        "SELECT reconciliation_state,reconciliation_evidence_ref FROM media_video_transform_attempts WHERE request_id='uncertain-task'",
      );
      expect(attempt.rows[0]).toEqual({
        reconciliation_state: "required",
        reconciliation_evidence_ref: "video-submission-unconfirmed:uncertain-task",
      });
      const stillRequired = await store.enterAttemptReconciliation({
        submission: reconciled.state,
        observedEventSequence: reconciled.eventSequence,
        requestId: "uncertain-task",
        state: "pending",
        observation: { status: "processing", observedAt: "2026-09-05T00:01:00Z" },
      });
      expect(stillRequired.state).toEqual(reconciled.state);
      expect(stillRequired.eventSequence).toBe(reconciled.eventSequence);
      const requiredAttempt = await admin.query(
        "SELECT reconciliation_state FROM media_video_transform_attempts WHERE request_id='uncertain-task'",
      );
      expect(requiredAttempt.rows[0]?.reconciliation_state).toBe("required");
      const command = {
        submission: reconciled.state,
        endpointTemplate: "/media-post-submissions/:submissionId/retry",
        idempotencyKey: "retry-blocked",
        requestHash: "1".repeat(64),
        responseBytes,
        responseSha256,
      };
      await expect(store.retryTechnical(command)).rejects.toThrow("video technical retry rejected");
      // Even a poster-specific failure must retain the independent uncertainty fence.
      await admin.query(
        `UPDATE media_post_submissions SET failure_code='poster_undecodable',
        video_state_snapshot=jsonb_set(video_state_snapshot,'{failureCode}','"poster_undecodable"'),
        event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1`,
        [submissionId],
      );
      await expect(store.retryPoster({ ...command, posterTimestampMs: 2000 })).rejects.toThrow(
        "poster retry rejected",
      );
      const current = await store.getSubmissionByOperation({ submissionId, operationId });
      expect(current?.state.creationRevision).toBe(1);
      expect(current?.state.retryCount).toBe(0);
      expect(current?.state.reconciliationRequired).toBe(true);
    });
  });

  for (const outcome of ["completed", "failed", "workflow_terminal"] as const) {
    test(`reconciliation resolution: required through ${outcome}`, async () => {
      await fixture(async (admin, connection) => {
        const { store, finalized } = await finalizedFixture(connection);
        await admin.query(
          `INSERT INTO media_video_transform_attempts
          (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
           canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
          VALUES ('resolve-task',$1,$2,1,1,1,$3,'probe',0,10000,'provider-task','submitting')`,
          [submissionId, operationId, videoSha256],
        );
        const required = await store.enterAttemptReconciliation({
          submission: finalized.state,
          observedEventSequence: finalized.eventSequence,
          requestId: "resolve-task",
          state: "required",
          observation: { status: "not_found", observedAt: "2026-09-05T00:00:00Z" },
        });
        const input = {
          submission: required.state,
          observedEventSequence: required.eventSequence,
          requestId: "resolve-task",
          observation:
            outcome === "completed"
              ? {
                  status: "completed" as const,
                  observedAt: "2026-09-05T00:01:00Z",
                  fact: {
                    stage: "probe" as const,
                    adapterRevision: "qencode-v1",
                    snapshot: trustedAnalysis().probe,
                    artifacts: [],
                  },
                }
              : {
                  status: outcome,
                  evidenceRef: "provider:confirmed",
                  observedAt: "2026-09-05T00:01:00Z",
                },
        };
        await expect(
          store.resolveAttemptReconciliation({
            ...input,
            observedEventSequence: required.eventSequence - 1,
          }),
        ).rejects.toThrow("video reconciliation resolution fence rejected");
        const resolved = await store.resolveAttemptReconciliation(input);
        expect(resolved.state.reconciliationRequired).toBe(outcome === "workflow_terminal");
        expect(resolved.state.status).toBe(
          outcome === "completed" ? "processing" : "processing_failed",
        );
        expect(resolved.state.phase).toBe(outcome === "completed" ? "analysis" : null);
        expect(resolved.state.retryCount).toBe(0);
        if (outcome === "completed") {
          expect(resolved.state.failureCode).toBeNull();
          expect(projectVideoSubmission(resolved)).not.toHaveProperty("reason_code");
        }
        if (outcome !== "completed")
          expect(projectVideoSubmission(resolved)).toMatchObject({
            retryable: outcome === "failed",
          });
        const facts = await admin.query(
          "SELECT fact_snapshot FROM media_video_stage_facts WHERE submission_id=$1",
          [submissionId],
        );
        expect(facts.rows.length).toBe(outcome === "completed" ? 1 : 0);
        if (outcome === "completed")
          expect(facts.rows[0]?.fact_snapshot.snapshot).toEqual(trustedAnalysis().probe);
        const attempt = await admin.query(
          "SELECT reconciliation_state FROM media_video_transform_attempts WHERE request_id='resolve-task'",
        );
        expect(attempt.rows[0]?.reconciliation_state).toBe(
          outcome === "workflow_terminal" ? "required" : "resolved",
        );
      });
    });
  }

  test("stage facts accept identical replay, reject divergent replay and fence stale authority", async () => {
    await fixture(async (_admin, connection) => {
      const { layer, finalized } = await finalizedFixture(connection);
      const facts = makeControlPlaneVideoStageFactStore(layer);
      const fact = {
        stage: "probe" as const,
        adapterRevision: "qencode-v1",
        snapshot: trustedAnalysis().probe,
        artifacts: [],
      };
      const input = {
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        fact,
      };
      expect(await facts.write(input)).toEqual(fact);
      expect(
        await facts.write({ ...input, fact: { ...fact, snapshot: { ...fact.snapshot } } }),
      ).toEqual(fact);
      await expect(
        facts.write({
          ...input,
          fact: { ...fact, snapshot: { ...fact.snapshot, durationMs: 9999 } },
        }),
      ).rejects.toThrow("video stage fact invariant rejected");
      await expect(
        facts.write({ ...input, observedEventSequence: finalized.eventSequence - 1 }),
      ).rejects.toThrow("video stage fact authority rejected");
      expect(await facts.read({ submissionId, videoRevision: 1, creationRevision: 1 })).toEqual([
        fact,
      ]);
      expect(await facts.read({ submissionId, videoRevision: 1, creationRevision: 2 })).toEqual([]);
    });
  });

  test("reconciliation resolution rolls back on a divergent immutable fact", async () => {
    await fixture(async (admin, connection) => {
      const { store, finalized } = await finalizedFixture(connection);
      await admin.query(
        `INSERT INTO media_video_transform_attempts
        (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
         canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
        VALUES ('conflict-task',$1,$2,1,1,1,$3,'probe',0,10000,'provider-task','started')`,
        [submissionId, operationId, videoSha256],
      );
      const required = await store.enterAttemptReconciliation({
        submission: finalized.state,
        observedEventSequence: finalized.eventSequence,
        requestId: "conflict-task",
        state: "required",
        observation: { status: "not_found", observedAt: "2026-09-05T00:00:00Z" },
      });
      await admin.query(
        `INSERT INTO media_video_stage_facts
        (submission_id,video_revision,creation_revision,stage,analysis_revision,adapter_revision,fact_snapshot)
        VALUES ($1,1,1,'probe',1,'qencode-v1',$2::jsonb)`,
        [submissionId, JSON.stringify({ ...trustedAnalysis().probe, durationMs: 9999 })],
      );
      await expect(
        store.resolveAttemptReconciliation({
          submission: required.state,
          observedEventSequence: required.eventSequence,
          requestId: "conflict-task",
          observation: {
            status: "completed",
            observedAt: "2026-09-05T00:01:00Z",
            fact: {
              stage: "probe",
              adapterRevision: "qencode-v1",
              snapshot: trustedAnalysis().probe,
              artifacts: [],
            },
          },
        }),
      ).rejects.toThrow("video stage fact invariant rejected");
      expect(
        (await store.getSubmissionByOperation({ submissionId, operationId }))?.eventSequence,
      ).toBe(required.eventSequence);
      const attempt = await admin.query(
        "SELECT reconciliation_state FROM media_video_transform_attempts WHERE request_id='conflict-task'",
      );
      expect(attempt.rows[0]?.reconciliation_state).toBe("required");
    });
  });

  test("reconciliation resolution preserves another attempt's prohibition and confirmed failure", async () => {
    await fixture(async (admin, connection) => {
      const { store, finalized } = await finalizedFixture(connection);
      for (const capability of ["probe", "frames"] as const) {
        await admin.query(
          `INSERT INTO media_video_transform_attempts
          (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
           canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
          VALUES ($4,$1,$2,1,1,1,$3,$4,0,10000,'provider-task','started')`,
          [submissionId, operationId, videoSha256, capability],
        );
      }
      let current = finalized;
      for (const requestId of ["probe", "frames"])
        current = await store.enterAttemptReconciliation({
          submission: current.state,
          observedEventSequence: current.eventSequence,
          requestId,
          state: "required",
          observation: { status: "not_found", observedAt: "2026-09-05T00:00:00Z" },
        });
      current = await store.resolveAttemptReconciliation({
        submission: current.state,
        observedEventSequence: current.eventSequence,
        requestId: "frames",
        observation: {
          status: "failed",
          evidenceRef: "frames:failed",
          observedAt: "2026-09-05T00:01:00Z",
        },
      });
      expect(current.state.reconciliationRequired).toBe(true);
      expect(projectVideoSubmission(current)).toMatchObject({ retryable: false });
      current = await store.resolveAttemptReconciliation({
        submission: current.state,
        observedEventSequence: current.eventSequence,
        requestId: "probe",
        observation: {
          status: "completed",
          observedAt: "2026-09-05T00:02:00Z",
          fact: {
            stage: "probe",
            adapterRevision: "qencode-v1",
            snapshot: trustedAnalysis().probe,
            artifacts: [],
          },
        },
      });
      expect(current.state.reconciliationRequired).toBe(false);
      expect(current.state.failureCode).toBe("transform_failed");
      expect(projectVideoSubmission(current)).toMatchObject({ retryable: true });
    });
  });

  test("reconciliation rolls back the attempt if its submission snapshot write fails", async () => {
    await fixture(async (admin, connection) => {
      const { store, finalized } = await finalizedFixture(connection);
      await admin.query(
        `INSERT INTO media_video_transform_attempts
        (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
         canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
        VALUES ('rollback-task',$1,$2,1,1,1,$3,'probe',0,10000,'provider-task','started')`,
        [submissionId, operationId, videoSha256],
      );
      await admin.query(`CREATE FUNCTION reject_reconciliation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected snapshot failure'; END $$`);
      await admin.query(`CREATE TRIGGER reject_reconciliation_fixture BEFORE UPDATE ON media_post_submissions
        FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_fixture()`);
      try {
        await expect(
          store.enterAttemptReconciliation({
            submission: finalized.state,
            observedEventSequence: finalized.eventSequence,
            requestId: "rollback-task",
            state: "required",
            observation: { status: "workflow_terminal", observedAt: "2026-09-05T00:00:00Z" },
          }),
        ).rejects.toMatchObject({
          _tag: "ControlPlaneStatementFailed",
          sqlState: "P0001",
          label: "video-publication.submission-update",
        });
      } finally {
        await admin.query("DROP TRIGGER reject_reconciliation_fixture ON media_post_submissions");
        await admin.query("DROP FUNCTION reject_reconciliation_fixture()");
      }
      const attempt = await admin.query(
        "SELECT reconciliation_state,first_uncertainty_at FROM media_video_transform_attempts WHERE request_id='rollback-task'",
      );
      expect(attempt.rows[0]).toEqual({ reconciliation_state: "none", first_uncertainty_at: null });
      const current = await store.getSubmissionByOperation({ submissionId, operationId });
      expect(current?.eventSequence).toBe(finalized.eventSequence);
      expect(current?.state.reconciliationRequired).toBe(false);
      await expect(
        store.enterAttemptReconciliation({
          submission: finalized.state,
          observedEventSequence: finalized.eventSequence - 1,
          requestId: "rollback-task",
          state: "required",
          observation: { status: "workflow_terminal", observedAt: "2026-09-05T00:00:00Z" },
        }),
      ).rejects.toThrow("video reconciliation fence rejected");
    });
  });
});

suite("video source seal authority", () => {
  test("HEAD verifies the recorded immutable identity without reading the video bytes", async () => {
    await fixture(async (admin, connection) => {
      const { layer, finalized } = await finalizedFixture(connection);
      const seal = (
        await admin.query(
          "SELECT etag,object_version,size_bytes,content_type FROM media_immutable_objects WHERE submission_id=$1",
          [submissionId],
        )
      ).rows[0];
      const valid = {
        etag: seal.etag as string,
        version: seal.object_version as string,
        size: Number(seal.size_bytes),
        httpMetadata: { contentType: seal.content_type as string },
      };
      let current = valid;
      let heads = 0;
      const verify = makeVideoSealedSourceVerifier(layer, async (reference) => {
        heads++;
        expect(reference).toBe(finalized.state.video?.immutableRef ?? "");
        return current;
      });
      await verify(finalized);
      for (const invalid of [
        { ...valid, version: "replacement" },
        { ...valid, etag: "replacement" },
        { ...valid, size: valid.size + 1 },
        { ...valid, httpMetadata: { contentType: "video/quicktime" } },
      ]) {
        current = invalid;
        await expect(verify(finalized)).rejects.toThrow("video sealed source identity mismatch");
      }
      expect(heads).toBe(5);
    });
  });
});

suite("video publication wakeup delivery", () => {
  for (const disposition of [
    "present",
    "terminal",
    "missing",
    "lost-response",
    "superseded",
  ] as const) {
    test(`drill 4 publication wakeup: ${disposition}`, async () => {
      await fixture(async (_admin, connection) => {
        const { layer, store, finalized } = await finalizedFixture(connection);
        const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
        const identity = `video-analysis:${operationId}:v1:c1`;
        const claim = await outbox.claim(identity, "wakeup-fixture");
        if (claim === null) throw new Error("missing claim");
        await outbox.markLaunched(claim, `vaw-${"a".repeat(64)}`);
        const analysis = { ...trustedAnalysis(), mediaSafety: "review_required" as const };
        const decision = decideOriginalAudioVideo({
          state: finalized.state,
          analysis,
          canonicalCaptionSha256: null,
          decidedAt: "2026-09-05T00:00:00Z",
        });
        const held = await store.commitAnalysisDecision({
          submission: finalized.state,
          analysis,
          decision,
          nextState: attachVideoDecision(finalized.state, analysis, decision),
        });
        const approval = {
          submission: held.state,
          actor: { kind: "user" as const, userId: actor },
          expectedCreationRevision: 1,
          action: { kind: "approve" as const, hold: "safety" as const, evidenceRef: null },
          endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
          idempotencyKey: "wakeup-approval",
          requestHash: "8".repeat(64),
          responseBytes,
          responseSha256,
        };
        await store.moderate(approval);
        await store.moderate(approval);
        const wakeups = makeVideoPublicationWakeupStore(layer);
        expect(await wakeups.listPending(10)).toHaveLength(1);
        if (disposition === "superseded") {
          const current = await store.getSubmissionByOperation({ submissionId, operationId });
          if (!current) throw new Error("missing approved submission");
          const failed = await store.recordProcessingFailure({
            submission: current.state,
            observedEventSequence: current.eventSequence,
            failureCode: "publication_failed",
            evidenceRef: "publication:fixture",
          });
          await store.retryTechnical({
            submission: failed.state,
            endpointTemplate: "/media-post-submissions/:submissionId/retry",
            idempotencyKey: "wakeup-retry",
            requestHash: "9".repeat(64),
            responseBytes,
            responseSha256,
          });
          expect(await wakeups.listPending(10)).toHaveLength(2);
        }
        let notifications = 0;
        let lost = disposition === "lost-response";
        const dispatcher = {
          wakeups,
          outbox,
          store,
          launcher: {
            inspect: async () => ({
              state:
                disposition === "terminal" || disposition === "missing"
                  ? disposition
                  : ("present" as const),
              status: "complete",
            }),
            notify: async (_identity: string, _continuation: number, actionId: string) => {
              notifications++;
              expect(actionId).toBe(`video-moderation:${actor}:wakeup-approval`);
              if (lost) {
                lost = false;
                throw new Error("lost notify response");
              }
            },
          },
        };
        const result = await dispatchVideoPublicationWakeups(dispatcher);
        if (disposition === "terminal" || disposition === "missing") {
          expect(result.continued).toBe(1);
          expect((await outbox.get(identity))?.continuation).toBe(1);
          expect((await outbox.get(identity))?.state).toBe("pending");
          expect(notifications).toBe(0);
        } else if (disposition === "superseded") {
          expect(notifications).toBe(0);
          expect((await wakeups.listPending(10))[0]?.effectIdentity).toBe(
            `video-analysis:${operationId}:v1:c2`,
          );
        } else {
          expect(result.failed).toBe(disposition === "lost-response" ? 1 : 0);
          await dispatchVideoPublicationWakeups(dispatcher);
          expect(await wakeups.listPending(10)).toHaveLength(0);
          expect(notifications).toBe(disposition === "lost-response" ? 2 : 1);
        }
      });
    });
  }
  test("a lost start answer replays after the claim, after expiry, and never for another body", async () => {
    await fixture(async (admin, connection) => {
      const { services, body, start, submissions } = await songStartFixture(
        admin,
        connection,
        "seq",
      );
      const first = await start(services());
      expect(await submissions()).toBe(1);
      // The response was lost; the reservation is claimed now.
      expect(await start(services())).toEqual(first);
      // Long after the reservation's deadline, the same start still gets its answer.
      const later: VideoPublicationServices = {
        ...services(),
        nowIso: () => new Date(Date.now() + 86_400_000).toISOString(),
      };
      expect(await start(later)).toEqual(first);
      // The same key with another body, or from another persona, is a conflict.
      await expect(start(services(), { ...body, caption: "changed" })).rejects.toMatchObject({
        _tag: "IdempotencyConflict",
      });
      expect(await submissions()).toBe(1);
    });
  });

  test("a concurrent retry that sees the claimed reservation gets the winner's saved answer", async () => {
    await fixture(async (admin, connection) => {
      const { services, start, submissions, reservationState } = await songStartFixture(
        admin,
        connection,
        "claimed-race",
      );
      const pause = await pauseStartsInsideTheirTransaction(connection);
      const winner = start(services());
      const paused = await pause.waiting();
      expect(paused.join(" ")).toContain("INSERT INTO media_song_video_render_plans");
      // Paused inside its transaction, the winner's submission and claim are
      // both invisible: neither can be seen without the other.
      expect(await reservationState()).toBe("issued");
      expect(await submissions()).toBe(0);
      let replayReads = 0;
      let loserCreates = 0;
      let firstReadDone!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        firstReadDone = resolve;
      });
      let winnerCommitted!: () => void;
      const committed = new Promise<void>((resolve) => {
        winnerCommitted = resolve;
      });
      const base = services();
      const loser = start(
        services({
          replaySubmissionStart: async (input) => {
            replayReads += 1;
            const outcome = await base.store.replaySubmissionStart(input);
            if (replayReads === 1) firstReadDone();
            return outcome;
          },
          // The loser reads the reservation only after the winner committed.
          getReservationForAccount: async (input) => {
            await committed;
            return base.store.getReservationForAccount(input);
          },
          createSubmission: async (input) => {
            loserCreates += 1;
            return base.store.createSubmission(input);
          },
        }),
      );
      // The loser must be parked at the boundary, not finished early.
      await Promise.race([
        firstRead,
        loser.then(
          () => Promise.reject(new Error("the loser finished before its first replay read")),
          (error) => Promise.reject(error),
        ),
      ]).catch(async (error) => {
        await pause.release();
        throw error;
      });
      await pause.release();
      const won = await winner;
      winnerCommitted();
      expect(await loser).toEqual(won);
      expect(replayReads).toBe(2);
      expect(loserCreates).toBe(0);
      expect(await submissions()).toBe(1);
      expect(await reservationState()).toBe("claimed");
    });
  });

  test("a concurrent retry that sees the issued reservation waits and replays the winner's answer", async () => {
    await fixture(async (admin, connection) => {
      const { services, start, submissions, reservationState } = await songStartFixture(
        admin,
        connection,
        "issued-race",
      );
      const pause = await pauseStartsInsideTheirTransaction(connection);
      const winner = start(services());
      expect((await pause.waiting()).join(" ")).toContain(
        "INSERT INTO media_song_video_render_plans",
      );
      const base = services();
      let loserCreates = 0;
      let loserWaiting!: () => void;
      const atStore = new Promise<void>((resolve) => {
        loserWaiting = resolve;
      });
      // The loser reads the reservation while the winner is still uncommitted,
      // sees it issued, and goes on to the store, which serializes the key.
      const loser = start(
        services({
          createSubmission: async (input) => {
            loserCreates += 1;
            loserWaiting();
            return base.store.createSubmission(input);
          },
        }),
      );
      await Promise.race([
        atStore,
        loser.then(
          () => Promise.reject(new Error("the loser finished before reaching the store")),
          (error) => Promise.reject(error),
        ),
      ]).catch(async (error) => {
        await pause.release();
        throw error;
      });
      await pause.release();
      const won = await winner;
      expect(await loser).toEqual(won);
      expect(loserCreates).toBe(1);
      expect(await submissions()).toBe(1);
      expect(await reservationState()).toBe("claimed");
    });
  });
});
