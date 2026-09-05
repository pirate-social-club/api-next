import { describe, expect, test } from "bun:test";
import type { VideoStageFact } from "@pirate/application/video/stage-facts";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  createVideoSubmission,
  projectVideoSubmission,
  renewVideoUploadParts,
  reserveVideoUpload,
  VIDEO_MULTIPART_PART_SIZE_BYTES,
  type VideoPublicationServices,
} from "../../application/src/video/publication.ts";
import { dispatchVideoPublicationWakeups } from "../../application/src/video/publication-wakeup.ts";
import { recoverVideoWorkflowLaunches } from "../../application/src/video/workflow-recovery.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import { makeControlPlaneContentStore } from "./content-repository.ts";
import { makePostgresDataRegistrationArtifactAuthorityReader } from "./data/registration-artifact-pipeline.ts";
import { makeDataRegistrationStore } from "./data-registration-repository.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeVideoPublicationAuthorization } from "./video-access-authorization.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "./video-analysis-outbox-repository.ts";
import {
  actor,
  audioSha256,
  community,
  finalizedFixture,
  operationId,
  persona,
  responseBytes,
  responseSha256,
  seedVideoActors,
  submissionId,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";
import { makeVideoPublicationWakeupStore } from "./video-publication-wakeup-repository.ts";
import { makeVideoSealedSourceVerifier } from "./video-sealed-source-verifier.ts";
import { makeControlPlaneVideoStageFactStore } from "./video-stage-fact-repository.ts";

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

suite("video publication PostgreSQL", () => {
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
                artifactRef: soundtrack.extractedAudioRef,
                canonicalSha256: soundtrack.extractedAudioSha256,
                sourceSha256: videoSha256,
                videoRevision: 1,
                mediaType: "audio/mp4",
                policyRevision: soundtrack.policyRevision,
                adapterRevision: "qencode-v1",
              },
              artifacts: [
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
      await admin.query(
        "UPDATE posts SET visibility='public',content_rating='adult_18' WHERE post_id=$1",
        ["post-video-publication"],
      );
      expect(await access()).toBe(false);
      await admin.query(
        "UPDATE posts SET content_rating='general',status='hidden' WHERE post_id=$1",
        ["post-video-publication"],
      );
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
      expect(projection).toMatchObject({ retryable: false });
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
});
