import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations";
import type {
  PublicationDecision,
  SongTerms,
  TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import { makeControlPlaneMediaOutboxRepository } from "./media-outbox-repository";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_MEDIA_PERSISTENCE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-media-persistence-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-media-persistence-suite-complete\n";
const testCount = 12;
let completedTestCount = 0;
const actor = "media_pg_actor",
  moderator = "media_pg_moderator",
  community = "media_pg_community",
  operation = "media_pg_operation",
  submission = "media_pg_submission",
  reservation = "media_pg_reservation";
const responseBytes = new TextEncoder().encode('{"status":"accepted"}');
const audioBytes = new TextEncoder().encode("media-fixture-audio");
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const responseSha256 = sha256(responseBytes),
  audioSha256 = sha256(audioBytes),
  requestHash = "a".repeat(64);
const terms: SongTerms = {
  licensePreset: "non-commercial",
  commercialRemixShareBps: 0,
  royaltyAllocations: [{ recipientId: actor, shareBps: 10_000 }],
  accessMode: "public",
};
const analysis: TrustedSongAnalysis = {
  version: "song-trusted-analysis-v1",
  operationId: operation,
  analysisRevision: 1,
  audioRevision: 1,
  canonicalAudioSha256: audioSha256,
  finalizedAudioRef: "media_pg_immutable",
  probeEvidenceRef: "probe_evidence_1",
  embeddedMetadata: {
    evidenceRef: "metadata_evidence_1",
    adapterRevision: "metadata_adapter_1",
    trackTitle: null,
    cover: { status: "absent", reasonCode: "not_embedded" },
  },
  speechLyrics: {
    status: "no_speech",
    explicitness: "no_lyrics",
    evidenceRef: "speech_evidence_1",
    policyRevision: "speech_policy_1",
    adapterRevision: "speech_adapter_1",
  },
  acr: {
    decision: "allow",
    evidenceRef: "acr_evidence_1",
    policyRevision: "acr_policy_1",
    adapterRevision: "acr_adapter_1",
  },
  mediaSafety: "allow",
  lyricsSafety: "skipped",
  boundReference: null,
};
const decision: PublicationDecision = {
  decisionRevision: 1,
  outcome: "allow",
  creationRevision: 2,
  audioRevision: 1,
  analysisRevision: 1,
  canonicalAudioSha256: audioSha256,
  policyRevision: "publication_policy_1",
  evidenceRef: "publication_evidence_1",
};
const reviewDecision: PublicationDecision = { ...decision, outcome: "manual_review" };
function schemaName(): string {
  return `api_next_media_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scopedConnection(raw: string, schema: string): string {
  return `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function seedHnsState(admin: Client): Promise<void> {
  const config = new TextEncoder().encode('{"fixture":"hns"}');
  const configDigest = sha256(config);
  const request = new TextEncoder().encode('{"observation":"media"}');
  await admin.query(
    "INSERT INTO hns_control_observer_configurations (provider_configuration_reference,provider_configuration_version,provider_configuration_digest,configuration_bytes) VALUES ($1,$2,$3,$4)",
    ["media-hns-fixture", "v1", configDigest, config],
  );
  await admin.query(
    "INSERT INTO hns_control_observer_operations (observation_id,provider_configuration_reference,provider_configuration_version,provider_configuration_digest,request_bytes,request_sha256,configuration_bytes,snapshot_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)",
    [
      "media-hns-operation",
      "media-hns-fixture",
      "v1",
      configDigest,
      request,
      sha256(request),
      config,
    ],
  );
  const now = new Date();
  const lease = new Date(now.getTime() + 10_000);
  await admin.query(
    "INSERT INTO hns_control_observer_reservations (observation_id,state,reservation_lease_seconds,observer_fence,reservation_database_time,lease_expires_at,created_at,updated_at) VALUES ($1,'reserved',10,1,$2,$3,$2,$2)",
    ["media-hns-operation", now, lease],
  );
}
async function withSchema<A>(
  use: (client: Client, connection: string) => Promise<A>,
  populated = true,
): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const connection = scopedConnection(connectionString, schema);
  try {
    const migrations = await loadPostgresMigrations();
    const media = migrations.filter(({ version }) => version === "0043_song_media_submission.sql");
    expect(media).toHaveLength(1);
    const foundation = migrations.filter(
      ({ version }) => version !== "0043_song_media_submission.sql",
    );
    await runPostgresMigrations({ connectionString: connection, migrations: foundation });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    if (populated) {
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [moderator]);
      await admin.query(
        "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'Media fixture','active',$2,now(),now())",
        [community, actor],
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'media_pg_membership',$2,'member',now(),now(),now())",
        [community, actor],
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES ($1,'media_pg_moderator_membership',$2,'member',now(),now(),now())",
        [community, moderator],
      );
      await seedHnsState(admin);
    }
    const before = await admin.query<{ media_table: string | null; hns_operations: string }>({
      text: "SELECT to_regclass('media_post_submissions')::text AS media_table,(SELECT count(*)::text FROM hns_control_observer_operations) AS hns_operations",
    });
    expect(before.rows[0]?.media_table).toBeNull();
    if (populated) expect(before.rows[0]?.hns_operations).toBe("1");
    await runPostgresMigrations({ connectionString: connection, migrations });
    return await use(admin, connection);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}
