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
const testCount = 7;
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
        analysis,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
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
                new TextEncoder().encode('{"version":"timed-lyrics-v1","segments":[]}'),
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
                new TextEncoder().encode('{"version":"timed-lyrics-v1","segments":[]}'),
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
        expect(
          await run(connection, (store) =>
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
          ),
        ).toMatchObject({ kind: "committed" });
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
  test("parks an outbox effect after the third bounded delivery attempt", async () => {
    await withSchema(async (_admin, connection) => {
      await createThroughDecision(connection);
      for (const attempt of [1, 2, 3] as const) {
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
      expect(
        await run(connection, (_store, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "delivery-worker-4",
            leaseSeconds: 30,
          }),
        ),
      ).toBeNull();
      const parked = await run(connection, (_store, outbox) =>
        outbox.get("media_pg_analysis_outbox"),
      );
      expect(parked).toMatchObject({ state: "exhausted", deliveryAttempts: 3, claimOwner: null });
    });
    completedTestCount += 1;
  }, 40_000);
});
afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
