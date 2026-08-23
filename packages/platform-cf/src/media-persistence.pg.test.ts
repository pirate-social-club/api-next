import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import type { PublicationDecision, SongTerms, TrustedSongAnalysis } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";

import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations";
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
const testCount = 3;
let completedTestCount = 0;

const actor = "media_pg_actor";
const community = "media_pg_community";
const operation = "media_pg_operation";
const submission = "media_pg_submission";
const reservation = "media_pg_reservation";
const post = "media_pg_post";
const responseBytes = new TextEncoder().encode('{"status":"accepted"}');
const otherResponseBytes = new TextEncoder().encode('{"status":"other"}');
const audioBytes = new TextEncoder().encode("x");
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const responseSha256 = sha256(responseBytes);
const audioSha256 = sha256(audioBytes);
const requestHash = "a".repeat(64);

const terms: SongTerms = {
  licensePreset: "non-commercial",
  commercialRemixShareBps: 0,
  royaltyAllocations: [{ recipientId: actor, shareBps: 10_000 }],
  accessMode: "public",
};
const analysis: TrustedSongAnalysis = {
  analysisRevision: 1,
  audioRevision: 1,
  canonicalAudioSha256: audioSha256,
  finalizedAudioRef: "media_pg_immutable",
  probeEvidenceRef: "probe_evidence_1",
  embeddedMetadataEvidenceRef: "metadata_evidence_1",
  embeddedTitle: null,
  cover: { status: "absent", reasonCode: "not_embedded" },
  speech: {
    status: "no_speech",
    explicitness: "no_lyrics",
    evidenceRef: "speech_evidence_1",
    policyRevision: "speech_policy_1",
    adapterRevision: "speech_adapter_1",
  },
  acrDecision: "allow",
  acrEvidenceRef: "acr_evidence_1",
  acrPolicyRevision: "acr_policy_1",
  acrAdapterRevision: "acr_adapter_1",
  mediaSafety: "allow",
  lyricsSafety: "skipped",
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

function schemaName(): string {
  return `api_next_media_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (client: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const connection = scopedConnection(connectionString, schema);
  try {
    const migrations = await loadPostgresMigrations();
    const foundation = migrations.filter(
      ({ version }) => version !== "0043_song_media_submission.sql",
    );
    expect(
      migrations.filter(({ version }) => version === "0043_song_media_submission.sql"),
    ).toHaveLength(1);
    await runPostgresMigrations({ connectionString: connection, migrations: foundation });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
    await admin.query(
      `INSERT INTO communities (
         community_id, display_name, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, 'Media fixture', 'active', $2, now(), now())`,
      [community, actor],
    );
    await admin.query(
      `INSERT INTO community_memberships (
         community_id, membership_id, user_id, status, joined_at, created_at, updated_at
       ) VALUES ($1, 'media_pg_membership', $2, 'member', now(), now(), now())`,
      [community, actor],
    );
    const before = await admin.query<{ communities: string; media_table: string | null }>({
      text: `SELECT (SELECT count(*)::text FROM communities) AS communities,
                    to_regclass('media_post_submissions')::text AS media_table`,
    });
    expect(before.rows[0]).toEqual({ communities: "1", media_table: null });
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
  const submissionStore = makeControlPlaneMediaSubmissionRepository();
  const outboxStore = makeControlPlaneMediaOutboxRepository();
  return Effect.runPromise(
    Effect.scoped(program(submissionStore, outboxStore).pipe(Effect.provide(layer))),
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

async function createThroughDecision(connection: string): Promise<void> {
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
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        responseBytes,
        responseSha256,
        reservationId: reservation,
      }),
    ),
  ).toMatchObject({ kind: "created", reservationId: reservation });
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
  ).toMatchObject({ kind: "created", submissionId: submission, operationId: operation });
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
          payload: { submission_id: submission },
        },
      }),
    ),
  ).toMatchObject({
    kind: "committed",
    submissionId: submission,
    immutableRef: analysis.finalizedAudioRef,
  });
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
        decision,
      }),
    ),
  ).toEqual({ kind: "committed", submissionId: submission });
}

suite("song media persistence PostgreSQL 17 race suite", () => {
  test("applies 0043 over populated 0042 and fences the full create-to-publish lineage", async () => {
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
        status: "ready_to_publish",
      });
      expect(typeof decoded?.creationRevision).toBe("number");

      const replay = await run(connection, (store) =>
        store.finalizeSealed({
          ...command("/media-post-submissions/:submissionId/finalize", "finalize-key"),
          responseBytes: otherResponseBytes,
          responseSha256: sha256(otherResponseBytes),
          expectedCreationRevision: 2,
          expectedAudioRevision: 0,
          reservationId: reservation,
          immutableObject: {
            immutableRef: analysis.finalizedAudioRef,
            destinationRef: "media://immutable/fixture",
            etag: "etag-1",
            objectVersion: "version-1",
            sizeBytes: 1,
            contentType: "audio/mpeg",
            canonicalSha256: audioSha256,
          },
          outbox: {
            outboxEventId: "media_pg_analysis_outbox",
            effectIdentity: "media_pg_analysis_effect",
            payload: { submission_id: submission },
          },
        }),
      );
      expect(replay).toMatchObject({
        kind: "replay",
        submissionId: submission,
        bytes: responseBytes,
        sha256: responseSha256,
      });
      const conflict = await run(connection, (store) =>
        store.finalizeSealed({
          ...command("/media-post-submissions/:submissionId/finalize", "finalize-key"),
          requestHash: "b".repeat(64),
          expectedCreationRevision: 2,
          expectedAudioRevision: 0,
          reservationId: reservation,
          immutableObject: {
            immutableRef: analysis.finalizedAudioRef,
            destinationRef: "media://immutable/fixture",
            etag: "etag-1",
            objectVersion: "version-1",
            sizeBytes: 1,
            contentType: "audio/mpeg",
            canonicalSha256: audioSha256,
          },
          outbox: {
            outboxEventId: "media_pg_analysis_outbox",
            effectIdentity: "media_pg_analysis_effect",
            payload: { submission_id: submission },
          },
        }),
      );
      expect(conflict).toEqual({ kind: "conflict", submissionId: submission });

      const staleAnalysis = await run(connection, (store) =>
        store
          .acceptAnalysis({
            ...command("/media-post-submissions/:submissionId/analysis", "stale-analysis-key"),
            expectedAudioRevision: 1,
            expectedCanonicalAudioSha256: "f".repeat(64),
            analysis,
          })
          .pipe(Effect.flip),
      );
      expect(staleAnalysis).toMatchObject({ reason: "transition-rejected" });

      await admin.query(
        `UPDATE community_memberships
            SET status = 'left', left_at = now(), updated_at = clock_timestamp()
          WHERE community_id = $1 AND user_id = $2`,
        [community, actor],
      );
      const inactive = await run(connection, (store) =>
        store
          .publish({
            ...command("/media-post-submissions/:submissionId/publish", "publish-key"),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            expectedDecisionRevision: 1,
            postId: post,
            outbox: {
              outboxEventId: "media_pg_publication_outbox",
              effectIdentity: "media_pg_publication_effect",
              payload: { post_id: post },
            },
          })
          .pipe(Effect.flip),
      );
      expect(inactive).toMatchObject({ reason: "transition-rejected" });
      await admin.query(
        `UPDATE community_memberships
            SET status = 'member', left_at = NULL, updated_at = clock_timestamp()
          WHERE community_id = $1 AND user_id = $2`,
        [community, actor],
      );
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, post_type, status, visibility,
           title, created_at, updated_at
         ) VALUES ($1, $2, $3, 'song', 'published', 'public', 'Fixture song', now(), now())`,
        [community, post, actor],
      );
      expect(
        await run(connection, (store) =>
          store.publish({
            ...command("/media-post-submissions/:submissionId/publish", "publish-key"),
            expectedCreationRevision: 2,
            expectedAudioRevision: 1,
            expectedAnalysisRevision: 1,
            expectedDecisionRevision: 1,
            postId: post,
            outbox: {
              outboxEventId: "media_pg_publication_outbox",
              effectIdentity: "media_pg_publication_effect",
              payload: { post_id: post },
            },
          }),
        ),
      ).toMatchObject({ kind: "committed", postId: post });

      const counts = await admin.query<{
        events: string;
        effects: string;
        publications: string;
        replay: string;
      }>({
        text: `SELECT
          (SELECT count(*)::text FROM media_submission_events WHERE submission_id = $1) AS events,
          (SELECT count(*)::text FROM media_submission_outbox WHERE submission_id = $1) AS effects,
          (SELECT count(*)::text FROM media_publication_projections WHERE submission_id = $1) AS publications,
          (SELECT count(*)::text FROM media_submission_command_replays
            WHERE submission_id = $1 AND idempotency_key = 'finalize-key') AS replay`,
        values: [submission],
      });
      expect(counts.rows[0]).toEqual({
        events: "6",
        effects: "2",
        publications: "1",
        replay: "1",
      });
    });
    completedTestCount += 1;
  }, 40_000);

  test("rolls back sealed facts that do not match the reservation", async () => {
    await withSchema(async (admin, connection) => {
      const badReservation = "media_pg_bad_reservation";
      const badSubmission = "media_pg_bad_submission";
      await run(connection, (store) =>
        store.reserve({
          communityId: community,
          actorUserId: actor,
          idempotencyKey: "bad-reserve-key",
          requestHash,
          expectedContentType: "audio/mpeg",
          expectedSizeBytes: 10,
          expectedSha256: audioSha256,
          uploadUrl: "https://upload.test/bad",
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          responseBytes,
          responseSha256,
          reservationId: badReservation,
        }),
      );
      await run(connection, (store) =>
        store.createSubmission({
          communityId: community,
          actorUserId: actor,
          idempotencyKey: "bad-create-key",
          requestHash,
          title: "Bad fixture",
          songType: "original",
          reservationId: badReservation,
          submissionId: badSubmission,
          operationId: "media_pg_bad_operation",
          responseBytes,
          responseSha256,
        }),
      );
      const failed = await run(connection, (store) =>
        store
          .finalizeSealed({
            communityId: community,
            submissionId: badSubmission,
            actorUserId: actor,
            endpointTemplate: "/media-post-submissions/:submissionId/finalize",
            idempotencyKey: "bad-finalize-key",
            requestHash,
            responseBytes,
            responseSha256,
            expectedCreationRevision: 1,
            expectedAudioRevision: 0,
            reservationId: badReservation,
            immutableObject: {
              immutableRef: "media_pg_bad_immutable",
              destinationRef: "media://immutable/bad",
              etag: "bad-etag",
              objectVersion: "bad-version",
              sizeBytes: 1,
              contentType: "audio/mpeg",
              canonicalSha256: audioSha256,
            },
            outbox: {
              outboxEventId: "media_pg_bad_outbox",
              effectIdentity: "media_pg_bad_effect",
              payload: {},
            },
          })
          .pipe(Effect.flip),
      );
      expect(failed).toHaveProperty("_tag", "ControlPlaneStatementFailed");
      const rolledBack = await admin.query<{
        objects: string;
        state: string;
        audio_revision: string;
      }>({
        text: `SELECT
          (SELECT count(*)::text FROM media_immutable_objects
            WHERE immutable_ref = 'media_pg_bad_immutable') AS objects,
          (SELECT state FROM media_upload_reservations WHERE reservation_id = $1) AS state,
          (SELECT audio_revision::text FROM media_post_submissions WHERE submission_id = $2) AS audio_revision`,
        values: [badReservation, badSubmission],
      });
      expect(rolledBack.rows[0]).toEqual({ objects: "0", state: "claimed", audio_revision: "0" });
    });
    completedTestCount += 1;
  }, 40_000);

  test("reclaims an expired outbox lease and rejects the stale worker fence", async () => {
    await withSchema(async (admin, connection) => {
      await createThroughDecision(connection);
      try {
        await admin.query(
          `UPDATE media_submission_outbox
              SET state = 'delivered', delivered_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            WHERE outbox_event_id = 'media_pg_analysis_outbox'`,
        );
        throw new Error(
          "expected the outbox transition trigger to reject delivery without a claim",
        );
      } catch (error) {
        expect(error).toMatchObject({ code: "P0001" });
      }
      const claims = await Promise.all([
        run(connection, (_, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "worker_a",
            leaseSeconds: 1,
          }),
        ),
        run(connection, (_, outbox) =>
          outbox.claim({
            outboxEventId: "media_pg_analysis_outbox",
            workflowRevision: 1,
            workerId: "worker_b",
            leaseSeconds: 1,
          }),
        ),
      ]);
      const first = claims.find((claim) => claim !== null);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(first).toMatchObject({ state: "claimed", claimFence: 1, deliveryAttempts: 1 });
      await admin.query("SELECT pg_sleep(1.1)");
      const reclaimed = await run(connection, (_, outbox) =>
        outbox.claim({
          outboxEventId: "media_pg_analysis_outbox",
          workflowRevision: 1,
          workerId: "worker_recovery",
          leaseSeconds: 30,
        }),
      );
      expect(reclaimed).toMatchObject({
        state: "claimed",
        claimOwner: "worker_recovery",
        claimFence: 2,
        deliveryAttempts: 2,
      });
      expect(first).not.toBeNull();
      if (first === null || first === undefined || reclaimed === null)
        throw new Error("claim fixture failed");
      expect(
        await run(connection, (_, outbox) =>
          outbox.markDelivered({
            outboxEventId: first.outboxEventId,
            workflowRevision: first.workflowRevision,
            workflowInstanceId: first.workflowInstanceId,
            workerId: first.claimOwner as string,
            claimFence: first.claimFence,
          }),
        ),
      ).toBe(false);
      expect(
        await run(connection, (_, outbox) =>
          outbox.markDelivered({
            outboxEventId: reclaimed.outboxEventId,
            workflowRevision: reclaimed.workflowRevision,
            workflowInstanceId: reclaimed.workflowInstanceId,
            workerId: reclaimed.claimOwner as string,
            claimFence: reclaimed.claimFence,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (_, outbox) => outbox.get("media_pg_analysis_outbox")),
      ).toMatchObject({ state: "delivered", claimFence: 2, deliveryAttempts: 2 });
    });
    completedTestCount += 1;
  }, 40_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === testCount)
      await Bun.write(sentinelPath, sentinelContents);
  });
});