function run<A>(
  connection: string,
  program: (
    submissionStore: ReturnType<typeof makeControlPlaneMediaSubmissionRepository>,
    outboxStore: ReturnType<typeof makeControlPlaneMediaOutboxRepository>,
  ) => Effect.Effect<A, unknown, ControlPlaneDb>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  return Effect.runPromise(
    Effect.scoped(
      program(
        makeControlPlaneMediaSubmissionRepository(),
        makeControlPlaneMediaOutboxRepository(),
      ).pipe(Effect.provide(layer)),
    ),
  );
}
const command = (endpointTemplate: string, idempotencyKey: string) => ({
  communityId: community,
  submissionId: submission,
  actorUserId: actor,
  endpointTemplate,
  idempotencyKey,
  requestHash,
  responseBytes,
  responseSha256,
});
async function createThroughDecision(
  connection: string,
  selectedDecision: PublicationDecision = decision,
  selectedAnalysis: TrustedSongAnalysis = analysis,
  skipDecision = false,
): Promise<void> {
  expect(
    await run(connection, (store) =>
      store.reserve({
        communityId: community,
        actorUserId: actor,
        idempotencyKey: "reserve-key",
        requestHash,
        expectedContentType: "audio/mpeg",
        expectedSizeBytes: audioBytes.byteLength,
        expectedSha256: audioSha256,
        uploadUrl: "https://upload.test/media",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        responseBytes,
        responseSha256,
        reservationId: reservation,
      }),
    ),
  ).toMatchObject({ kind: "created" });
  expect(
    await run(connection, (store) =>
      store.createSubmission({
        communityId: community,
        actorUserId: actor,
        idempotencyKey: "create-key",
        requestHash,
        title: "Fixture song",
        songType: "original",
        reservationId: reservation,
        submissionId: submission,
        operationId: operation,
        responseBytes,
        responseSha256,
      }),
    ),
  ).toMatchObject({ kind: "created" });
  expect(
    await run(connection, (store) =>
      store.bindTerms({
        ...command("/media-post-submissions/:submissionId/terms", "terms-key"),
        expectedCreationRevision: 1,
        terms,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  expect(
    await run(connection, (store) =>
      store.finalizeSealed({
        ...command("/media-post-submissions/:submissionId/finalize", "finalize-key"),
        expectedCreationRevision: 2,
        expectedAudioRevision: 0,
        reservationId: reservation,
        immutableObject: {
          immutableRef: analysis.finalizedAudioRef,
          destinationRef: "media://immutable/fixture",
          etag: "etag-1",
          objectVersion: "version-1",
          sizeBytes: audioBytes.byteLength,
          contentType: "audio/mpeg",
          canonicalSha256: audioSha256,
        },
        outbox: {
          outboxEventId: "media_pg_analysis_outbox",
          effectIdentity: "media_pg_analysis_effect",
          payload: {
            kind: "analysis_launch",
            submission_id: submission,
            operation_id: operation,
            audio_revision: 1,
            analysis_revision: 0,
            workflow_revision: 1,
            workflow_instance_id: `media-${operation}-r1`,
          },
        },
      }),
    ),
  ).toMatchObject({ kind: "committed" });
  expect(
    await run(connection, (store) =>
      store.acceptAnalysis({
        ...command("/media-post-submissions/:submissionId/analysis", "analysis-key"),
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: audioSha256,
        analysis: selectedAnalysis,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
  if (skipDecision) return;
  expect(
    await run(connection, (store) =>
      store.recordDecision({
        ...command("/media-post-submissions/:submissionId/decision", "decision-key"),
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        decision: selectedDecision,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
}

suite("song media persistence PostgreSQL 17 race suite", () => {
  test("applies 0043 over populated 0042 and atomically publishes owned lineage", async () => {
    await withSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      const decoded = await run(connection, (store) =>
        store.getForAuthor({
          communityId: community,
          submissionId: submission,
          actorUserId: actor,
        }),
      );
      expect(decoded).toMatchObject({
        creationRevision: 2,
        audioRevision: 1,
        analysisRevision: 1,
        decisionRevision: 1,
        workflowRevision: 1,
        status: "processing",
        phase: "publish",
      });
      const postId = `media-post-${operation}`;
      expect(
        await run(connection, (store) =>
          store.publish({
            ...command("/media-post-submissions/:submissionId/publish", "publish-key"),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            expectedDecisionRevision: 1,
            postId,
            outbox: {
              outboxEventId: "media_pg_publication_outbox",
              effectIdentity: "media_pg_publication_effect",
              payload: {
                kind: "publication",
                submission_id: submission,
                operation_id: operation,
                post_id: postId,
                workflow_revision: 2,
                workflow_instance_id: `media-${operation}-r2`,
              },
            },
          }),
        ),
      ).toMatchObject({ kind: "committed", postId });
      expect(
        await run(connection, (store) =>
          store.recordAlignment({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            postId,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioSha256,
            outcome: "ready",
            artifact: {
              artifactRef: "media_pg_timed_lyrics",
              artifactSha256: sha256(
                new TextEncoder().encode('{"version": "timed-lyrics-v1", "segments": []}'),
              ),
              artifact: { version: "timed-lyrics-v1", segments: [] },
            },
          }),
        ),
      ).toBeUndefined();
      expect(
        await run(connection, (store) =>
          store.recordAlignment({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            postId,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioSha256,
            outcome: "ready",
            artifact: {
              artifactRef: "media_pg_timed_lyrics_v2",
              artifactRevision: 2,
              artifactSha256: sha256(
                new TextEncoder().encode('{"version": "timed-lyrics-v1", "segments": []}'),
              ),
              artifact: { version: "timed-lyrics-v1", segments: [] },
            },
          }),
        ),
      ).toBeUndefined();
      expect(
        await run(connection, (store) =>
          store.recordAlignment({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            postId,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioSha256,
            outcome: "unavailable",
            failureCode: "alignment_failed",
          }),
        ),
      ).toBeUndefined();
      const counts = await admin.query<{
        events: string;
        effects: string;
        publications: string;
        alignment: string;
        hns: string;
      }>({
        text: "SELECT (SELECT count(*)::text FROM media_submission_events WHERE submission_id=$1) AS events,(SELECT count(*)::text FROM media_submission_outbox WHERE submission_id=$1) AS effects,(SELECT count(*)::text FROM media_publication_projections WHERE submission_id=$1) AS publications,(SELECT alignment FROM media_publication_projections WHERE submission_id=$1) AS alignment,(SELECT count(*)::text FROM hns_control_observer_operations) AS hns",
        values: [submission],
      });
      expect(counts.rows[0]).toEqual({
        events: "6",
        effects: "2",
        publications: "1",
        alignment: "unavailable",
        hns: "1",
      });
      expect(
        (
          await admin.query(
            "SELECT status,post_id FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ status: "published", post_id: postId });
    });
    completedTestCount += 1;
  }, 40_000);
  test("applies 0043 over an empty foundation", async () => {
    await withSchema(async (admin) => {
      expect(
        (await admin.query("SELECT count(*)::text AS count FROM media_post_submissions")).rows[0]
          ?.count,
      ).toBe("0");
    }, false);
    completedTestCount += 1;
  }, 40_000);
  test("reclaims an expired outbox lease and rejects the stale fence", async () => {
    await withSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      expect(
        await run(connection, (store) =>
          store.recordProcessingAttempt({
            attemptId: "media_pg_attempt",
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            operationId: operation,
            audioRevision: 1,
            analysisRevision: 1,
            stage: "probe",
            inputKind: "audio",
            inputRevision: 1,
            policyRevision: "probe-policy-1",
            adapterRevision: "probe-adapter-1",
            inputHash: "c".repeat(64),
          }),
        ),
      ).toBeUndefined();
      expect(
        await run(connection, (store) =>
          store.claimProcessingAttempt({
            attemptId: "media_pg_attempt",
            workerId: "attempt_worker",
            leaseSeconds: 30,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.failProcessingAttempt({
            attemptId: "media_pg_attempt",
            workerId: "attempt_worker",
            claimFence: 1,
            failureCode: "probe_failed",
            retryable: true,
            nextEligibleAt: new Date(Date.now() + 1_000).toISOString(),
          }),
        ),
      ).toBe(true);
      const first = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "worker_a",
          leaseSeconds: 1,
        }),
      );
      expect(first).toMatchObject({ state: "running", claimOwner: "worker_a", claimFence: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "worker_b",
          leaseSeconds: 30,
        }),
      );
      expect(second).toMatchObject({ state: "running", claimOwner: "worker_b", claimFence: 2 });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "worker_a",
            claimFence: 1,
          }),
        ),
      ).toBe(false);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "worker_b",
            claimFence: 2,
          }),
        ),
      ).toBe(true);
    });
    completedTestCount += 1;
  }, 40_000);
  test("derives moderator authority and persists an approval decision path", async () => {
    await withSchema(async (_admin, connection) => {
      await createThroughDecision(connection, reviewDecision);
      expect(
        await run(connection, (store) =>
          store.moderate({
            ...command("/media-post-submissions/:submissionId/moderate", "moderate-key"),
            expectedCreationRevision: 2,
            action: "approve",
            actor: { userId: moderator, kind: "admin", scopes: ["moderation"] },
            approval: {
              actionId: "moderator-action",
              moderatorActorId: actor,
              evidenceRef: "moderator-evidence",
              approvalKind: "standard",
              reasonCode: null,
              heldRevision: 2,
            },
            decision: { ...decision, decisionRevision: 2 },
          }),
        ),
      ).toEqual({ kind: "committed", submissionId: submission });
      const state = await run(connection, (store) =>
        store.getForAuthor({
          communityId: community,
          submissionId: submission,
          actorUserId: actor,
        }),
      );
      expect(state).toMatchObject({ status: "processing", phase: "publish", decisionRevision: 2 });
      const persisted = await _admin.query(
        "SELECT moderator_actor_id,decision_revision FROM media_moderation_projections WHERE submission_id=$1",
        [submission],
      );
      expect(persisted.rows[0]).toEqual({ moderator_actor_id: moderator, decision_revision: "2" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("records bounded typed failure retries and exact abandonment reasons", async () => {
    await withSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      for (const retryCount of [0, 1, 2] as const) {
        const failureResult = await run(connection, (store) =>
          store.recordMediaFailure({
            ...command("/media-post-submissions/:submissionId/failure", `failure-${retryCount}`),
            expectedCreationRevision: retryCount + 2,
            failure: {
              code: "probe_failed",
              retryable: true,
              retryCount,
              lastSafePhase: "analysis",
            },
          }),
        );
        expect(failureResult).toMatchObject({ kind: "committed" });
        expect(
          await run(connection, (store) =>
            store.retry({
              ...command("/media-post-submissions/:submissionId/retry", `retry-${retryCount}`),
              expectedCreationRevision: retryCount + 2,
            }),
          ),
        ).toMatchObject({ kind: "committed" });
      }
      expect(
        await run(connection, (store) =>
          store.recordMediaFailure({
            ...command("/media-post-submissions/:submissionId/failure", "failure-fourth"),
            expectedCreationRevision: 5,
            failure: {
              code: "probe_failed",
              retryable: true,
              retryCount: 3,
              lastSafePhase: "analysis",
            },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await expect(
        run(connection, (store) =>
          store.retry({
            ...command("/media-post-submissions/:submissionId/retry", "retry-fourth"),
            expectedCreationRevision: 5,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "MediaSubmissionRepositoryError",
        reason: "transition-rejected",
      });
      const events = await admin.query<{ event_kind: string }>(
        "SELECT event_kind FROM media_submission_events WHERE submission_id=$1 ORDER BY event_sequence",
        [submission],
      );
      expect(events.rows.map((row) => row.event_kind)).toContain("media_failure_recorded");
      expect(events.rows.map((row) => row.event_kind)).toContain("retry_authorized");
    });
    completedTestCount += 1;
  }, 40_000);
  test("persists author cancellation with typed retention", async () => {
    await withSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            idempotencyKey: "cancel-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            idempotencyKey: "cancel-create",
            requestHash,
            title: "Fixture song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.authorCancel({
            ...command("/media-post-submissions/:submissionId/cancel", "cancel-key"),
            expectedCreationRevision: 1,
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT status,abandonment_reason,retention_disposition FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "abandoned",
        abandonment_reason: "author_cancelled",
        retention_disposition: "no_object",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("persists upload expectation mismatch with its typed event and retention", async () => {
    await withSchema(async (admin, connection) => {
      expect(
        await run(connection, (store) =>
          store.reserve({
            communityId: community,
            actorUserId: actor,
            idempotencyKey: "mismatch-reserve",
            requestHash,
            expectedContentType: "audio/mpeg",
            expectedSizeBytes: audioBytes.byteLength,
            expectedSha256: audioSha256,
            uploadUrl: "https://upload.test/media",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            responseBytes,
            responseSha256,
            reservationId: reservation,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.createSubmission({
            communityId: community,
            actorUserId: actor,
            idempotencyKey: "mismatch-create",
            requestHash,
            title: "Fixture song",
            songType: "original",
            reservationId: reservation,
            submissionId: submission,
            operationId: operation,
            responseBytes,
            responseSha256,
          }),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        await run(connection, (store) =>
          store.uploadExpectationMismatch({
            ...command("/media-post-submissions/:submissionId/upload-mismatch", "mismatch-key"),
            expectedCreationRevision: 1,
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        (
          await admin.query(
            "SELECT status,abandonment_reason,retention_disposition FROM media_post_submissions WHERE submission_id=$1",
            [submission],
          )
        ).rows[0],
      ).toEqual({
        status: "abandoned",
        abandonment_reason: "upload_expectation_mismatch",
        retention_disposition: "retain_for_reconciliation",
      });
      expect(
        (
          await admin.query(
            "SELECT event_kind FROM media_submission_events WHERE submission_id=$1 ORDER BY event_sequence DESC LIMIT 1",
            [submission],
          )
        ).rows[0],
      ).toEqual({ event_kind: "upload_expectation_mismatch_recorded" });
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects forged ordinary exhaustion and pointer mutation at SQL transition fences", async () => {
    await withSchema(async (_schemaAdmin, connection) => {
      const admin = new Client({ connectionString: connection });
      await admin.connect();
      await createThroughDecision(connection, reviewDecision);
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET review_exhaustion_code='acr_exhausted',review_exhaustion_attempt_id='forged',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET current_immutable_ref='forged-pointer',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.end();
    });
    completedTestCount += 1;
  }, 40_000);
  test("rejects hostile SQL state, snapshot, payload, replay, audio, and transcript lineage", async () => {
    await withSchema(async (_schemaAdmin, connection) => {
      const admin = new Client({ connectionString: connection });
      await admin.connect();
      await createThroughDecision(connection, decision, analysis, true);
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot) VALUES ($1,$2,$3,$4,3,'non-commercial',0,$5::jsonb,'public',$6::jsonb)",
        [
          submission,
          community,
          actor,
          operation,
          JSON.stringify(terms.royaltyAllocations),
          JSON.stringify(terms),
        ],
      );
      await admin.query(
        "UPDATE media_post_submissions SET creation_revision=3,current_terms_revision=3,decision_revision=0,current_decision_revision=NULL,status='processing',phase='analysis',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
        [submission],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET analysis_revision=2,current_analysis_revision=2,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-workflow',$1,$2,$3,$4,2,1,0,999,$5,'analysis_launch','hostile-workflow-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r999`,
            JSON.stringify({
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: operation,
              audio_revision: 1,
              analysis_revision: 0,
              workflow_revision: 999,
              workflow_instance_id: `media-${operation}-r999`,
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot) VALUES ($1,$2,$3,$4,3,'non-commercial',0,$5::jsonb,'public',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            JSON.stringify(terms.royaltyAllocations),
            JSON.stringify({ ...terms, licensePreset: "commercial-use" }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_publication_decisions (submission_id,community_id,actor_user_id,operation_id,decision_revision,creation_revision,audio_revision,analysis_revision,canonical_audio_sha256,outcome,policy_revision,evidence_ref,decision_snapshot) VALUES ($1,$2,$3,$4,2,2,1,1,$5,'allow','publication_policy_2','publication_evidence_2',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            audioSha256,
            JSON.stringify({ ...decision, decisionRevision: 2, outcome: "block" }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ('hostile-payload',$1,$2,$3,$4,2,1,0,1,$5,'analysis_launch','hostile-effect',$6::jsonb)",
          [
            submission,
            community,
            actor,
            operation,
            `media-${operation}-r1`,
            JSON.stringify({
              kind: "analysis_launch",
              submission_id: submission,
              operation_id: "different-operation",
              audio_revision: 1,
              analysis_revision: 0,
              workflow_revision: 1,
              workflow_instance_id: `media-${operation}-r1`,
            }),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_submission_command_replays (community_id,actor_user_id,endpoint_template,idempotency_key,request_hash,submission_id,operation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            community,
            moderator,
            "/media-post-submissions/:submissionId/replay-hostile",
            "cross-actor",
            requestHash,
            submission,
            operation,
            responseBytes,
            responseSha256,
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await expect(
        admin.query(
          "INSERT INTO media_audio_revisions (submission_id,community_id,actor_user_id,operation_id,audio_revision,immutable_ref,canonical_sha256,content_type,size_bytes) VALUES ($1,$2,$3,$4,2,$5,$6,'audio/wav',$7)",
          [
            submission,
            community,
            actor,
            operation,
            analysis.finalizedAudioRef,
            audioSha256,
            audioBytes.byteLength + 1,
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      const aggregateSegments = Array.from({ length: 50 }, (_, index) => ({
        start_ms: index,
        end_ms: index + 1,
        text: "x".repeat(4096),
      }));
      await expect(
        admin.query(
          "INSERT INTO media_transcript_artifacts (transcript_artifact_ref,community_id,actor_user_id,submission_id,operation_id,audio_revision,analysis_revision,canonical_audio_sha256,transcript_sha256,transcript_text,segments) VALUES ('hostile-transcript',$1,$2,$3,$4,1,1,$5,$6,'',$7::jsonb)",
          [
            community,
            actor,
            submission,
            operation,
            audioSha256,
            sha256(new TextEncoder().encode("")),
            JSON.stringify(aggregateSegments),
          ],
        ),
      ).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.end();
    });
    completedTestCount += 1;
  }, 40_000);
  test("requires durable exhaustion evidence for ACR override moderation", async () => {
    await withSchema(async (admin, connection) => {
      await createThroughDecision(
        connection,
        decision,
        {
          ...analysis,
          acr: { ...analysis.acr, decision: "inconclusive" },
        },
        true,
      );
      expect(
        await run(connection, (store) =>
          store.recordProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            operationId: operation,
            audioRevision: 1,
            analysisRevision: 1,
            stage: "acr",
            inputKind: "audio",
            inputRevision: 1,
            policyRevision: "acr-policy-1",
            adapterRevision: "acr-adapter-1",
            inputHash: audioSha256,
            attemptNumber: 3,
          }),
        ),
      ).toBeUndefined();
      expect(
        await run(connection, (store) =>
          store.claimProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            workerId: "acr-worker",
            leaseSeconds: 30,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.failProcessingAttempt({
            attemptId: "media_pg_acr_attempt_3",
            workerId: "acr-worker",
            claimFence: 1,
            failureCode: "provider_invalid",
            retryable: false,
            evidenceRef: "review-acr-exhausted-evidence",
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (store) =>
          store.requireReview({
            ...command("/media-post-submissions/:submissionId/review", "acr-exhaustion-key"),
            expectedCreationRevision: 2,
            review: {
              reviewRef: "review-acr-exhausted-case",
              heldRevision: 2,
              reasonCode: "review_required",
              exhaustionCode: "acr_exhausted",
              exhaustionAttemptId: "media_pg_acr_attempt_3",
            },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      await expect(
        admin.query(
          "UPDATE media_post_submissions SET status='processing',phase='publish',moderator_action_id='forged',moderator_actor_id=$2,moderator_evidence_ref='forged',decision_revision=1,current_decision_revision=1,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
          [submission, moderator],
        ),
      ).rejects.toThrow();
      expect(
        await run(connection, (store) =>
          store.moderate({
            ...command("/media-post-submissions/:submissionId/moderate", "acr-moderate-key"),
            expectedCreationRevision: 2,
            action: "approve",
            actor: { userId: moderator, kind: "admin", scopes: ["moderation"] },
            approval: {
              actionId: "acr-override-action",
              moderatorActorId: actor,
              evidenceRef: "acr-override-evidence",
              approvalKind: "acr_override",
              reasonCode: "acr_exhausted",
              heldRevision: 2,
            },
            decision: { ...decision, decisionRevision: 1 },
          }),
        ),
      ).toMatchObject({ kind: "committed" });
      const persisted = await admin.query(
        "SELECT action_kind,authority_actor_user_id,reason_code,held_revision FROM media_moderation_actions WHERE action_id=$1",
        ["acr-override-action"],
      );
      expect(persisted.rows[0]).toEqual({
        action_kind: "approve",
        authority_actor_user_id: moderator,
        reason_code: "acr_exhausted",
        held_revision: "2",
      });
    });
    completedTestCount += 1;
  }, 40_000);
  test("reclaims a crashed third outbox delivery without changing workflow identity", async () => {
    await withSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      for (const attempt of [1, 2] as const) {
        const claimed = await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: `delivery-worker-${attempt}`,
            leaseSeconds: 30,
          }),
        );
        expect(claimed).toMatchObject({
          state: "running",
          claimFence: attempt,
          deliveryAttempts: attempt,
        });
        expect(
          await run(connection, (_store, outbox) =>
            outbox.markFailed({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workflowInstanceId: `media-${operation}-r1`,
              workerId: `delivery-worker-${attempt}`,
              claimFence: attempt,
              failureCode: "provider_unavailable",
              nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
            }),
          ),
        ).toBe(true);
      }
      const third = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "delivery-worker-3",
          leaseSeconds: 1,
        }),
      );
      expect(third).toMatchObject({ state: "running", claimFence: 3, deliveryAttempts: 3 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const reclaimed = await run(connection, (_store, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "delivery-worker-4",
          leaseSeconds: 30,
        }),
      );
      expect(reclaimed).toMatchObject({
        state: "running",
        claimFence: 4,
        deliveryAttempts: 3,
        workflowInstanceId: `media-${operation}-r1`,
      });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "delivery-worker-3",
            claimFence: 3,
          }),
        ),
      ).toBe(false);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markDelivered({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "delivery-worker-4",
            claimFence: 4,
          }),
        ),
      ).toBe(true);
    });
    completedTestCount += 1;
  }, 40_000);
  test("parks a completed third outbox failure without a fourth claim", async () => {
    await withSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      for (const attempt of [1, 2] as const) {
        expect(
          await run(connection, (_store, outbox) =>
            outbox.claim({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workerId: `parking-worker-${attempt}`,
              leaseSeconds: 30,
            }),
          ),
        ).toMatchObject({ deliveryAttempts: attempt });
        expect(
          await run(connection, (_store, outbox) =>
            outbox.markFailed({
              outboxEventId: "media_pg_analysis_outbox",
              workflowRevision: 1,
              workflowInstanceId: `media-${operation}-r1`,
              workerId: `parking-worker-${attempt}`,
              claimFence: attempt,
              failureCode: "provider_unavailable",
              nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
            }),
          ),
        ).toBe(true);
      }
      expect(
        await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "parking-worker-3",
            leaseSeconds: 30,
          }),
        ),
      ).toMatchObject({ deliveryAttempts: 3 });
      expect(
        await run(connection, (_store, outbox) =>
          outbox.markFailed({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workflowInstanceId: `media-${operation}-r1`,
            workerId: "parking-worker-3",
            claimFence: 3,
            failureCode: "provider_invalid",
            nextEligibleAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "parking-worker-4",
            leaseSeconds: 30,
          }),
        ),
      ).toBeNull();
    });
    completedTestCount += 1;
  }, 40_000);
});
afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
